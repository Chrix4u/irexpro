"""USDJPY v33 side-specific profitability classifier research.

Exploratory research only. This branch replaces unstable payoff-magnitude
regressors with two binary classifiers estimating whether a friction-aware
LONG or SHORT outcome is positive. The structural opportunity/direction
policy remains unchanged.

All fitting and evaluation stay strictly before the frozen qualification
boundary. No UAT/future rows are consumed and no PAPER/LIVE approval is
produced.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    ModelVariant,
    _event_hybrid_dual_direction_prediction_frame,
    _fit_binary_variant,
    _fit_event_hybrid_dual_direction_for_outer,
    _summarize_predictions,
)
from app.domain.training.train_multitimeframe import (
    _split_internal_early_stopping_tail,
    load_and_prepare_corpora,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT = "event_barrier_v33_side_profitability_classifier"
MODEL_VARIANT = "event_barrier_v33_side_profitability_classifier"
PROFITABILITY_FLOOR = 0.60
LONG_PROFIT_TARGET = "v33_long_profitable"
SHORT_PROFIT_TARGET = "v33_short_profitable"


def _fit_profitability_models(
    training_window: pd.DataFrame,
    *,
    variant: ModelVariant,
    feature_columns: list[str],
    horizon_bars: int,
):
    labeled = training_window.copy()
    labeled[LONG_PROFIT_TARGET] = (
        pd.to_numeric(labeled[EVENT_LONG_NET_RETURN_COLUMN], errors="raise") > 0.0
    ).astype(int)
    labeled[SHORT_PROFIT_TARGET] = (
        pd.to_numeric(labeled[EVENT_SHORT_NET_RETURN_COLUMN], errors="raise") > 0.0
    ).astype(int)

    fit, early = _split_internal_early_stopping_tail(
        labeled,
        horizon_bars=horizon_bars,
    )
    models = {}
    counts: dict[str, Any] = {
        "profitability_fit_rows": int(len(fit)),
        "profitability_early_stop_rows": int(len(early)),
    }
    for side, target in (
        ("long", LONG_PROFIT_TARGET),
        ("short", SHORT_PROFIT_TARGET),
    ):
        if fit[target].nunique() < 2 or early[target].nunique() < 2:
            raise ValueError(f"{side} profitability target lacks both classes")
        side_variant = ModelVariant(
            name=f"{variant.name}_{side}_profitability",
            parameter_overrides=variant.parameter_overrides,
            sample_weight_policy="class_balance",
            calibration="none",
            feature_policy=variant.feature_policy,
        )
        models[side] = _fit_binary_variant(
            side_variant,
            fit=fit,
            early_stop=early,
            feature_columns=feature_columns,
            target_column=target,
            sample_weight_policy="class_balance",
        )
        counts[f"{side}_profitable_fit_rows"] = int(fit[target].sum())
        counts[f"{side}_profitable_early_stop_rows"] = int(early[target].sum())
    return models, counts


def _apply_v33(
    source: pd.DataFrame,
    *,
    direction_models,
    opportunity_model,
    profitability_models,
    feature_columns: list[str],
    fold: int,
) -> pd.DataFrame:
    long_probability = direction_models["long"].predict_proba(
        source[feature_columns]
    )[:, 1]
    short_probability = direction_models["short"].predict_proba(
        source[feature_columns]
    )[:, 1]
    opportunity_probability = opportunity_model.predict_proba(
        source[feature_columns]
    )[:, 1]

    predictions = _event_hybrid_dual_direction_prediction_frame(
        source,
        long_probabilities=np.asarray(long_probability, dtype=float),
        short_probabilities=np.asarray(short_probability, dtype=float),
        opportunity_probabilities=np.asarray(opportunity_probability, dtype=float),
        confidence_floor=CONFIDENCE_FLOOR,
        fold=fold,
        experiment=EXPERIMENT,
        variant=ModelVariant(name=MODEL_VARIANT),
    )

    long_profit = profitability_models["long"].predict_proba(
        source[feature_columns]
    )[:, 1]
    short_profit = profitability_models["short"].predict_proba(
        source[feature_columns]
    )[:, 1]
    selected_profit = np.where(
        predictions["predicted_long"].to_numpy(dtype=bool),
        long_profit,
        short_profit,
    )
    predictions["long_profitability_probability"] = long_profit
    predictions["short_profitability_probability"] = short_profit
    predictions["selected_profitability_probability"] = selected_profit
    predictions["profitability_filter_pass"] = (
        selected_profit >= PROFITABILITY_FLOOR
    )
    predictions["active_trade"] = (
        predictions["active_trade"] & predictions["profitability_filter_pass"]
    )
    predictions["confidence_policy"] = (
        "opportunity_gte_0_60_and_normalized_direction_confidence_gte_0_60_"
        "and_side_margin_gte_0_10_and_selected_profitability_probability_gte_0_60"
    )
    return predictions


def run(dataset: Path, cutoff: str, output: Path) -> dict[str, Any]:
    pooled, hashes = load_and_prepare_corpora(
        {"USDJPY": dataset},
        horizon_bars=1,
        decision_time_before=cutoff,
    )
    unique_periods = int(pooled["decision_time"].nunique())
    min_train = max(250, int(unique_periods * 0.60))
    validation = max(100, int(unique_periods * 0.07))
    splits = list(
        iter_purged_walk_forward_time_splits(
            pooled,
            time_column="decision_time",
            min_train_periods=min_train,
            validation_periods=validation,
            purge_periods=1,
            embargo_periods=1,
            max_splits=3,
        )
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output.parent / "checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    variant = ModelVariant(name=MODEL_VARIANT)
    fold_reports = []
    all_predictions = []
    for fold, (outer_train, outer_validation) in enumerate(splits, start=1):
        (
            direction_models,
            opportunity_model,
            feature_columns,
            classifier_counts,
        ) = _fit_event_hybrid_dual_direction_for_outer(
            outer_train,
            variant=variant,
            horizon_bars=1,
        )
        profitability_models, profitability_counts = _fit_profitability_models(
            outer_train,
            variant=variant,
            feature_columns=feature_columns,
            horizon_bars=1,
        )
        predictions = _apply_v33(
            outer_validation,
            direction_models=direction_models,
            opportunity_model=opportunity_model,
            profitability_models=profitability_models,
            feature_columns=feature_columns,
            fold=fold,
        )
        checkpoint = checkpoint_dir / f"fold-{fold:02d}-v33.csv"
        predictions.to_csv(checkpoint, index=False)
        summary = _summarize_predictions(
            predictions,
            horizon_bars=1,
            confidence_threshold=CONFIDENCE_FLOOR,
            decision_threshold=0.50,
        )
        fold_reports.append(
            {
                "fold": fold,
                "train_start": str(outer_train["decision_time"].min()),
                "train_end": str(outer_train["decision_time"].max()),
                "validation_start": str(outer_validation["decision_time"].min()),
                "validation_end": str(outer_validation["decision_time"].max()),
                "active_trades": int(predictions["active_trade"].sum()),
                "structural_passes": int(
                    (
                        (predictions["confidence"] >= CONFIDENCE_FLOOR)
                        & (predictions["action_probability_margin"] >= 0.10)
                    ).sum()
                ),
                "profitability_passes": int(
                    predictions["profitability_filter_pass"].sum()
                ),
                "fit_counts": {
                    **classifier_counts,
                    **profitability_counts,
                },
                "trading": summary["trading"],
                "checkpoint": str(checkpoint),
            }
        )
        all_predictions.append(predictions)

    combined = pd.concat(all_predictions, ignore_index=True)
    overall = _summarize_predictions(
        combined,
        horizon_bars=1,
        confidence_threshold=CONFIDENCE_FLOOR,
        decision_threshold=0.50,
    )
    trading = overall["trading"]
    positive_fold_fraction = (
        sum(float(f["trading"]["total_return"]) > 0 for f in fold_reports)
        / len(fold_reports)
    )
    thresholds = {
        "max_drawdown": 0.12,
        "min_positive_fold_fraction": 0.60,
        "min_profit_factor": 1.15,
        "min_sharpe_ratio": 1.0,
        "minimum_trade_evidence": 30,
    }
    checks = {
        "max_drawdown": float(trading["max_drawdown"]) <= thresholds["max_drawdown"],
        "positive_fold_fraction": positive_fold_fraction
        >= thresholds["min_positive_fold_fraction"],
        "profit_factor": trading["profit_factor"] is not None
        and float(trading["profit_factor"]) >= thresholds["min_profit_factor"],
        "sharpe_ratio": trading["sharpe_ratio"] is not None
        and float(trading["sharpe_ratio"]) >= thresholds["min_sharpe_ratio"],
        "minimum_trade_evidence_30": int(trading["trade_or_period_count"])
        >= thresholds["minimum_trade_evidence"],
    }
    report = {
        "experiment": EXPERIMENT,
        "model_variant": MODEL_VARIANT,
        "research_only": True,
        "exploratory_model_selection": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "dataset_sha256": hashes,
        "qualification_decision_time_before": cutoff,
        "horizon_bars": 1,
        "profitability_target": (
            "side_specific_friction_aware_event_net_return_gt_zero"
        ),
        "policy": {
            "confidence_floor": CONFIDENCE_FLOOR,
            "action_margin_floor": 0.10,
            "selected_profitability_probability_floor": PROFITABILITY_FLOOR,
            "outer_validation_used_for_threshold_selection": False,
        },
        "folds": fold_reports,
        "overall": overall,
        "positive_fold_fraction": positive_fold_fraction,
        "research_gate": {
            "thresholds": thresholds,
            "checks": checks,
            "research_gate_passed": all(checks.values()),
        },
    }
    output.write_text(json.dumps(report, indent=2, default=str))
    print(
        json.dumps(
            {
                "output": str(output),
                "active_trades": int(trading["trade_or_period_count"]),
                "sharpe_ratio": trading["sharpe_ratio"],
                "profit_factor": trading["profit_factor"],
                "max_drawdown": trading["max_drawdown"],
                "total_return": trading["total_return"],
                "positive_fold_fraction": positive_fold_fraction,
                "fold_trade_counts": [
                    f["active_trades"] for f in fold_reports
                ],
                "research_gate": report["research_gate"],
            },
            indent=2,
        )
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--cutoff", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(Path(args.dataset), args.cutoff, Path(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
