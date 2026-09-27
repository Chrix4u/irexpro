"""USDJPY v22 research: rank-calibrated direct net-return policy.

Absolute direct-net predictions drift across refits. v22 selects a bounded
prediction percentile and side actionability threshold strictly on inner
chronological data, then recomputes the chosen percentile cutoff on the refit
calibration window before untouched outer validation. No outer/future values
set the cutoff. The sealed future holdout remains untouched.
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
    _regression_model_for_variant,
)
from app.domain.training.single_pair_v11_calibrated_gating import _fit_models
from app.domain.training.single_pair_v16_two_sided_economic import (
    MAX_FOLD_TRADE_CONCENTRATION,
    MIN_OUTER_TRADES,
    MIN_PER_FOLD_TRADES,
    SIDE_THRESHOLD_GRID,
    _fit_side_calibrators,
    _score_frame,
    _trading_metrics,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v22_rank_calibrated_direct_net"
DIRECT_NET_QUANTILES = (0.95, 0.98, 0.99)
MIN_SIDE_SELECTION_TRADES = 10
MIN_SIDE_SELECTION_PROFIT_FACTOR = 1.15


def _fit_direct_models(
    fit: pd.DataFrame,
    early_stop: pd.DataFrame,
    *,
    feature_columns: list[str],
    variant_name: str,
) -> dict[str, Any]:
    models: dict[str, Any] = {}
    for side, target_col in (
        ("long", EVENT_LONG_NET_RETURN_COLUMN),
        ("short", EVENT_SHORT_NET_RETURN_COLUMN),
    ):
        model = _regression_model_for_variant(
            ModelVariant(name=f"{variant_name}_{side}_direct_net")
        )
        y_fit = pd.to_numeric(fit[target_col], errors="raise").to_numpy(float) * 10_000.0
        y_early = (
            pd.to_numeric(early_stop[target_col], errors="raise").to_numpy(float)
            * 10_000.0
        )
        model.fit(
            fit[feature_columns],
            y_fit,
            eval_set=[(early_stop[feature_columns], y_early)],
            verbose=False,
        )
        models[side] = model
    return models


def _score(
    base_models: Any,
    direct_models: dict[str, Any],
    frame: pd.DataFrame,
    *,
    calibrators: dict[str, Any],
) -> pd.DataFrame:
    scored = _score_frame(base_models, frame, calibrators=calibrators)
    features = base_models.feature_columns
    scored["long_direct_net_bps"] = np.asarray(
        direct_models["long"].predict(frame[features]), dtype=float
    )
    scored["short_direct_net_bps"] = np.asarray(
        direct_models["short"].predict(frame[features]), dtype=float
    )
    return scored


def _profit_factor(returns: np.ndarray) -> float | None:
    gains = float(returns[returns > 0.0].sum())
    losses = float(-returns[returns < 0.0].sum())
    if losses > 0.0:
        return gains / losses
    if gains > 0.0:
        return float("inf")
    return None


def select_rank_policy(scored: pd.DataFrame, *, side: str) -> dict[str, Any]:
    if side not in {"long", "short"}:
        raise ValueError("side must be long or short")
    probability_col = f"{side}_action_probability"
    direct_col = f"{side}_direct_net_bps"
    return_col = (
        EVENT_LONG_NET_RETURN_COLUMN
        if side == "long"
        else EVENT_SHORT_NET_RETURN_COLUMN
    )
    values = pd.to_numeric(scored[direct_col], errors="raise").to_numpy(float)
    candidates: list[dict[str, Any]] = []

    for probability_threshold in SIDE_THRESHOLD_GRID:
        for quantile in DIRECT_NET_QUANTILES:
            cutoff = float(np.quantile(values, quantile))
            mask = (
                (scored[probability_col] >= probability_threshold)
                & (scored[direct_col] >= cutoff)
            )
            returns = pd.to_numeric(
                scored.loc[mask, return_col], errors="raise"
            ).to_numpy(float)
            pf = _profit_factor(returns)
            total = float(returns.sum()) if len(returns) else 0.0
            eligible = (
                len(returns) >= MIN_SIDE_SELECTION_TRADES
                and pf is not None
                and pf >= MIN_SIDE_SELECTION_PROFIT_FACTOR
                and total > 0.0
            )
            candidates.append(
                {
                    "side": side,
                    "probability_threshold": float(probability_threshold),
                    "direct_net_quantile": float(quantile),
                    "selection_cutoff_bps": cutoff,
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
            )

    eligible_rows = [row for row in candidates if row["eligible"]]
    if not eligible_rows:
        return {
            "enabled": False,
            "side": side,
            "reason": "no_inner_rank_policy_met_economic_evidence",
            "candidates": candidates,
        }
    selected = max(
        eligible_rows,
        key=lambda row: (
            row["trade_count"],
            row["profit_factor"] or 0.0,
            row["total_return"],
            row["win_rate"],
            row["direct_net_quantile"],
        ),
    )
    return {
        "enabled": True,
        "side": side,
        "reason": "inner_only_rank_calibrated_economic_selection",
        **selected,
        "candidates": candidates,
    }


def calibrate_outer_rank_policy(
    calibration_scored: pd.DataFrame,
    *,
    selected_policy: dict[str, Any],
) -> dict[str, Any]:
    if not selected_policy.get("enabled"):
        return dict(selected_policy)
    side = str(selected_policy["side"])
    direct_col = f"{side}_direct_net_bps"
    values = pd.to_numeric(
        calibration_scored[direct_col], errors="raise"
    ).to_numpy(float)
    quantile = float(selected_policy["direct_net_quantile"])
    cutoff = float(np.quantile(values, quantile))
    scale = float(np.std(values))
    if not np.isfinite(scale) or scale <= 1e-9:
        scale = 1.0
    return {
        **selected_policy,
        "outer_calibration_cutoff_bps": cutoff,
        "outer_calibration_scale_bps": scale,
    }


def apply_rank_policy(
    scored: pd.DataFrame,
    *,
    long_policy: dict[str, Any],
    short_policy: dict[str, Any],
) -> pd.DataFrame:
    result = scored.copy()
    long_pass = pd.Series(False, index=result.index)
    short_pass = pd.Series(False, index=result.index)
    long_score = pd.Series(-np.inf, index=result.index, dtype=float)
    short_score = pd.Series(-np.inf, index=result.index, dtype=float)

    if long_policy.get("enabled"):
        cutoff = float(long_policy["outer_calibration_cutoff_bps"])
        scale = float(long_policy["outer_calibration_scale_bps"])
        long_pass = (
            result["long_action_probability"]
            >= float(long_policy["probability_threshold"])
        ) & (result["long_direct_net_bps"] >= cutoff)
        long_score = (result["long_direct_net_bps"] - cutoff) / scale

    if short_policy.get("enabled"):
        cutoff = float(short_policy["outer_calibration_cutoff_bps"])
        scale = float(short_policy["outer_calibration_scale_bps"])
        short_pass = (
            result["short_action_probability"]
            >= float(short_policy["probability_threshold"])
        ) & (result["short_direct_net_bps"] >= cutoff)
        short_score = (result["short_direct_net_bps"] - cutoff) / scale

    choose_long = long_pass & (~short_pass | (long_score >= short_score))
    choose_short = short_pass & ~choose_long
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


def _fold_report(
    scored: pd.DataFrame,
    *,
    long_policy: dict[str, Any],
    short_policy: dict[str, Any],
) -> dict[str, Any]:
    gated = apply_rank_policy(
        scored,
        long_policy=long_policy,
        short_policy=short_policy,
    )
    active = gated.loc[gated["active_trade"]].copy()
    return {
        "trading": _trading_metrics(active),
        "active_trade_records": [
            {
                "decision_time": str(row.decision_time),
                "predicted_long": bool(row.predicted_long),
                "selected_net_return": float(row.selected_net_return),
            }
            for row in active.itertuples(index=False)
        ],
    }


def evaluate_v22(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    max_splits: int = 3,
) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = int(unique_periods * 0.94)
    validation = int(unique_periods * 0.02)
    variant = ModelVariant(name="event_barrier_v22_rank_calibrated_direct_net")

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
        inner_base = _fit_models(nested.fit, nested.early_stop, variant=variant)
        inner_direct = _fit_direct_models(
            nested.fit,
            nested.early_stop,
            feature_columns=inner_base.feature_columns,
            variant_name=variant.name,
        )
        inner_calibrators = _fit_side_calibrators(
            inner_base, nested.calibration
        )
        selection_labeled = _ensure_event_dual_actionability_targets(
            nested.selection
        )
        selection_scored = _score(
            inner_base,
            inner_direct,
            selection_labeled,
            calibrators=inner_calibrators,
        )
        selected_long = select_rank_policy(selection_scored, side="long")
        selected_short = select_rank_policy(selection_scored, side="short")

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_base = _fit_models(refit.fit, refit.early_stop, variant=variant)
        outer_direct = _fit_direct_models(
            refit.fit,
            refit.early_stop,
            feature_columns=outer_base.feature_columns,
            variant_name=variant.name,
        )
        outer_calibrators = _fit_side_calibrators(
            outer_base, refit.calibration
        )
        calibration_scored = _score(
            outer_base,
            outer_direct,
            _ensure_event_dual_actionability_targets(refit.calibration),
            calibrators=outer_calibrators,
        )
        long_policy = calibrate_outer_rank_policy(
            calibration_scored, selected_policy=selected_long
        )
        short_policy = calibrate_outer_rank_policy(
            calibration_scored, selected_policy=selected_short
        )
        outer_scored = _score(
            outer_base,
            outer_direct,
            _ensure_event_dual_actionability_targets(outer_validation),
            calibrators=outer_calibrators,
        )
        fold = _fold_report(
            outer_scored,
            long_policy=long_policy,
            short_policy=short_policy,
        )
        fold["fold"] = fold_index
        fold["inner_long_policy"] = selected_long
        fold["inner_short_policy"] = selected_short
        fold["outer_long_policy"] = long_policy
        fold["outer_short_policy"] = short_policy
        folds.append(fold)

        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "long_enabled": long_policy.get("enabled"),
                    "short_enabled": short_policy.get("enabled"),
                    "long_quantile": long_policy.get("direct_net_quantile"),
                    "short_quantile": short_policy.get("direct_net_quantile"),
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
            "rank_calibrated_direct_net": True,
            "rank_quantiles": list(DIRECT_NET_QUANTILES),
            "minimum_inner_side_profit_factor": MIN_SIDE_SELECTION_PROFIT_FACTOR,
            "outer_cutoff_from_refit_calibration_only": True,
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
    parser.add_argument("--max-splits", type=int, default=3)
    args = parser.parse_args()
    report = evaluate_v22(
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
