"""USDJPY v21 research: direct net-return economic models.

This candidate keeps side-specific calibrated actionability but replaces the
unstable upside-minus-downside payoff ratio as the primary economic model with
one direct after-friction net-return regressor per side. Side execution policies
are selected only from inner chronological evidence and must meet PF >= 1.15.
The sealed future holdout is untouched.
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

EXPERIMENT_NAME = "event_barrier_v21_direct_net_economic"
DIRECT_NET_FLOOR_GRID = (0.0, 0.25, 0.50, 1.00)
MIN_SIDE_SELECTION_TRADES = 10
MIN_SIDE_SELECTION_PROFIT_FACTOR = 1.15


def _fit_direct_net_models(
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
        fit_target = (
            pd.to_numeric(fit[target_col], errors="raise").to_numpy(float) * 10_000.0
        )
        early_target = (
            pd.to_numeric(early_stop[target_col], errors="raise").to_numpy(float)
            * 10_000.0
        )
        model.fit(
            fit[feature_columns],
            fit_target,
            eval_set=[(early_stop[feature_columns], early_target)],
            verbose=False,
        )
        models[side] = model
    return models


def _score_with_direct_net(
    base_models: Any,
    direct_models: dict[str, Any],
    frame: pd.DataFrame,
    *,
    calibrators: dict[str, Any],
) -> pd.DataFrame:
    scored = _score_frame(
        base_models,
        frame,
        calibrators=calibrators,
    )
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


def select_direct_net_side_policy(
    scored: pd.DataFrame,
    *,
    side: str,
) -> dict[str, Any]:
    if side not in {"long", "short"}:
        raise ValueError("side must be long or short")
    probability_col = f"{side}_action_probability"
    direct_col = f"{side}_direct_net_bps"
    return_col = (
        EVENT_LONG_NET_RETURN_COLUMN
        if side == "long"
        else EVENT_SHORT_NET_RETURN_COLUMN
    )
    candidates: list[dict[str, Any]] = []
    for probability_threshold in SIDE_THRESHOLD_GRID:
        for direct_net_floor in DIRECT_NET_FLOOR_GRID:
            mask = (
                (scored[probability_col] >= probability_threshold)
                & (scored[direct_col] >= direct_net_floor)
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
                    "direct_net_floor_bps": float(direct_net_floor),
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
            "reason": "no_inner_direct_net_policy_met_economic_evidence",
            "candidates": candidates,
        }
    selected = max(
        eligible_rows,
        key=lambda row: (
            row["trade_count"],
            row["profit_factor"] or 0.0,
            row["total_return"],
            row["win_rate"],
            row["direct_net_floor_bps"],
            row["probability_threshold"],
        ),
    )
    return {
        "enabled": True,
        "side": side,
        "reason": "inner_only_direct_net_economic_selection",
        **selected,
        "candidates": candidates,
    }


def apply_direct_net_policy(
    scored: pd.DataFrame,
    *,
    long_policy: dict[str, Any],
    short_policy: dict[str, Any],
) -> pd.DataFrame:
    result = scored.copy()
    long_pass = pd.Series(False, index=result.index)
    short_pass = pd.Series(False, index=result.index)

    if long_policy.get("enabled"):
        long_pass = (
            (
                result["long_action_probability"]
                >= float(long_policy["probability_threshold"])
            )
            & (
                result["long_direct_net_bps"]
                >= float(long_policy["direct_net_floor_bps"])
            )
        )
    if short_policy.get("enabled"):
        short_pass = (
            (
                result["short_action_probability"]
                >= float(short_policy["probability_threshold"])
            )
            & (
                result["short_direct_net_bps"]
                >= float(short_policy["direct_net_floor_bps"])
            )
        )

    choose_long = long_pass & (
        ~short_pass
        | (result["long_direct_net_bps"] >= result["short_direct_net_bps"])
    )
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
    gated = apply_direct_net_policy(
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
                "direct_net_bps": float(
                    row.long_direct_net_bps
                    if row.predicted_long
                    else row.short_direct_net_bps
                ),
            }
            for row in active.itertuples(index=False)
        ],
    }


def evaluate_v21(
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
    variant = ModelVariant(name="event_barrier_v21_direct_net_economic")

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
        inner_base = _fit_models(
            nested.fit,
            nested.early_stop,
            variant=variant,
        )
        inner_direct = _fit_direct_net_models(
            nested.fit,
            nested.early_stop,
            feature_columns=inner_base.feature_columns,
            variant_name=variant.name,
        )
        inner_calibrators = _fit_side_calibrators(
            inner_base,
            nested.calibration,
        )
        selection_labeled = _ensure_event_dual_actionability_targets(
            nested.selection
        )
        selection_scored = _score_with_direct_net(
            inner_base,
            inner_direct,
            selection_labeled,
            calibrators=inner_calibrators,
        )
        long_policy = select_direct_net_side_policy(
            selection_scored, side="long"
        )
        short_policy = select_direct_net_side_policy(
            selection_scored, side="short"
        )

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_base = _fit_models(
            refit.fit,
            refit.early_stop,
            variant=variant,
        )
        outer_direct = _fit_direct_net_models(
            refit.fit,
            refit.early_stop,
            feature_columns=outer_base.feature_columns,
            variant_name=variant.name,
        )
        outer_calibrators = _fit_side_calibrators(
            outer_base,
            refit.calibration,
        )
        outer_scored = _score_with_direct_net(
            outer_base,
            outer_direct,
            outer_validation,
            calibrators=outer_calibrators,
        )
        fold = _fold_report(
            outer_scored,
            long_policy=long_policy,
            short_policy=short_policy,
        )
        fold["fold"] = fold_index
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        fold["inner_long_policy"] = long_policy
        fold["inner_short_policy"] = short_policy
        folds.append(fold)

        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "long_enabled": long_policy.get("enabled"),
                    "short_enabled": short_policy.get("enabled"),
                    "long_probability_threshold": long_policy.get(
                        "probability_threshold"
                    ),
                    "short_probability_threshold": short_policy.get(
                        "probability_threshold"
                    ),
                    "long_direct_floor": long_policy.get("direct_net_floor_bps"),
                    "short_direct_floor": short_policy.get("direct_net_floor_bps"),
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
            "direct_net_return_models": True,
            "side_policy_selection_inner_only": True,
            "minimum_inner_side_profit_factor": MIN_SIDE_SELECTION_PROFIT_FACTOR,
            "direct_net_floor_grid_bps": list(DIRECT_NET_FLOOR_GRID),
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
    report = evaluate_v21(
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
