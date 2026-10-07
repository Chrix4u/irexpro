"""USDJPY v34 profitability plus tail-loss safety research.

Exploratory research only. This branch keeps the frozen structural
opportunity/direction policy, models side-specific probability of positive
friction-aware return, and adds a second side-specific classifier for avoiding
a loss worse than one causal event barrier.

All model fitting/evaluation stays strictly before the frozen qualification
boundary. No UAT/future rows are used and no PAPER/LIVE approval is produced.
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
    EVENT_BARRIER_RETURN_COLUMN,
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

EXPERIMENT = "event_barrier_v34_profitability_tail_safety"
MODEL_VARIANT = "event_barrier_v34_profitability_tail_safety"
PROFITABILITY_FLOOR = 0.60
TAIL_SAFETY_FLOOR = 0.60
LONG_PROFIT_TARGET = "v34_long_profitable"
SHORT_PROFIT_TARGET = "v34_short_profitable"
LONG_SAFE_TARGET = "v34_long_tail_safe"
SHORT_SAFE_TARGET = "v34_short_tail_safe"


def _add_targets(frame: pd.DataFrame) -> pd.DataFrame:
    labeled = frame.copy()
    barrier = pd.to_numeric(
        labeled[EVENT_BARRIER_RETURN_COLUMN], errors="raise"
    ).to_numpy(dtype=float)
    if not np.isfinite(barrier).all() or np.any(barrier <= 0):
        raise ValueError("v34 requires positive finite causal event barriers")

    for side, return_col, profit_target, safe_target in (
        ("long", EVENT_LONG_NET_RETURN_COLUMN, LONG_PROFIT_TARGET, LONG_SAFE_TARGET),
        ("short", EVENT_SHORT_NET_RETURN_COLUMN, SHORT_PROFIT_TARGET, SHORT_SAFE_TARGET),
    ):
        returns = pd.to_numeric(labeled[return_col], errors="raise").to_numpy(dtype=float)
        if not np.isfinite(returns).all():
            raise ValueError(f"{side} return target contains non-finite values")
        labeled[profit_target] = (returns > 0.0).astype(int)
        # A setup is tail-safe when the realized friction-aware loss does not
        # exceed one causal event barrier. This threshold is defined by event
        # semantics, not selected from outer validation outcomes.
        labeled[safe_target] = (returns >= -barrier).astype(int)
    return labeled


def _fit_side_quality_models(
    training_window: pd.DataFrame,
    *,
    variant: ModelVariant,
    feature_columns: list[str],
    horizon_bars: int,
):
    labeled = _add_targets(training_window)
    fit, early = _split_internal_early_stopping_tail(
        labeled,
        horizon_bars=horizon_bars,
    )

    specs = {
        "long_profitability": LONG_PROFIT_TARGET,
        "short_profitability": SHORT_PROFIT_TARGET,
        "long_tail_safety": LONG_SAFE_TARGET,
        "short_tail_safety": SHORT_SAFE_TARGET,
    }
    models = {}
    counts: dict[str, Any] = {
        "quality_fit_rows": int(len(fit)),
        "quality_early_stop_rows": int(len(early)),
    }
    for name, target in specs.items():
        if fit[target].nunique() < 2 or early[target].nunique() < 2:
            raise ValueError(f"{name} target lacks both classes")
        component_variant = ModelVariant(
            name=f"{variant.name}_{name}",
            parameter_overrides=variant.parameter_overrides,
            sample_weight_policy="class_balance",
            calibration="none",
            feature_policy=variant.feature_policy,
        )
        models[name] = _fit_binary_variant(
            component_variant,
            fit=fit,
            early_stop=early,
            feature_columns=feature_columns,
            target_column=target,
            sample_weight_policy="class_balance",
        )
        counts[f"{name}_fit_positive_rows"] = int(fit[target].sum())
        counts[f"{name}_early_positive_rows"] = int(early[target].sum())
    return models, counts


def _apply_v34(
    source: pd.DataFrame,
    *,
    direction_models,
    opportunity_model,
    quality_models,
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

    long_profit = quality_models["long_profitability"].predict_proba(
        source[feature_columns]
    )[:, 1]
    short_profit = quality_models["short_profitability"].predict_proba(
        source[feature_columns]
    )[:, 1]
    long_safe = quality_models["long_tail_safety"].predict_proba(
        source[feature_columns]
    )[:, 1]
    short_safe = quality_models["short_tail_safety"].predict_proba(
        source[feature_columns]
    )[:, 1]

    predicted_long = predictions["predicted_long"].to_numpy(dtype=bool)
    selected_profit = np.where(predicted_long, long_profit, short_profit)
    selected_safe = np.where(predicted_long, long_safe, short_safe)

    predictions["long_profitability_probability"] = long_profit
    predictions["short_profitability_probability"] = short_profit
    predictions["selected_profitability_probability"] = selected_profit
    predictions["long_tail_safety_probability"] = long_safe
    predictions["short_tail_safety_probability"] = short_safe
    predictions["selected_tail_safety_probability"] = selected_safe
    predictions["profitability_filter_pass"] = (
        selected_profit >= PROFITABILITY_FLOOR
    )
    predictions["tail_safety_filter_pass"] = selected_safe >= TAIL_SAFETY_FLOOR
    predictions["active_trade"] = (
        predictions["active_trade"]
        & predictions["profitability_filter_pass"]
        & predictions["tail_safety_filter_pass"]
    )
    predictions["confidence_policy"] = (
        "opportunity_gte_0_60_and_normalized_direction_confidence_gte_0_60_"
        "and_side_margin_gte_0_10_and_selected_profitability_gte_0_60_"
        "and_selected_one_barrier_tail_safety_gte_0_60"
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
            structural_counts,
        ) = _fit_event_hybrid_dual_direction_for_outer(
            outer_train,
            variant=variant,
            horizon_bars=1,
        )
        quality_models, quality_counts = _fit_side_quality_models(
            outer_train,
            variant=variant,
            feature_columns=feature_columns,
            horizon_bars=1,
        )
        predictions = _apply_v34(
            outer_validation,
            direction_models=direction_models,
            opportunity_model=opportunity_model,
            quality_models=quality_models,
            feature_columns=feature_columns,
            fold=fold,
        )
        checkpoint = checkpoint_dir / f"fold-{fold:02d}-v34.csv"
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
                "tail_safety_passes": int(
                    predictions["tail_safety_filter_pass"].sum()
                ),
                "fit_counts": {**structural_counts, **quality_counts},
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
    long_trade_count = int(
        sum(
            int(
                pd.read_csv(f["checkpoint"])
                .loc[lambda frame: frame["active_trade"].astype(bool), "predicted_long"]
                .astype(bool)
                .sum()
            )
            for f in fold_reports
        )
    )
    short_trade_count = int(trading["trade_or_period_count"]) - long_trade_count
    checks = {
        "two_sided_execution": long_trade_count > 0 and short_trade_count > 0,
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
        "targets": {
            "profitability": "side_specific_friction_aware_event_net_return_gt_zero",
            "tail_safety": (
                "side_specific_friction_aware_event_net_return_gte_negative_"
                "one_causal_event_barrier"
            ),
        },
        "policy": {
            "confidence_floor": CONFIDENCE_FLOOR,
            "action_margin_floor": 0.10,
            "selected_profitability_probability_floor": PROFITABILITY_FLOOR,
            "selected_tail_safety_probability_floor": TAIL_SAFETY_FLOOR,
            "outer_validation_used_for_threshold_selection": False,
        },
        "folds": fold_reports,
        "overall": overall,
        "positive_fold_fraction": positive_fold_fraction,
        "execution_sides": {
            "long_trades": long_trade_count,
            "short_trades": short_trade_count,
        },
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
                "fold_trade_counts": [f["active_trades"] for f in fold_reports],
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
