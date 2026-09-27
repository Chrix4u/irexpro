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
    EVENT_DIRECTION_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
    EVENT_STEP_COLUMN,
    EVENT_BARRIER_RETURN_COLUMN,
    ModelVariant,
    _apply_calibrator,
    _fit_calibrator,
    _fit_event_hybrid_payoff_risk_for_outer,
    _nested_windows,
    _probabilities,
    _refit_windows,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora
from app.domain.training.validation import iter_purged_walk_forward_time_splits
from app.domain.training.v11_calibrated_opportunity import (
    apply_v11_execution_policy,
    select_execution_thresholds,
)

EXPERIMENT_NAME = "event_barrier_v11_calibrated_opportunity_payoff_risk"
MODEL_NAME = "event_barrier_v11_calibrated_opportunity_payoff_risk"
CALIBRATION_METHOD = "platt"


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
) -> tuple[dict[str, Any], Any, dict[str, Any], list[str]]:
    variant = ModelVariant(name=MODEL_NAME)
    direction_models, opportunity_model, payoff_models, feature_columns, _ = (
        _fit_event_hybrid_payoff_risk_for_outer(
            training_window,
            variant=variant,
            horizon_bars=horizon_bars,
        )
    )
    return direction_models, opportunity_model, payoff_models, feature_columns


def _score_frame(
    source: pd.DataFrame,
    *,
    direction_models: dict[str, Any],
    opportunity_model: Any,
    payoff_models: dict[str, Any],
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
    available = [column for column in columns if column in source.columns]
    result = source[available].copy()

    long_probability = _probabilities(
        direction_models["long"], source, feature_columns
    )
    short_probability = _probabilities(
        direction_models["short"], source, feature_columns
    )
    raw_opportunity = _probabilities(
        opportunity_model, source, feature_columns
    )
    calibrated_opportunity = _apply_calibrator(
        opportunity_calibrator, raw_opportunity
    )

    probability_total = np.maximum(long_probability + short_probability, 1e-7)
    normalized_long = np.clip(
        long_probability / probability_total,
        1e-7,
        1.0 - 1e-7,
    )
    predicted_long = long_probability >= short_probability

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

    result["long_action_probability"] = long_probability
    result["short_action_probability"] = short_probability
    result["positive_probability"] = normalized_long
    result["predicted_long"] = predicted_long
    result["direction_confidence"] = np.maximum(
        normalized_long, 1.0 - normalized_long
    )
    result["raw_opportunity_probability"] = raw_opportunity
    result["opportunity_probability"] = calibrated_opportunity
    result["action_probability_margin"] = np.abs(
        long_probability - short_probability
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
    return result


def _fit_calibrated_scoring_stack(
    training_prefix: pd.DataFrame,
    calibration_frame: pd.DataFrame,
    *,
    horizon_bars: int,
) -> tuple[dict[str, Any], Any, dict[str, Any], list[str], Any]:
    (
        direction_models,
        opportunity_model,
        payoff_models,
        feature_columns,
    ) = _fit_v11_models(training_prefix, horizon_bars=horizon_bars)
    calibration_raw = _probabilities(
        opportunity_model,
        calibration_frame,
        feature_columns,
    )
    calibrator = _fit_calibrator(
        CALIBRATION_METHOD,
        probabilities=calibration_raw,
        labels=calibration_frame[EVENT_ACTIONABLE_TARGET_COLUMN].to_numpy(
            dtype=int
        ),
    )
    return (
        direction_models,
        opportunity_model,
        payoff_models,
        feature_columns,
        calibrator,
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


def _fold_report(
    predictions: pd.DataFrame,
    *,
    threshold_choice: Any,
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
            inner_opportunity,
            inner_payoff,
            inner_features,
            inner_calibrator,
        ) = _fit_calibrated_scoring_stack(
            inner_training_prefix,
            inner.calibration,
            horizon_bars=horizon_bars,
        )
        inner_selection = _score_frame(
            inner.selection,
            direction_models=inner_direction,
            opportunity_model=inner_opportunity,
            payoff_models=inner_payoff,
            feature_columns=inner_features,
            opportunity_calibrator=inner_calibrator,
            fold=0,
        )
        choice = select_execution_thresholds(inner_selection)

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
            outer_payoff,
            outer_features,
            outer_calibrator,
        ) = _fit_calibrated_scoring_stack(
            outer_training_prefix,
            refit.calibration,
            horizon_bars=horizon_bars,
        )
        scored = _score_frame(
            outer_validation,
            direction_models=outer_direction,
            opportunity_model=outer_opportunity,
            payoff_models=outer_payoff,
            feature_columns=outer_features,
            opportunity_calibrator=outer_calibrator,
            fold=fold,
        )
        evaluated = apply_v11_execution_policy(
            scored,
            opportunity_threshold=choice.opportunity_threshold,
            action_margin_floor=choice.action_margin_floor,
        )
        prediction_frames.append(evaluated)
        fold_reports.append(_fold_report(evaluated, threshold_choice=choice))

    combined = pd.concat(prediction_frames, ignore_index=True)
    report = {
        "experiment": EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "selection_policy": (
            "inner chronological Platt calibration plus bounded threshold grid; "
            "outer validation never participates in threshold selection"
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
