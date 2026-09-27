"""USDJPY v24 research: mid-era stability audit of the unchanged v16 policy.

This runner does not introduce new thresholds or tune on outer validation. It
reuses the v16 two-sided inner-economic policy and evaluates it on fixed,
pre-declared mid-history train fractions. Frozen v10 and the sealed future
holdout remain untouched.
"""
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
from app.domain.training.single_pair_v11_calibrated_gating import (
    _fit_models,
    _trading_metrics,
)
from app.domain.training.single_pair_v16_two_sided_economic import (
    MAX_FOLD_TRADE_CONCENTRATION,
    MIN_OUTER_TRADES,
    MIN_PER_FOLD_TRADES,
    _fit_side_calibrators,
    _fold_report,
    _score_frame,
    select_long_regime_policy,
    select_short_regime_policy,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v24_mid_era_stability_audit"
DEFAULT_TRAIN_FRACTIONS = (0.60, 0.80)
DEFAULT_VALIDATION_FRACTION = 0.02


def _evaluate_era(
    pooled: pd.DataFrame,
    *,
    train_fraction: float,
    validation_fraction: float,
    horizon_bars: int,
    max_splits: int,
) -> dict[str, Any]:
    if not 0.30 <= train_fraction <= 0.94:
        raise ValueError("train_fraction must stay within the predeclared historical audit range")
    if not 0.005 <= validation_fraction <= 0.05:
        raise ValueError("validation_fraction out of audit bounds")

    unique_periods = int(pooled["decision_time"].nunique())
    min_train = max(250, int(unique_periods * train_fraction))
    validation = max(100, int(unique_periods * validation_fraction))
    variant = ModelVariant(
        name=f"event_barrier_v24_stability_{int(train_fraction * 100):02d}"
    )

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
        inner_models = _fit_models(nested.fit, nested.early_stop, variant=variant)
        inner_calibrators = _fit_side_calibrators(inner_models, nested.calibration)
        selection = _ensure_event_dual_actionability_targets(nested.selection)
        selection_scored = _score_frame(
            inner_models,
            selection,
            calibrators=inner_calibrators,
        )
        long_choice = select_long_regime_policy(selection_scored)
        short_choice = select_short_regime_policy(selection_scored)

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(refit.fit, refit.early_stop, variant=variant)
        outer_calibrators = _fit_side_calibrators(outer_models, refit.calibration)
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
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        fold["inner_long_regime_selection"] = long_choice
        fold["inner_short_regime_selection"] = short_choice
        folds.append(fold)
        print(json.dumps({
            "train_fraction": train_fraction,
            "fold": fold_index,
            "trades": fold["trading"]["trade_count"],
            "long": fold["trading"]["long_trades"],
            "short": fold["trading"]["short_trades"],
            "total_return": fold["trading"]["total_return"],
            "profit_factor": fold["trading"]["profit_factor"],
        }, sort_keys=True), flush=True)

    records = [
        record
        for fold in folds
        for record in fold["active_trade_records"]
    ]
    if records:
        active = pd.DataFrame(records)
        active["decision_time"] = pd.to_datetime(
            active["decision_time"], utc=True, errors="raise"
        )
        trading = _trading_metrics(active)
    else:
        trading = _trading_metrics(pd.DataFrame())

    trade_counts = [int(f["trading"]["trade_count"]) for f in folds]
    total = int(trading["trade_count"])
    long_trades = int(trading.get("long_trades", 0))
    short_trades = int(trading.get("short_trades", 0))
    positive_folds = sum(float(f["trading"]["total_return"]) > 0.0 for f in folds)
    concentration = max(trade_counts) / total if total and trade_counts else 0.0
    pf = trading.get("profit_factor")
    sharpe = trading.get("sharpe_ratio")

    gates = {
        "minimum_trade_evidence": total >= MIN_OUTER_TRADES,
        "minimum_each_fold_trade_evidence": bool(trade_counts)
        and min(trade_counts) >= MIN_PER_FOLD_TRADES,
        "fold_concentration_lte_0_80": concentration <= MAX_FOLD_TRADE_CONCENTRATION,
        "two_sided_execution": long_trades > 0 and short_trades > 0,
        "positive_fold_fraction_gte_0_60": (
            positive_folds / len(folds) >= 0.60 if folds else False
        ),
        "aggregate_profit_factor_gte_1_15": pf is not None and float(pf) >= 1.15,
        "aggregate_sharpe_gte_1_0": sharpe is not None and float(sharpe) >= 1.0,
        "aggregate_max_drawdown_lte_0_12": float(
            trading.get("max_drawdown", 1.0)
        ) <= 0.12,
    }
    gates["era_passed"] = all(bool(v) for v in gates.values())

    return {
        "train_fraction": train_fraction,
        "validation_fraction": validation_fraction,
        "folds": folds,
        "aggregate": {
            "trading": trading,
            "fold_trade_counts": trade_counts,
            "max_fold_trade_fraction": concentration,
            "positive_fold_fraction": positive_folds / len(folds) if folds else 0.0,
        },
        "gates": gates,
    }


def evaluate_v24(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str,
    train_fractions: tuple[float, ...] = DEFAULT_TRAIN_FRACTIONS,
    validation_fraction: float = DEFAULT_VALIDATION_FRACTION,
    max_splits: int = 1,
) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    eras = [
        _evaluate_era(
            pooled,
            train_fraction=fraction,
            validation_fraction=validation_fraction,
            horizon_bars=horizon_bars,
            max_splits=max_splits,
        )
        for fraction in train_fractions
    ]
    return {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "frozen_v10_holdout_unchanged": True,
        "decision_time_before": pd.Timestamp(decision_time_before).isoformat(),
        "dataset_sha256": hashes,
        "protocol": {
            "policy": "unchanged_v16_two_sided_inner_economic_policy",
            "train_fractions": list(train_fractions),
            "validation_fraction": validation_fraction,
            "max_splits": max_splits,
            "no_outer_retuning": True,
        },
        "eras": eras,
        "stability_passed": bool(eras) and all(
            bool(era["gates"]["era_passed"]) for era in eras
        ),
    }


def _parse_dataset(value: str) -> dict[str, str]:
    instrument, sep, path = value.partition("=")
    if not sep:
        raise ValueError("--dataset must use INSTRUMENT=/path.csv")
    return {instrument.strip().upper(): path.strip()}


def _parse_fractions(value: str) -> tuple[float, ...]:
    values = tuple(float(item.strip()) for item in value.split(",") if item.strip())
    if not values:
        raise ValueError("at least one train fraction is required")
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--horizon-bars", type=int, default=1)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--train-fractions", default="0.60,0.80")
    parser.add_argument("--validation-fraction", type=float, default=0.02)
    parser.add_argument("--max-splits", type=int, default=1)
    args = parser.parse_args()

    report = evaluate_v24(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        train_fractions=_parse_fractions(args.train_fractions),
        validation_fraction=args.validation_fraction,
        max_splits=args.max_splits,
    )
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    print(json.dumps({
        "stability_passed": report["stability_passed"],
        "eras": [
            {
                "train_fraction": era["train_fraction"],
                "trading": era["aggregate"]["trading"],
                "gates": era["gates"],
            }
            for era in report["eras"]
        ],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
