"""USDJPY v12 side-conditional payoff research runner.

Research-only successor to v11. v12 preserves the v10 dual-side direction
architecture, calibrates only pooled opportunity probability, and replaces the
zero-inflated payoff regressors with side-conditional magnitude models.

The final future holdout is never read here. No PAPER/LIVE approval is emitted.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score, brier_score_loss

from app.domain.training.model_qualification import (
    EVENT_ACTIONABLE_TARGET_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    EVENT_STEP_COLUMN,
    ModelVariant,
    _apply_calibrator,
    _fit_calibrator,
    _fit_event_hybrid_dual_direction_for_outer,
    _nested_windows,
    _probabilities,
    _refit_windows,
    _regression_model_for_variant,
    _split_internal_early_stopping_tail,
)
from app.domain.training.single_pair_v11 import (
    _concat_chronological,
    _selection_funnel,
    _trading_metrics,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.v11_calibrated_opportunity import (
    apply_v11_execution_policy,
    select_execution_thresholds,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v12_side_conditional_payoff"
MODEL_NAME = "event_barrier_v12_side_conditional_payoff"
CALIBRATION_METHOD = "platt"


def _fit_magnitude_regressor(
    *,
    variant: ModelVariant,
    frame_fit: pd.DataFrame,
    frame_early: pd.DataFrame,
    feature_columns: list[str],
    target_column: str,
    positive_component: bool,
    side: str,
) -> tuple[Any, dict[str, int]]:
    fit_return = (
        pd.to_numeric(frame_fit[target_column], errors="raise").to_numpy(dtype=float)
        * 10_000.0
    )
    early_return = (
        pd.to_numeric(frame_early[target_column], errors="raise").to_numpy(dtype=float)
        * 10_000.0
    )

    if positive_component:
        fit_mask = fit_return > 0.0
        early_mask = early_return > 0.0
        fit_target = fit_return[fit_mask]
        early_target = early_return[early_mask]
        component = "upside"
    else:
        fit_mask = fit_return < 0.0
        early_mask = early_return < 0.0
        fit_target = -fit_return[fit_mask]
        early_target = -early_return[early_mask]
        component = "downside"

    if int(fit_mask.sum()) < 100 or int(early_mask.sum()) < 20:
        raise ValueError(
            f"v12 {side} {component} conditional magnitude requires sufficient rows"
        )

    model = _regression_model_for_variant(
        ModelVariant(
            name=f"{variant.name}_{side}_{component}_conditional",
            parameter_overrides=variant.parameter_overrides,
            sample_weight_policy="economic",
            calibration="none",
            feature_policy=variant.feature_policy,
        )
    )
    model.fit(
        frame_fit.loc[fit_mask, feature_columns],
        fit_target,
        eval_set=[(frame_early.loc[early_mask, feature_columns], early_target)],
        verbose=False,
    )
    return model, {
        "fit_rows": int(fit_mask.sum()),
        "early_stop_rows": int(early_mask.sum()),
    }


def _fit_v12_models(
    training_window: pd.DataFrame,
    *,
    horizon_bars: int,
) -> tuple[dict[str, Any], Any, dict[str, Any], list[str], dict[str, Any]]:
    variant = ModelVariant(name=MODEL_NAME)
    (
        side_direction_models,
        opportunity_model,
        feature_columns,
        direction_counts,
    ) = _fit_event_hybrid_dual_direction_for_outer(
        training_window,
        variant=variant,
        horizon_bars=horizon_bars,
    )

    fit, early = _split_internal_early_stopping_tail(
        training_window,
        horizon_bars=horizon_bars,
    )
    magnitude_models: dict[str, Any] = {}
    magnitude_counts: dict[str, Any] = {}
    for side, target_column in {
        "long": EVENT_LONG_NET_RETURN_COLUMN,
        "short": EVENT_SHORT_NET_RETURN_COLUMN,
    }.items():
        for positive in (True, False):
            model, counts = _fit_magnitude_regressor(
                variant=variant,
                frame_fit=fit,
                frame_early=early,
                feature_columns=feature_columns,
                target_column=target_column,
                positive_component=positive,
                side=side,
            )
            component = "upside" if positive else "downside"
            magnitude_models[f"{side}_{component}"] = model
            magnitude_counts[f"{side}_{component}"] = counts

    return (
        side_direction_models,
        opportunity_model,
        magnitude_models,
        feature_columns,
        {
            "direction": direction_counts,
            "conditional_magnitude": magnitude_counts,
        },
    )


def _fit_opportunity_calibrator(
    *,
    opportunity_model: Any,
    feature_columns: list[str],
    calibration_frame: pd.DataFrame,
) -> Any:
    raw = _probabilities(opportunity_model, calibration_frame, feature_columns)
    return _fit_calibrator(
        CALIBRATION_METHOD,
        probabilities=raw,
        labels=calibration_frame[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(dtype=int),
    )


def _score_frame(
    source: pd.DataFrame,
    *,
    side_direction_models: dict[str, Any],
    opportunity_model: Any,
    magnitude_models: dict[str, Any],
    feature_columns: list[str],
    opportunity_calibrator: Any,
    fold: int,
) -> pd.DataFrame:
    columns = [
        "decision_time",
        "instrument",
        EVENT_ACTIONABLE_TARGET_COLUMN,
        EVENT_DIRECTION_TARGET_COLUMN,
        EVENT_LONG_NET_RETURN_COLUMN,
        EVENT_SHORT_NET_RETURN_COLUMN,
        EVENT_STEP_COLUMN,
        EVENT_BARRIER_RETURN_COLUMN,
        "m1_spread_bps",
        "m1_volatility_20",
    ]
    result = source[[c for c in columns if c in source.columns]].copy()

    long_action = _probabilities(
        side_direction_models["long"], source, feature_columns
    )
    short_action = _probabilities(
        side_direction_models["short"], source, feature_columns
    )
    total = np.maximum(long_action + short_action, 1e-7)
    long_direction_probability = np.clip(long_action / total, 1e-7, 1.0 - 1e-7)
    predicted_long = long_direction_probability >= 0.50
    direction_confidence = np.maximum(
        long_direction_probability,
        1.0 - long_direction_probability,
    )

    raw_opportunity = _probabilities(opportunity_model, source, feature_columns)
    opportunity_probability = _apply_calibrator(
        opportunity_calibrator,
        raw_opportunity,
    )

    long_up_magnitude = np.maximum(
        np.asarray(
            magnitude_models["long_upside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )
    long_down_magnitude = np.maximum(
        np.asarray(
            magnitude_models["long_downside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )
    short_up_magnitude = np.maximum(
        np.asarray(
            magnitude_models["short_upside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )
    short_down_magnitude = np.maximum(
        np.asarray(
            magnitude_models["short_downside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )

    short_direction_probability = 1.0 - long_direction_probability
    expected_long_upside = long_direction_probability * long_up_magnitude
    expected_long_downside = short_direction_probability * long_down_magnitude
    expected_short_upside = short_direction_probability * short_up_magnitude
    expected_short_downside = long_direction_probability * short_down_magnitude

    selected_upside = np.where(
        predicted_long,
        expected_long_upside,
        expected_short_upside,
    )
    selected_downside = np.where(
        predicted_long,
        expected_long_downside,
        expected_short_downside,
    )

    result["long_action_probability"] = long_action
    result["short_action_probability"] = short_action
    result["raw_positive_probability"] = long_direction_probability
    result["positive_probability"] = long_direction_probability
    result["predicted_long"] = predicted_long
    result["direction_confidence"] = direction_confidence
    result["raw_opportunity_probability"] = raw_opportunity
    result["opportunity_probability"] = opportunity_probability
    result["action_probability_margin"] = np.abs(long_action - short_action)

    result["conditional_long_upside_bps"] = long_up_magnitude
    result["conditional_long_downside_bps"] = long_down_magnitude
    result["conditional_short_upside_bps"] = short_up_magnitude
    result["conditional_short_downside_bps"] = short_down_magnitude

    result["expected_long_upside_bps"] = expected_long_upside
    result["expected_long_downside_bps"] = expected_long_downside
    result["expected_short_upside_bps"] = expected_short_upside
    result["expected_short_downside_bps"] = expected_short_downside
    result["expected_selected_upside_bps"] = selected_upside
    result["expected_selected_downside_bps"] = selected_downside
    result["expected_selected_net_bps"] = selected_upside - selected_downside
    result["expected_payoff_ratio"] = selected_upside / np.maximum(
        selected_downside, 1e-6
    )
    result["selected_net_return"] = np.where(
        predicted_long,
        pd.to_numeric(result[EVENT_LONG_NET_RETURN_COLUMN], errors="raise"),
        pd.to_numeric(result[EVENT_SHORT_NET_RETURN_COLUMN], errors="raise"),
    )
    result["fold"] = int(fold)
    result["experiment"] = EXPERIMENT_NAME
    result["model_variant"] = MODEL_NAME
    result["calibration_method"] = "opportunity_platt_direction_none"
    return result


def _fold_report(
    predictions: pd.DataFrame,
    *,
    threshold_choice: Any,
    inner_selection: pd.DataFrame,
    training_counts: dict[str, Any],
) -> dict[str, Any]:
    actionable = predictions.loc[
        predictions[EVENT_ACTIONABLE_TARGET_COLUMN] == 1
    ].copy()
    directional_balanced_accuracy = (
        float(
            balanced_accuracy_score(
                actionable[EVENT_DIRECTION_TARGET_COLUMN].astype(int),
                actionable["predicted_long"].astype(int),
            )
        )
        if not actionable.empty
        else 0.0
    )
    opportunity_brier = float(
        brier_score_loss(
            predictions[EVENT_ACTIONABLE_TARGET_COLUMN].astype(int),
            predictions["opportunity_probability"].astype(float),
        )
    )
    return {
        "fold": int(predictions["fold"].iloc[0]),
        "validation_start": str(predictions["decision_time"].min()),
        "validation_end": str(predictions["decision_time"].max()),
        "validation_rows": int(len(predictions)),
        "directional_balanced_accuracy": directional_balanced_accuracy,
        "opportunity_brier_score": opportunity_brier,
        "threshold_selection": {
            "eligible": bool(threshold_choice.eligible),
            "reason": threshold_choice.reason,
            "opportunity_threshold": float(
                threshold_choice.opportunity_threshold
            ),
            "action_margin_floor": float(threshold_choice.action_margin_floor),
            "inner_metrics": threshold_choice.metrics,
            "candidate_count": len(threshold_choice.candidates),
        },
        "inner_selection_funnel": _selection_funnel(inner_selection),
        "training_counts": training_counts,
        "trading": _trading_metrics(predictions),
    }


def run_v12_qualification(
    dataset: pd.DataFrame,
    *,
    horizon_bars: int,
    max_splits: int = 3,
    min_inner_periods: int = 50,
) -> tuple[dict[str, Any], pd.DataFrame]:
    unique_periods = int(dataset["decision_time"].nunique())
    min_train = max(250, int(unique_periods * 0.60))
    validation = max(100, int(unique_periods * 0.07))
    outer_splits = iter_purged_walk_forward_time_splits(
        dataset,
        time_column="decision_time",
        min_train_periods=min_train,
        validation_periods=validation,
        purge_periods=horizon_bars,
        embargo_periods=horizon_bars,
        max_splits=max_splits,
    )

    fold_reports: list[dict[str, Any]] = []
    prediction_frames: list[pd.DataFrame] = []

    for fold, (outer_train, outer_validation) in enumerate(outer_splits, start=1):
        inner = _nested_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=min_inner_periods,
        )
        inner_training_prefix = _concat_chronological(
            inner.fit,
            inner.early_stop,
        )
        (
            inner_direction,
            inner_opportunity,
            inner_magnitude,
            inner_features,
            inner_counts,
        ) = _fit_v12_models(
            inner_training_prefix,
            horizon_bars=horizon_bars,
        )
        inner_opportunity_calibrator = _fit_opportunity_calibrator(
            opportunity_model=inner_opportunity,
            feature_columns=inner_features,
            calibration_frame=inner.calibration,
        )
        inner_scored = _score_frame(
            inner.selection,
            side_direction_models=inner_direction,
            opportunity_model=inner_opportunity,
            magnitude_models=inner_magnitude,
            feature_columns=inner_features,
            opportunity_calibrator=inner_opportunity_calibrator,
            fold=0,
        )
        threshold_choice = select_execution_thresholds(inner_scored)

        refit = _refit_windows(
            outer_train,
            horizon_bars=horizon_bars,
            min_inner_periods=min_inner_periods,
        )
        outer_training_prefix = _concat_chronological(
            refit.fit,
            refit.early_stop,
        )
        (
            outer_direction,
            outer_opportunity,
            outer_magnitude,
            outer_features,
            outer_counts,
        ) = _fit_v12_models(
            outer_training_prefix,
            horizon_bars=horizon_bars,
        )
        outer_opportunity_calibrator = _fit_opportunity_calibrator(
            opportunity_model=outer_opportunity,
            feature_columns=outer_features,
            calibration_frame=refit.calibration,
        )
        scored = _score_frame(
            outer_validation,
            side_direction_models=outer_direction,
            opportunity_model=outer_opportunity,
            magnitude_models=outer_magnitude,
            feature_columns=outer_features,
            opportunity_calibrator=outer_opportunity_calibrator,
            fold=fold,
        )
        evaluated = apply_v11_execution_policy(
            scored,
            opportunity_threshold=threshold_choice.opportunity_threshold,
            action_margin_floor=threshold_choice.action_margin_floor,
        )
        prediction_frames.append(evaluated)
        fold_reports.append(
            _fold_report(
                evaluated,
                threshold_choice=threshold_choice,
                inner_selection=inner_scored,
                training_counts={
                    "inner": inner_counts,
                    "outer_refit": outer_counts,
                },
            )
        )

    combined = pd.concat(prediction_frames, ignore_index=True)
    report = {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "selection_policy": (
            "inner chronological Platt calibration of pooled opportunity plus "
            "bounded opportunity/margin threshold selection from classification "
            "evidence only; direction confidence remains v10 dual-side normalized"
        ),
        "payoff_policy": (
            "side-conditional favorable/adverse magnitude regression weighted at "
            "inference by normalized dual-side direction probability"
        ),
        "payoff_ratio_floor": 1.15,
        "direction_confidence_floor": 0.60,
        "folds": fold_reports,
        "overall_trading": _trading_metrics(combined),
        "outer_validation_rows": int(len(combined)),
    }
    return report, combined


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--instrument", default="USDJPY")
    parser.add_argument("--horizon-bars", type=int, default=1)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--max-splits", type=int, default=3)
    parser.add_argument("--report", required=True)
    parser.add_argument("--predictions", required=True)
    args = parser.parse_args()

    pooled, hashes = load_and_prepare_corpora(
        {args.instrument: args.dataset},
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
    )
    report, predictions = run_v12_qualification(
        pooled,
        horizon_bars=args.horizon_bars,
        max_splits=args.max_splits,
    )
    report["dataset_sha256"] = hashes
    report["decision_time_before"] = pd.Timestamp(
        args.decision_time_before
    ).isoformat()

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    predictions_path = Path(args.predictions)
    predictions_path.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(predictions_path, index=False)
    print(json.dumps(report["overall_trading"], sort_keys=True))


if __name__ == "__main__":
    main()
