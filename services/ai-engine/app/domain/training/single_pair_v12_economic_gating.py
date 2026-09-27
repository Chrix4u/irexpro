"""USDJPY v12 research: calibrated economic gating on disjoint outer folds.

v12 is a new research candidate, not a modification of frozen v10 or evaluated
v11. Its outer validation era is intentionally earlier than v11's exposed
outer folds. Gate selection uses only nested inner-selection economics.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score

from app.domain.training.model_qualification import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    ModelVariant,
    _fit_calibrator,
    _nested_windows,
    _probabilities,
    _refit_windows,
)
from app.domain.training.single_pair_v11_calibrated_gating import (
    DIRECTION_CONFIDENCE_FLOOR,
    MARGIN_FLOOR_GRID,
    OPPORTUNITY_THRESHOLD_GRID,
    PAYOFF_RATIO_FLOOR,
    _apply_gate,
    _fit_models,
    _score_frame,
    _trading_metrics,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v12_calibrated_economic_gating"
MIN_INNER_TRADES = 10
MIN_OUTER_TRADES = 30
MIN_PER_FOLD_TRADES = 5
MAX_FOLD_TRADE_CONCENTRATION = 0.80


def _candidate_gate_report(
    scored: pd.DataFrame,
    *,
    opportunity_threshold: float,
    margin_floor: float,
) -> dict[str, Any]:
    gated = _apply_gate(
        scored,
        opportunity_threshold=opportunity_threshold,
        margin_floor=margin_floor,
    )
    active = gated.loc[gated["active_trade"]].copy()
    trading = _trading_metrics(active)

    opportunity_ba = float(
        balanced_accuracy_score(
            gated[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
            (gated["opportunity_probability"] >= opportunity_threshold).to_numpy(int),
        )
    )
    actionable = gated.loc[gated[EVENT_ACTIONABLE_TARGET_COLUMN] == 1]
    direction_ba = None
    if not actionable.empty and actionable[EVENT_DIRECTION_TARGET_COLUMN].nunique() == 2:
        direction_ba = float(
            balanced_accuracy_score(
                actionable[EVENT_DIRECTION_TARGET_COLUMN].to_numpy(int),
                actionable["predicted_long"].to_numpy(int),
            )
        )

    profit_factor = trading.get("profit_factor")
    profit_factor_for_gate = (
        float(profit_factor) if profit_factor is not None else (
            float("inf") if int(trading["trade_count"]) >= MIN_INNER_TRADES else 0.0
        )
    )
    eligible = (
        int(trading["trade_count"]) >= MIN_INNER_TRADES
        and float(trading["total_return"]) > 0.0
        and profit_factor_for_gate >= 1.15
        and float(trading["max_drawdown"]) <= 0.12
    )
    return {
        "opportunity_threshold": float(opportunity_threshold),
        "margin_floor": float(margin_floor),
        "opportunity_balanced_accuracy": opportunity_ba,
        "direction_balanced_accuracy": direction_ba,
        "trading": trading,
        "eligible": bool(eligible),
    }


def select_economic_gate(scored: pd.DataFrame) -> dict[str, Any]:
    candidates = [
        _candidate_gate_report(
            scored,
            opportunity_threshold=opportunity_threshold,
            margin_floor=margin_floor,
        )
        for opportunity_threshold in OPPORTUNITY_THRESHOLD_GRID
        for margin_floor in MARGIN_FLOOR_GRID
    ]
    eligible = [candidate for candidate in candidates if candidate["eligible"]]
    if not eligible:
        return {
            "selected": None,
            "candidate_count": len(candidates),
            "eligible_count": 0,
            "reason": (
                "No inner gate candidate met minimum trade evidence plus positive "
                "profit-factor/drawdown constraints."
            ),
            "candidates": candidates,
        }

    selected = max(
        eligible,
        key=lambda row: (
            row["opportunity_balanced_accuracy"],
            min(float(row["trading"]["trade_count"]), 30.0) / 30.0,
            min(
                float(row["trading"]["profit_factor"])
                if row["trading"]["profit_factor"] is not None
                else 3.0,
                3.0,
            ),
            float(row["trading"]["total_return"]),
            row["margin_floor"],
        ),
    )
    return {
        "selected": selected,
        "candidate_count": len(candidates),
        "eligible_count": len(eligible),
        "candidates": candidates,
    }


def _fold_report(
    scored: pd.DataFrame,
    *,
    gate_selection: dict[str, Any],
) -> dict[str, Any]:
    selected = gate_selection["selected"]
    if selected is None:
        return {
            "selection_failed": True,
            "active_trade_records": [],
            "trading": _trading_metrics(pd.DataFrame()),
        }

    gated = _apply_gate(
        scored,
        opportunity_threshold=float(selected["opportunity_threshold"]),
        margin_floor=float(selected["margin_floor"]),
    )
    active = gated.loc[gated["active_trade"]].copy()
    return {
        "selection_failed": False,
        "opportunity_threshold": float(selected["opportunity_threshold"]),
        "margin_floor": float(selected["margin_floor"]),
        "opportunity_balanced_accuracy": float(
            balanced_accuracy_score(
                gated[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
                (
                    gated["opportunity_probability"]
                    >= float(selected["opportunity_threshold"])
                ).to_numpy(int),
            )
        ),
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


def evaluate_v12(
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
    min_train = int(unique_periods * 0.40)
    validation = int(unique_periods * 0.06)
    variant = ModelVariant(name="event_barrier_v12_calibrated_economic_gating")

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
        calibration_raw = _probabilities(
            inner_models.opportunity_model,
            nested.calibration,
            inner_models.feature_columns,
        )
        calibrator = _fit_calibrator(
            "platt",
            probabilities=calibration_raw,
            labels=nested.calibration[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
        )
        selection_scored = _score_frame(
            inner_models,
            nested.selection,
            opportunity_calibrator=calibrator,
        )
        gate_selection = select_economic_gate(selection_scored)

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=50,
        )
        outer_models = _fit_models(refit.fit, refit.early_stop, variant=variant)
        refit_raw = _probabilities(
            outer_models.opportunity_model,
            refit.calibration,
            outer_models.feature_columns,
        )
        outer_calibrator = _fit_calibrator(
            "platt",
            probabilities=refit_raw,
            labels=refit.calibration[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(int),
        )
        outer_scored = _score_frame(
            outer_models,
            outer_validation,
            opportunity_calibrator=outer_calibrator,
        )
        fold = _fold_report(outer_scored, gate_selection=gate_selection)
        fold["fold"] = fold_index
        fold["validation_start"] = str(outer_validation["decision_time"].min())
        fold["validation_end"] = str(outer_validation["decision_time"].max())
        fold["inner_gate_selection"] = gate_selection
        folds.append(fold)
        print(
            json.dumps(
                {
                    "fold": fold_index,
                    "selection_failed": fold["selection_failed"],
                    "trades": fold["trading"]["trade_count"],
                    "long": fold["trading"].get("long_trades", 0),
                    "short": fold["trading"].get("short_trades", 0),
                    "total_return": fold["trading"]["total_return"],
                },
                sort_keys=True,
            ),
            flush=True,
        )

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
        aggregate_trading = _trading_metrics(active)
    else:
        aggregate_trading = _trading_metrics(pd.DataFrame())

    trade_counts = [int(fold["trading"]["trade_count"]) for fold in folds]
    total_trades = int(aggregate_trading["trade_count"])
    long_trades = int(aggregate_trading.get("long_trades", 0))
    short_trades = int(aggregate_trading.get("short_trades", 0))
    max_concentration = (
        max(trade_counts) / total_trades if total_trades > 0 and trade_counts else 0.0
    )
    positive_folds = sum(
        float(fold["trading"]["total_return"]) > 0.0 for fold in folds
    )
    profit_factor = aggregate_trading.get("profit_factor")
    robustness_gate = {
        "all_inner_selections_succeeded": all(
            not bool(fold["selection_failed"]) for fold in folds
        ),
        "minimum_trade_evidence": total_trades >= MIN_OUTER_TRADES,
        "minimum_each_fold_trade_evidence": bool(trade_counts)
        and min(trade_counts) >= MIN_PER_FOLD_TRADES,
        "fold_concentration_lte_0_80": max_concentration
        <= MAX_FOLD_TRADE_CONCENTRATION,
        "two_sided_execution": long_trades > 0 and short_trades > 0,
        "positive_fold_fraction_gte_0_60": (
            positive_folds / len(folds) >= 0.60 if folds else False
        ),
        "aggregate_profit_factor_gte_1_15": profit_factor is not None
        and float(profit_factor) >= 1.15,
        "aggregate_sharpe_gte_1_0": (
            aggregate_trading.get("sharpe_ratio") is not None
            and float(aggregate_trading["sharpe_ratio"]) >= 1.0
        ),
        "aggregate_max_drawdown_lte_0_12": float(
            aggregate_trading.get("max_drawdown", 1.0)
        )
        <= 0.12,
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
            "outer_min_train_fraction": 0.40,
            "outer_validation_fraction": 0.06,
            "outer_fold_era_intentionally_precedes_v11": True,
            "inner_gate_selection_uses_economics": True,
            "direction_confidence_floor": DIRECTION_CONFIDENCE_FLOOR,
            "payoff_ratio_floor": PAYOFF_RATIO_FLOOR,
            "minimum_inner_trades": MIN_INNER_TRADES,
        },
        "dataset_sha256": hashes,
        "folds": folds,
        "aggregate": {
            "trading": aggregate_trading,
            "fold_trade_counts": trade_counts,
            "max_fold_trade_fraction": max_concentration,
            "positive_fold_fraction": positive_folds / len(folds) if folds else 0.0,
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

    report = evaluate_v12(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        max_splits=args.max_splits,
    )
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True, default=str))
    print(json.dumps(report["aggregate"], sort_keys=True))
    print(json.dumps(report["robustness_gate"], sort_keys=True))


if __name__ == "__main__":
    main()
