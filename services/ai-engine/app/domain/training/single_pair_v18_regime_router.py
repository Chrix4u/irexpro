"""USDJPY v18 research: causal side-regime router over calibrated actionability models.

All pre-boundary history is treated as development data. Within each outer
training window, LONG/SHORT eligibility is learned only from inner chronological
selection evidence in causal trend/volatility regimes. The sealed future holdout
is not consumed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import (
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    ModelVariant,
    _ensure_event_dual_actionability_targets,
    _nested_windows,
    _refit_windows,
)
from app.domain.training.single_pair_v11_calibrated_gating import _fit_models
from app.domain.training.single_pair_v16_two_sided_economic import (
    MAX_FOLD_TRADE_CONCENTRATION,
    MIN_OUTER_TRADES,
    MIN_PER_FOLD_TRADES,
    PAYOFF_RATIO_FLOOR,
    SIDE_THRESHOLD_GRID,
    _fit_side_calibrators,
    _score_frame,
    _trading_metrics,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v18_causal_side_regime_router"
MIN_REGIME_SELECTION_TRADES = 8
MIN_REGIME_SELECTION_PROFIT_FACTOR = 1.15
TREND_FEATURE = "trend_alignment_score"
VOLATILITY_FEATURE = "m1_volatility_20"


def _score_with_regime_features(
    models: Any,
    frame: pd.DataFrame,
    *,
    calibrators: dict[str, Any],
) -> pd.DataFrame:
    required = {TREND_FEATURE, VOLATILITY_FEATURE}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"v18 regime router missing causal features: {missing}")
    scored = _score_frame(models, frame, calibrators=calibrators)
    scored[TREND_FEATURE] = pd.to_numeric(frame[TREND_FEATURE], errors="raise").to_numpy()
    scored[VOLATILITY_FEATURE] = pd.to_numeric(
        frame[VOLATILITY_FEATURE], errors="raise"
    ).to_numpy()
    return scored


def _profit_factor(returns: np.ndarray) -> float | None:
    gains = float(returns[returns > 0.0].sum())
    losses = float(-returns[returns < 0.0].sum())
    if losses > 0.0:
        return gains / losses
    if gains > 0.0:
        return float("inf")
    return None


def _regime_boundaries(scored: pd.DataFrame) -> dict[str, float]:
    trend = pd.to_numeric(scored[TREND_FEATURE], errors="raise")
    vol = pd.to_numeric(scored[VOLATILITY_FEATURE], errors="raise")
    return {
        "trend_q33": float(trend.quantile(0.33)),
        "trend_q67": float(trend.quantile(0.67)),
        "vol_q50": float(vol.quantile(0.50)),
    }


def _regime_ids(
    scored: pd.DataFrame,
    *,
    boundaries: dict[str, float],
) -> pd.Series:
    trend = pd.to_numeric(scored[TREND_FEATURE], errors="raise")
    vol = pd.to_numeric(scored[VOLATILITY_FEATURE], errors="raise")
    trend_bucket = np.where(
        trend <= boundaries["trend_q33"],
        "trend_low",
        np.where(trend >= boundaries["trend_q67"], "trend_high", "trend_mid"),
    )
    vol_bucket = np.where(vol >= boundaries["vol_q50"], "vol_high", "vol_low")
    return pd.Series(
        [f"{t}__{v}" for t, v in zip(trend_bucket, vol_bucket)],
        index=scored.index,
        dtype="object",
    )


def select_regime_router(scored: pd.DataFrame) -> dict[str, Any]:
    """Select per-regime side thresholds from inner chronological evidence only."""
    boundaries = _regime_boundaries(scored)
    regime_id = _regime_ids(scored, boundaries=boundaries)
    rules: dict[str, dict[str, Any]] = {}
    candidates: list[dict[str, Any]] = []

    side_specs = {
        "long": (
            "long_action_probability",
            "long_expected_net_bps",
            "long_payoff_ratio",
            EVENT_LONG_NET_RETURN_COLUMN,
        ),
        "short": (
            "short_action_probability",
            "short_expected_net_bps",
            "short_payoff_ratio",
            EVENT_SHORT_NET_RETURN_COLUMN,
        ),
    }

    for regime in sorted(regime_id.unique()):
        in_regime = regime_id == regime
        rules[regime] = {}
        for side, (prob_col, net_col, ratio_col, return_col) in side_specs.items():
            side_candidates: list[dict[str, Any]] = []
            for threshold in SIDE_THRESHOLD_GRID:
                mask = (
                    in_regime
                    & (scored[prob_col] >= threshold)
                    & (scored[net_col] > 0.0)
                    & (scored[ratio_col] >= PAYOFF_RATIO_FLOOR)
                )
                returns = pd.to_numeric(
                    scored.loc[mask, return_col], errors="raise"
                ).to_numpy(float)
                pf = _profit_factor(returns)
                total = float(returns.sum()) if len(returns) else 0.0
                eligible = (
                    len(returns) >= MIN_REGIME_SELECTION_TRADES
                    and pf is not None
                    and pf >= MIN_REGIME_SELECTION_PROFIT_FACTOR
                    and total > 0.0
                )
                row = {
                    "regime": regime,
                    "side": side,
                    "threshold": float(threshold),
                    "trade_count": int(len(returns)),
                    "profit_factor": (
                        None if pf is None or not np.isfinite(pf) else float(pf)
                    ),
                    "profit_factor_infinite": bool(
                        pf is not None and not np.isfinite(pf)
                    ),
                    "total_return": total,
                    "win_rate": (
                        float((returns > 0.0).mean()) if len(returns) else 0.0
                    ),
                    "eligible": bool(eligible),
                }
                candidates.append(row)
                side_candidates.append(row)

            eligible_rows = [row for row in side_candidates if row["eligible"]]
            if eligible_rows:
                selected = max(
                    eligible_rows,
                    key=lambda row: (
                        row["trade_count"],
                        row["profit_factor"] or 0.0,
                        row["total_return"],
                        row["win_rate"],
                        row["threshold"],
                    ),
                )
                rules[regime][side] = {
                    "enabled": True,
                    "threshold": float(selected["threshold"]),
                    "trade_count": int(selected["trade_count"]),
                    "profit_factor": selected["profit_factor"],
                    "profit_factor_infinite": selected["profit_factor_infinite"],
                    "total_return": float(selected["total_return"]),
                }
            else:
                rules[regime][side] = {
                    "enabled": False,
                    "reason": "no_inner_regime_candidate_met_economic_evidence",
                }

    enabled_long = sum(
        int(rule.get("long", {}).get("enabled", False)) for rule in rules.values()
    )
    enabled_short = sum(
        int(rule.get("short", {}).get("enabled", False)) for rule in rules.values()
    )
    return {
        "boundaries": boundaries,
        "rules": rules,
        "enabled_long_regimes": enabled_long,
        "enabled_short_regimes": enabled_short,
        "candidates": candidates,
    }


def apply_regime_router(
    scored: pd.DataFrame,
    *,
    router: dict[str, Any],
) -> pd.DataFrame:
    result = scored.copy()
    regime_id = _regime_ids(result, boundaries=router["boundaries"])
    long_pass = pd.Series(False, index=result.index)
    short_pass = pd.Series(False, index=result.index)

    for regime, side_rules in router["rules"].items():
        regime_mask = regime_id == regime
        long_rule = side_rules["long"]
        if long_rule.get("enabled"):
            long_pass |= (
                regime_mask
                & (result["long_action_probability"] >= float(long_rule["threshold"]))
                & (result["long_expected_net_bps"] > 0.0)
                & (result["long_payoff_ratio"] >= PAYOFF_RATIO_FLOOR)
            )
        short_rule = side_rules["short"]
        if short_rule.get("enabled"):
            short_pass |= (
                regime_mask
                & (result["short_action_probability"] >= float(short_rule["threshold"]))
                & (result["short_expected_net_bps"] > 0.0)
                & (result["short_payoff_ratio"] >= PAYOFF_RATIO_FLOOR)
            )

    long_strength = result["long_action_probability"]
    short_strength = result["short_action_probability"]
    choose_long = long_pass & (~short_pass | (long_strength >= short_strength))
    choose_short = short_pass & ~choose_long

    result["regime_id"] = regime_id
    result["long_gate_pass"] = long_pass
    result["short_gate_pass"] = short_pass
    result["active_trade"] = choose_long | choose_short
    result["predicted_long"] = choose_long
    result["selected_net_return"] = np.where(
        choose_long,
        result[EVENT_LONG_NET_RETURN_COLUMN],
        np.where(choose_short, result[EVENT_SHORT_NET_RETURN_COLUMN], 0.0),
    )
    return result


def _fold_report(scored: pd.DataFrame, *, router: dict[str, Any]) -> dict[str, Any]:
    gated = apply_regime_router(scored, router=router)
    active = gated.loc[gated["active_trade"]].copy()
    return {
        "router": {
            "boundaries": router["boundaries"],
            "enabled_long_regimes": router["enabled_long_regimes"],
            "enabled_short_regimes": router["enabled_short_regimes"],
            "rules": router["rules"],
        },
        "trading": _trading_metrics(active),
        "active_trade_records": [
            {
                "decision_time": str(row.decision_time),
                "predicted_long": bool(row.predicted_long),
                "selected_net_return": float(row.selected_net_return),
                "regime_id": str(row.regime_id),
            }
            for row in active.itertuples(index=False)
        ],
    }


def evaluate_v18(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    max_splits: int = 5,
) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = int(unique_periods * 0.40)
    validation = int(unique_periods * 0.10)
    variant = ModelVariant(name="event_barrier_v18_causal_side_regime_router")

    folds: list[dict[str, Any]] = []
    for fold_index, (outer_train, outer_validation) in enumerate(
        iter_purged_walk_forward_time_splits(
            pooled,
            time_column="decision_time",
            min_train_periods=min_train,
            validation_periods=validation,
            purge_periods=horizon_bars,
            embargo_periods=horizon_bars,
            max_splits=max_splits,
        ),
        start=1,
    ):
        nested = _nested_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        inner_models = _fit_models(
            nested.fit,
            nested.early_stop,
            variant=variant,
        )
        inner_calibrators = _fit_side_calibrators(
            inner_models,
            nested.calibration,
        )
        selection_labeled = _ensure_event_dual_actionability_targets(
            nested.selection
        )
        selection_scored = _score_with_regime_features(
            inner_models,
            selection_labeled,
            calibrators=inner_calibrators,
        )
        router = select_regime_router(selection_scored)

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(
            refit.fit,
            refit.early_stop,
            variant=variant,
        )
        outer_calibrators = _fit_side_calibrators(
            outer_models,
            refit.calibration,
        )
        outer_scored = _score_with_regime_features(
            outer_models,
            outer_validation,
            calibrators=outer_calibrators,
        )
        fold = _fold_report(outer_scored, router=router)
        fold["fold"] = fold_index
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        folds.append(fold)
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "long_regimes": router["enabled_long_regimes"],
                    "short_regimes": router["enabled_short_regimes"],
                    "trades": fold["trading"]["trade_count"],
                    "long": fold["trading"]["long_trades"],
                    "short": fold["trading"]["short_trades"],
                    "total_return": fold["trading"]["total_return"],
                },
                sort_keys=True,
            ),
            flush=True,
        )

    records = [
        record for fold in folds for record in fold["active_trade_records"]
    ]
    if records:
        active = pd.DataFrame(records)
        active["decision_time"] = pd.to_datetime(
            active["decision_time"], utc=True, errors="raise"
        )
        aggregate_trading = _trading_metrics(active)
    else:
        aggregate_trading = _trading_metrics(pd.DataFrame())

    trade_counts = [int(fold["trading"]["trade_count"]) for fold in folds]
    total_trades = int(aggregate_trading["trade_count"])
    long_trades = int(aggregate_trading.get("long_trades", 0))
    short_trades = int(aggregate_trading.get("short_trades", 0))
    max_concentration = (
        max(trade_counts) / total_trades
        if total_trades > 0 and trade_counts
        else 0.0
    )
    positive_folds = sum(
        float(fold["trading"]["total_return"]) > 0.0 for fold in folds
    )
    profit_factor = aggregate_trading.get("profit_factor")
    robustness_gate = {
        "minimum_trade_evidence": total_trades >= MIN_OUTER_TRADES,
        "minimum_each_fold_trade_evidence": bool(trade_counts)
        and min(trade_counts) >= MIN_PER_FOLD_TRADES,
        "fold_concentration_lte_0_80": (
            max_concentration <= MAX_FOLD_TRADE_CONCENTRATION
        ),
        "two_sided_execution": long_trades > 0 and short_trades > 0,
        "positive_fold_fraction_gte_0_60": (
            positive_folds / len(folds) >= 0.60 if folds else False
        ),
        "aggregate_profit_factor_gte_1_15": (
            profit_factor is not None and float(profit_factor) >= 1.15
        ),
        "aggregate_sharpe_gte_1_0": (
            aggregate_trading.get("sharpe_ratio") is not None
            and float(aggregate_trading["sharpe_ratio"]) >= 1.0
        ),
        "aggregate_max_drawdown_lte_0_12": (
            float(aggregate_trading.get("max_drawdown", 1.0)) <= 0.12
        ),
    }
    robustness_gate["research_robustness_passed"] = all(
        bool(value) for value in robustness_gate.values()
    )

    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "protocol": {
            "all_preboundary_history_is_development_only": True,
            "outer_min_train_fraction": 0.40,
            "outer_validation_fraction": 0.10,
            "causal_regime_features": [TREND_FEATURE, VOLATILITY_FEATURE],
            "side_regime_selection_inner_only": True,
            "side_specific_calibration": True,
            "payoff_ratio_floor": PAYOFF_RATIO_FLOOR,
            "sealed_future_holdout_untouched": True,
        },
        "dataset_sha256": hashes,
        "folds": folds,
        "aggregate": {
            "trading": aggregate_trading,
            "fold_trade_counts": trade_counts,
            "max_fold_trade_fraction": max_concentration,
            "positive_fold_fraction": (
                positive_folds / len(folds) if folds else 0.0
            ),
        },
        "robustness_gate": robustness_gate,
    }


def _parse_dataset(value: str) -> dict[str, str]:
    instrument, sep, path = value.partition("=")
    if not sep:
        raise ValueError("--dataset must use INSTRUMENT=/path.csv")
    return {instrument.strip().upper(): path.strip()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--horizon-bars", type=int, default=1)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-splits", type=int, default=5)
    args = parser.parse_args()

    report = evaluate_v18(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        max_splits=args.max_splits,
    )
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    print(json.dumps(report["aggregate"], sort_keys=True))
    print(json.dumps(report["robustness_gate"], sort_keys=True))


if __name__ == "__main__":
    main()
