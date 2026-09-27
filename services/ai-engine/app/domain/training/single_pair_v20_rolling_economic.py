"""USDJPY v20 research: rolling recent training plus inner economic side selection."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd

from app.domain.training.model_qualification import (
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
    _fit_side_calibrators,
    _fold_report,
    _score_frame,
    _trading_metrics,
    select_long_regime_policy,
    select_short_regime_policy,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v20_rolling_window_economic_sides"
ROLLING_TRAIN_FRACTION = 0.20
OUTER_MIN_TRAIN_FRACTION = 0.40
OUTER_VALIDATION_FRACTION = 0.10


def _trim_recent(frame: pd.DataFrame, periods: int) -> pd.DataFrame:
    times = (
        pd.to_datetime(frame["decision_time"], utc=True, errors="raise")
        .drop_duplicates()
        .sort_values()
    )
    if len(times) <= periods:
        return frame.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    cutoff = times.iloc[-periods]
    mask = pd.to_datetime(frame["decision_time"], utc=True, errors="raise") >= cutoff
    return (
        frame.loc[mask]
        .sort_values(["decision_time", "instrument"])
        .reset_index(drop=True)
    )


def evaluate_v20(
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
    min_train = int(unique_periods * OUTER_MIN_TRAIN_FRACTION)
    validation = int(unique_periods * OUTER_VALIDATION_FRACTION)
    rolling_periods = max(250, int(unique_periods * ROLLING_TRAIN_FRACTION))
    variant = ModelVariant(name="event_barrier_v20_rolling_window_economic_sides")

    folds: list[dict[str, Any]] = []
    for fold_index, (expanding_train, outer_validation) in enumerate(
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
        outer_train = _trim_recent(expanding_train, rolling_periods)

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
        selection_scored = _score_frame(
            inner_models,
            selection_labeled,
            calibrators=inner_calibrators,
        )
        long_choice = select_long_regime_policy(selection_scored)
        short_choice = select_short_regime_policy(selection_scored)

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
        outer_scored = _score_frame(
            outer_models,
            outer_validation,
            calibrators=outer_calibrators,
        )

        long_threshold = (
            float(long_choice["threshold"]) if long_choice.get("enabled") else 1.0
        )
        short_threshold = (
            float(short_choice["threshold"]) if short_choice.get("enabled") else 1.0
        )
        fold = _fold_report(
            outer_scored,
            long_threshold=long_threshold,
            short_threshold=short_threshold,
            long_min_volatility=long_choice.get("volatility_floor"),
            long_min_rsi=long_choice.get("rsi_floor"),
            short_min_volatility=short_choice.get("volatility_floor"),
            short_min_rsi=short_choice.get("rsi_floor"),
        )
        fold["fold"] = fold_index
        fold["rolling_train_rows"] = int(len(outer_train))
        fold["rolling_train_start"] = str(outer_train["decision_time"].min())
        fold["rolling_train_end"] = str(outer_train["decision_time"].max())
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        fold["inner_long_regime_selection"] = long_choice
        fold["inner_short_regime_selection"] = short_choice
        folds.append(fold)

        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "long_enabled": long_choice.get("enabled"),
                    "short_enabled": short_choice.get("enabled"),
                    "long_threshold": long_choice.get("threshold"),
                    "short_threshold": short_choice.get("threshold"),
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
        bool(v) for v in robustness_gate.values()
    )

    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "protocol": {
            "rolling_recent_training": True,
            "rolling_train_fraction": ROLLING_TRAIN_FRACTION,
            "outer_min_train_fraction": OUTER_MIN_TRAIN_FRACTION,
            "outer_validation_fraction": OUTER_VALIDATION_FRACTION,
            "inner_economic_side_selection": True,
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
    report = evaluate_v20(
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
