"""USDJPY v11 calibrated-opportunity research runner.

The v11 runner is research-only. It never modifies frozen v10 artifacts and it
never grants PAPER/LIVE approval. Opportunity calibration and execution
thresholds are learned strictly inside each outer training window.
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
    _fit_event_hybrid_payoff_risk_for_outer,
    _fit_event_two_stage_for_outer,
    _nested_windows,
    _probabilities,
    _refit_windows,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.v11_calibrated_opportunity import (
    apply_v11_execution_policy,
    select_execution_thresholds,
)
from app.domain.training.validation import iter_purged_walk_forward_time_splits

EXPERIMENT_NAME = "event_barrier_v11_calibrated_opportunity_payoff_risk"
MODEL_NAME = "event_barrier_v11_calibrated_opportunity_payoff_risk"
CALIBRATION_METHOD = "platt"
DIRECTION_BLEND_WEIGHTS = (0.0, 0.25, 0.50, 0.75, 1.0)


def _concat_chronological(*frames: pd.DataFrame) -> pd.DataFrame:
    return (
        pd.concat(frames, ignore_index=True)
        .sort_values(["decision_time", "instrument"])
        .reset_index(drop=True)
    )


def _fit_v11_models(
    training_window: pd.DataFrame,
    *,
    horizon_bars: int,
) -> tuple[Any, dict[str, Any], Any, dict[str, Any], list[str]]:
    """Fit both direction views plus pooled opportunity and payoff-risk models."""
    variant = ModelVariant(name=MODEL_NAME)

    direction_model, opportunity_model, feature_columns, _ = (
        _fit_event_two_stage_for_outer(
            training_window,
            variant=variant,
            horizon_bars=horizon_bars,
        )
    )

    (
        side_direction_models,
        _unused_opportunity_model,
        payoff_models,
        payoff_feature_columns,
        _,
    ) = _fit_event_hybrid_payoff_risk_for_outer(
        training_window,
        variant=variant,
        horizon_bars=horizon_bars,
    )
    if payoff_feature_columns != feature_columns:
        raise ValueError("v11 direction/payoff feature columns diverged")
    return (
        direction_model,
        side_direction_models,
        opportunity_model,
        payoff_models,
        feature_columns,
    )


def _raw_direction_probability(
    *,
    direction_model: Any,
    side_direction_models: dict[str, Any],
    source: pd.DataFrame,
    feature_columns: list[str],
    blend_weight: float,
) -> np.ndarray:
    """Blend actionable-only direction with normalized dual-side direction."""
    if not 0.0 <= blend_weight <= 1.0:
        raise ValueError("blend_weight must be between zero and one")
    direct = _probabilities(direction_model, source, feature_columns)
    long_side = _probabilities(
        side_direction_models["long"],
        source,
        feature_columns,
    )
    short_side = _probabilities(
        side_direction_models["short"],
        source,
        feature_columns,
    )
    dual = np.clip(
        long_side / np.maximum(long_side + short_side, 1e-7),
        1e-7,
        1.0 - 1e-7,
    )
    blended = (blend_weight * direct) + ((1.0 - blend_weight) * dual)
    return np.clip(blended, 1e-7, 1.0 - 1e-7)


def _score_frame(
    source: pd.DataFrame,
    *,
    direction_model: Any,
    side_direction_models: dict[str, Any],
    opportunity_model: Any,
    payoff_models: dict[str, Any],
    feature_columns: list[str],
    direction_calibrator: Any,
    opportunity_calibrator: Any,
    direction_blend_weight: float,
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
    available = [column for column in columns if column in source.columns]
    result = source[available].copy()

    raw_direction = _raw_direction_probability(
        direction_model=direction_model,
        side_direction_models=side_direction_models,
        source=source,
        feature_columns=feature_columns,
        blend_weight=direction_blend_weight,
    )
    calibrated_long = _apply_calibrator(
        direction_calibrator,
        raw_direction,
    )
    predicted_long = calibrated_long >= 0.50

    raw_opportunity = _probabilities(
        opportunity_model,
        source,
        feature_columns,
    )
    calibrated_opportunity = _apply_calibrator(
        opportunity_calibrator,
        raw_opportunity,
    )

    long_upside = np.maximum(
        np.asarray(
            payoff_models["long_upside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )
    long_downside = np.maximum(
        np.asarray(
            payoff_models["long_downside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )
    short_upside = np.maximum(
        np.asarray(
            payoff_models["short_upside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )
    short_downside = np.maximum(
        np.asarray(
            payoff_models["short_downside"].predict(source[feature_columns]),
            dtype=float,
        ),
        0.0,
    )
    selected_upside = np.where(predicted_long, long_upside, short_upside)
    selected_downside = np.where(predicted_long, long_downside, short_downside)

    result["raw_positive_probability"] = raw_direction
    result["positive_probability"] = calibrated_long
    result["predicted_long"] = predicted_long
    result["direction_confidence"] = np.maximum(
        calibrated_long, 1.0 - calibrated_long
    )
    result["raw_opportunity_probability"] = raw_opportunity
    result["opportunity_probability"] = calibrated_opportunity
    result["action_probability_margin"] = np.abs(
        (2.0 * calibrated_long) - 1.0
    )
    result["expected_long_upside_bps"] = long_upside
    result["expected_long_downside_bps"] = long_downside
    result["expected_short_upside_bps"] = short_upside
    result["expected_short_downside_bps"] = short_downside
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
    result["calibration_method"] = CALIBRATION_METHOD
    result["direction_blend_weight"] = float(direction_blend_weight)
    return result


def _fit_direction_calibrator(
    *,
    direction_model: Any,
    side_direction_models: dict[str, Any],
    feature_columns: list[str],
    calibration_frame: pd.DataFrame,
    blend_weight: float,
) -> Any:
    raw_direction = _raw_direction_probability(
        direction_model=direction_model,
        side_direction_models=side_direction_models,
        source=calibration_frame,
        feature_columns=feature_columns,
        blend_weight=blend_weight,
    )
    actionable = (
        calibration_frame[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(dtype=int) == 1
    )
    return _fit_calibrator(
        CALIBRATION_METHOD,
        probabilities=raw_direction[actionable],
        labels=calibration_frame.loc[
            actionable,
            EVENT_DIRECTION_TARGET_COLUMN,
        ].to_numpy(dtype=int),
    )


def _fit_opportunity_calibrator(
    *,
    opportunity_model: Any,
    feature_columns: list[str],
    calibration_frame: pd.DataFrame,
) -> Any:
    calibration_raw = _probabilities(
        opportunity_model,
        calibration_frame,
        feature_columns,
    )
    return _fit_calibrator(
        CALIBRATION_METHOD,
        probabilities=calibration_raw,
        labels=calibration_frame[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(
            dtype=int
        ),
    )


def _blend_choice_key(choice: Any) -> tuple[float, float, float, float]:
    metrics = choice.metrics
    return (
        float(metrics.get("direction_wilson_lower_95") or -1.0),
        float(metrics.get("direction_balanced_accuracy") or -1.0),
        float(metrics.get("opportunity_balanced_accuracy") or -1.0),
        float(metrics.get("opportunity_recall") or -1.0),
    )


def _trading_metrics(predictions: pd.DataFrame) -> dict[str, Any]:
    active = predictions.loc[predictions["active_trade"].astype(bool)].copy()
    if active.empty:
        return {
            "trades": 0,
            "long_trades": 0,
            "short_trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate": None,
            "total_return": 0.0,
            "average_return": None,
            "profit_factor": None,
            "max_drawdown": 0.0,
        }

    returns = pd.to_numeric(active["selected_net_return"], errors="raise").to_numpy(
        dtype=float
    )
    equity = np.cumprod(1.0 + returns)
    running_peak = np.maximum.accumulate(np.concatenate(([1.0], equity)))[1:]
    drawdown = equity / running_peak - 1.0
    gross_profit = float(returns[returns > 0.0].sum())
    gross_loss = float(-returns[returns < 0.0].sum())
    predicted_long = active["predicted_long"].astype(bool)
    return {
        "trades": int(len(active)),
        "long_trades": int(predicted_long.sum()),
        "short_trades": int((~predicted_long).sum()),
        "wins": int((returns > 0.0).sum()),
        "losses": int((returns < 0.0).sum()),
        "win_rate": float((returns > 0.0).mean()),
        "total_return": float(equity[-1] - 1.0),
        "average_return": float(returns.mean()),
        "profit_factor": (
            gross_profit / gross_loss if gross_loss > 0.0 else None
        ),
        "max_drawdown": float(abs(drawdown.min())),
    }


def _selection_funnel(frame: pd.DataFrame) -> dict[str, Any]:
    result: dict[str, Any] = {
        "opportunity_quantiles": {
            str(key): float(value)
            for key, value in frame["opportunity_probability"]
            .quantile([0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99])
            .to_dict()
            .items()
        },
        "by_direction": {},
    }
    for name, mask in {
        "long": frame["predicted_long"].astype(bool),
        "short": ~frame["predicted_long"].astype(bool),
    }.items():
        side = frame.loc[mask].copy()
        direction_pass = side["direction_confidence"] >= 0.60
        payoff_pass = (
            (side["expected_selected_net_bps"] > 0.0)
            & (side["expected_payoff_ratio"] >= 1.15)
        )
        payoff_candidates = side.loc[payoff_pass].copy()
        payoff_candidate_rows: list[dict[str, Any]] = []
        for _, candidate in payoff_candidates.nlargest(
            10, "expected_payoff_ratio"
        ).iterrows():
            payoff_candidate_rows.append(
                {
                    "decision_time": str(candidate["decision_time"]),
                    "predicted_long": bool(candidate["predicted_long"]),
                    "direction_confidence": float(candidate["direction_confidence"]),
                    "raw_direction_probability": float(
                        candidate["raw_positive_probability"]
                    ),
                    "opportunity_probability": float(
                        candidate["opportunity_probability"]
                    ),
                    "action_probability_margin": float(
                        candidate["action_probability_margin"]
                    ),
                    "expected_payoff_ratio": float(
                        candidate["expected_payoff_ratio"]
                    ),
                    "expected_selected_net_bps": float(
                        candidate["expected_selected_net_bps"]
                    ),
                    "event_actionable_target": int(
                        candidate[EVENT_ACTIONABLE_TARGET_COLUMN]
                    ),
                    "event_direction_target": int(
                        candidate[EVENT_DIRECTION_TARGET_COLUMN]
                    ),
                    "selected_net_return": float(
                        candidate["selected_net_return"]
                    ),
                }
            )
        rows: dict[str, Any] = {
            "predictions": int(len(side)),
            "direction_confidence_pass": int(direction_pass.sum()),
            "payoff_pass": int(payoff_pass.sum()),
            "direction_and_payoff_pass": int((direction_pass & payoff_pass).sum()),
            "payoff_candidates": payoff_candidate_rows,
            "payoff_ratio_quantiles": {
                str(key): float(value)
                for key, value in side["expected_payoff_ratio"]
                .quantile([0.50, 0.75, 0.90, 0.95, 0.99])
                .to_dict()
                .items()
            },
            "threshold_counts": {},
        }
        for opportunity_threshold in (0.15, 0.20, 0.25, 0.30, 0.35, 0.40):
            for margin_floor in (0.00, 0.02, 0.03, 0.05):
                active = (
                    direction_pass
                    & payoff_pass
                    & (side["opportunity_probability"] >= opportunity_threshold)
                    & (side["action_probability_margin"] >= margin_floor)
                )
                rows["threshold_counts"][
                    f"opp_{opportunity_threshold:.2f}_margin_{margin_floor:.2f}"
                ] = int(active.sum())
        result["by_direction"][name] = rows
    return result


def _fold_report(
    predictions: pd.DataFrame,
    *,
    threshold_choice: Any,
    inner_selection: pd.DataFrame,
    direction_blend_weight: float,
    blend_candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    actionable = predictions.loc[
        predictions[EVENT_ACTIONABLE_TARGET_COLUMN] == 1
    ].copy()
    if actionable.empty:
        directional_balanced_accuracy = 0.0
    else:
        directional_balanced_accuracy = float(
            balanced_accuracy_score(
                actionable[EVENT_DIRECTION_TARGET_COLUMN].astype(int),
                actionable["predicted_long"].astype(int),
            )
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
        "inner_selection_funnel": _selection_funnel(inner_selection),
        "direction_blend": {
            "selected_weight": float(direction_blend_weight),
            "candidate_reports": blend_candidates,
        },
        "threshold_selection": {
            "eligible": bool(threshold_choice.eligible),
            "reason": threshold_choice.reason,
            "opportunity_threshold": float(
                threshold_choice.opportunity_threshold
            ),
            "action_margin_floor": float(threshold_choice.action_margin_floor),
            "inner_metrics": threshold_choice.metrics,
            "candidate_count": len(threshold_choice.candidates),
            "candidate_reports": list(threshold_choice.candidates),
        },
        "trading": _trading_metrics(predictions),
    }


def run_v11_qualification(
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
            inner_side_direction,
            inner_opportunity,
            inner_payoff,
            inner_features,
        ) = _fit_v11_models(
            inner_training_prefix,
            horizon_bars=horizon_bars,
        )
        inner_opportunity_calibrator = _fit_opportunity_calibrator(
            opportunity_model=inner_opportunity,
            feature_columns=inner_features,
            calibration_frame=inner.calibration,
        )

        blend_candidates: list[dict[str, Any]] = []
        selected_weight: float | None = None
        selected_choice: Any | None = None
        selected_inner: pd.DataFrame | None = None
        for blend_weight in DIRECTION_BLEND_WEIGHTS:
            direction_calibrator = _fit_direction_calibrator(
                direction_model=inner_direction,
                side_direction_models=inner_side_direction,
                feature_columns=inner_features,
                calibration_frame=inner.calibration,
                blend_weight=blend_weight,
            )
            candidate_selection = _score_frame(
                inner.selection,
                direction_model=inner_direction,
                side_direction_models=inner_side_direction,
                opportunity_model=inner_opportunity,
                payoff_models=inner_payoff,
                feature_columns=inner_features,
                direction_calibrator=direction_calibrator,
                opportunity_calibrator=inner_opportunity_calibrator,
                direction_blend_weight=blend_weight,
                fold=0,
            )
            candidate_choice = select_execution_thresholds(candidate_selection)
            blend_candidates.append(
                {
                    "blend_weight": float(blend_weight),
                    "eligible": bool(candidate_choice.eligible),
                    "opportunity_threshold": float(
                        candidate_choice.opportunity_threshold
                    ),
                    "action_margin_floor": float(
                        candidate_choice.action_margin_floor
                    ),
                    "metrics": candidate_choice.metrics,
                }
            )
            if candidate_choice.eligible and (
                selected_choice is None
                or _blend_choice_key(candidate_choice)
                > _blend_choice_key(selected_choice)
            ):
                selected_weight = float(blend_weight)
                selected_choice = candidate_choice
                selected_inner = candidate_selection

        if selected_choice is None:
            selected_weight = 1.0
            direction_calibrator = _fit_direction_calibrator(
                direction_model=inner_direction,
                side_direction_models=inner_side_direction,
                feature_columns=inner_features,
                calibration_frame=inner.calibration,
                blend_weight=selected_weight,
            )
            selected_inner = _score_frame(
                inner.selection,
                direction_model=inner_direction,
                side_direction_models=inner_side_direction,
                opportunity_model=inner_opportunity,
                payoff_models=inner_payoff,
                feature_columns=inner_features,
                direction_calibrator=direction_calibrator,
                opportunity_calibrator=inner_opportunity_calibrator,
                direction_blend_weight=selected_weight,
                fold=0,
            )
            selected_choice = select_execution_thresholds(selected_inner)

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
            outer_side_direction,
            outer_opportunity,
            outer_payoff,
            outer_features,
        ) = _fit_v11_models(
            outer_training_prefix,
            horizon_bars=horizon_bars,
        )
        outer_direction_calibrator = _fit_direction_calibrator(
            direction_model=outer_direction,
            side_direction_models=outer_side_direction,
            feature_columns=outer_features,
            calibration_frame=refit.calibration,
            blend_weight=selected_weight,
        )
        outer_opportunity_calibrator = _fit_opportunity_calibrator(
            opportunity_model=outer_opportunity,
            feature_columns=outer_features,
            calibration_frame=refit.calibration,
        )
        scored = _score_frame(
            outer_validation,
            direction_model=outer_direction,
            side_direction_models=outer_side_direction,
            opportunity_model=outer_opportunity,
            payoff_models=outer_payoff,
            feature_columns=outer_features,
            direction_calibrator=outer_direction_calibrator,
            opportunity_calibrator=outer_opportunity_calibrator,
            direction_blend_weight=selected_weight,
            fold=fold,
        )
        evaluated = apply_v11_execution_policy(
            scored,
            opportunity_threshold=selected_choice.opportunity_threshold,
            action_margin_floor=selected_choice.action_margin_floor,
        )
        prediction_frames.append(evaluated)
        fold_reports.append(
            _fold_report(
                evaluated,
                threshold_choice=selected_choice,
                inner_selection=selected_inner,
                direction_blend_weight=selected_weight,
                blend_candidates=blend_candidates,
            )
        )

    combined = pd.concat(prediction_frames, ignore_index=True)
    report = {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "selection_policy": (
            "inner chronological Platt calibration plus bounded direction-blend/"
            "execution-threshold search; outer validation never participates in "
            "selection"
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
    report, predictions = run_v11_qualification(
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
