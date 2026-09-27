"""Leakage-safe v11 opportunity calibration and execution-threshold selection.

This module is deliberately separate from frozen v10. Thresholds are selected
only on inner chronological selection data and then locked for outer-fold use.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

OPPORTUNITY_THRESHOLD_GRID = (
    0.15,
    0.20,
    0.25,
    0.30,
    0.35,
    0.40,
    0.45,
    0.50,
    0.55,
    0.60,
)
ACTION_MARGIN_GRID = (0.00, 0.02, 0.03, 0.05, 0.075, 0.10)
PAYOFF_RATIO_FLOOR = 1.15
DIRECTION_CONFIDENCE_FLOOR = 0.60
MIN_OPPORTUNITY_PREDICTIONS = 100
MIN_DIRECTION_EVALUATED_ROWS = 20
MIN_OPPORTUNITY_BALANCED_ACCURACY = 0.52
MIN_OPPORTUNITY_RECALL = 0.10
MIN_DIRECTION_BALANCED_ACCURACY = 0.52
MIN_DIRECTION_WILSON_LOWER_BOUND = 0.50


@dataclass(frozen=True)
class ExecutionThresholdChoice:
    opportunity_threshold: float
    action_margin_floor: float
    eligible: bool
    reason: str
    metrics: dict[str, Any]
    candidates: tuple[dict[str, Any], ...]


def _profit_factor(returns: np.ndarray) -> float | None:
    gains = float(returns[returns > 0.0].sum())
    losses = float(-returns[returns < 0.0].sum())
    if losses <= 0.0:
        return None
    return gains / losses


def _balanced_accuracy(
    truth: np.ndarray,
    predicted: np.ndarray,
) -> float | None:
    truth = np.asarray(truth, dtype=int)
    predicted = np.asarray(predicted, dtype=int)
    positives = truth == 1
    negatives = truth == 0
    if not positives.any() or not negatives.any():
        return None
    sensitivity = float((predicted[positives] == 1).mean())
    specificity = float((predicted[negatives] == 0).mean())
    return (sensitivity + specificity) / 2.0


def _wilson_lower_bound(
    successes: int,
    total: int,
    *,
    z_score: float = 1.959963984540054,
) -> float | None:
    """Return the two-sided 95% Wilson lower bound for a Bernoulli rate."""
    if total <= 0:
        return None
    if successes < 0 or successes > total:
        raise ValueError("successes must be between zero and total")
    proportion = successes / total
    z2 = z_score * z_score
    denominator = 1.0 + z2 / total
    centre = proportion + z2 / (2.0 * total)
    adjustment = z_score * math.sqrt(
        (proportion * (1.0 - proportion) / total)
        + (z2 / (4.0 * total * total))
    )
    return (centre - adjustment) / denominator


def apply_v11_execution_policy(
    frame: pd.DataFrame,
    *,
    opportunity_threshold: float,
    action_margin_floor: float,
) -> pd.DataFrame:
    """Apply a locked execution policy to an already-scored candidate frame."""
    required = {
        "predicted_long",
        "direction_confidence",
        "opportunity_probability",
        "action_probability_margin",
        "expected_selected_net_bps",
        "expected_payoff_ratio",
        "selected_net_return",
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"v11 execution frame missing columns: {missing}")
    if not 0.0 < opportunity_threshold < 1.0:
        raise ValueError("opportunity_threshold must be between 0 and 1")
    if action_margin_floor < 0.0:
        raise ValueError("action_margin_floor cannot be negative")

    result = frame.copy()
    payoff_pass = (
        (pd.to_numeric(result["expected_selected_net_bps"], errors="raise") > 0.0)
        & (
            pd.to_numeric(result["expected_payoff_ratio"], errors="raise")
            >= PAYOFF_RATIO_FLOOR
        )
    )
    active = (
        (
            pd.to_numeric(result["direction_confidence"], errors="raise")
            >= DIRECTION_CONFIDENCE_FLOOR
        )
        & (
            pd.to_numeric(result["opportunity_probability"], errors="raise")
            >= opportunity_threshold
        )
        & (
            pd.to_numeric(result["action_probability_margin"], errors="raise")
            >= action_margin_floor
        )
        & payoff_pass
    )
    result["payoff_filter_pass"] = payoff_pass
    result["active_trade"] = active
    result["opportunity_threshold"] = float(opportunity_threshold)
    result["action_margin_floor"] = float(action_margin_floor)
    result["confidence_policy"] = (
        "v11_inner_selected_calibrated_opportunity_and_margin_with_locked_"
        "direction_0_60_and_payoff_ratio_1_15"
    )
    return result


def _candidate_trading_metrics(frame: pd.DataFrame) -> dict[str, Any]:
    active = frame.loc[frame["active_trade"].astype(bool)].copy()
    if active.empty:
        return {
            "trade_count": 0,
            "long_trades": 0,
            "short_trades": 0,
            "total_return": 0.0,
            "average_return": None,
            "win_rate": None,
            "profit_factor": None,
            "both_sides_observed": False,
        }
    returns = pd.to_numeric(active["selected_net_return"], errors="raise").to_numpy(
        dtype=float
    )
    predicted_long = active["predicted_long"].astype(bool)
    long_trades = int(predicted_long.sum())
    short_trades = int((~predicted_long).sum())
    return {
        "trade_count": int(len(active)),
        "long_trades": long_trades,
        "short_trades": short_trades,
        "total_return": float(returns.sum()),
        "average_return": float(returns.mean()),
        "win_rate": float((returns > 0.0).mean()),
        "profit_factor": _profit_factor(returns),
        "both_sides_observed": long_trades > 0 and short_trades > 0,
    }


def _classification_metrics(
    frame: pd.DataFrame,
    *,
    opportunity_threshold: float,
    action_margin_floor: float,
) -> dict[str, Any]:
    required = {
        "event_actionable_target",
        "event_direction_target",
        "predicted_long",
        "direction_confidence",
        "opportunity_probability",
        "action_probability_margin",
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"v11 selection frame missing label columns: {missing}")

    opportunity_truth = frame["event_actionable_target"].to_numpy(dtype=int)
    opportunity_prediction = (
        frame["opportunity_probability"].to_numpy(dtype=float)
        >= opportunity_threshold
    ).astype(int)
    opportunity_balanced = _balanced_accuracy(
        opportunity_truth,
        opportunity_prediction,
    )
    true_positive = int(
        ((opportunity_prediction == 1) & (opportunity_truth == 1)).sum()
    )
    predicted_positive = int((opportunity_prediction == 1).sum())
    actual_positive = int((opportunity_truth == 1).sum())
    opportunity_precision = true_positive / max(1, predicted_positive)
    opportunity_recall = true_positive / max(1, actual_positive)

    actionable = frame["event_actionable_target"].to_numpy(dtype=int) == 1
    direction_mask = (
        actionable
        & (
            frame["direction_confidence"].to_numpy(dtype=float)
            >= DIRECTION_CONFIDENCE_FLOOR
        )
        & (
            frame["action_probability_margin"].to_numpy(dtype=float)
            >= action_margin_floor
        )
    )
    direction_truth = frame.loc[
        direction_mask,
        "event_direction_target",
    ].to_numpy(dtype=int)
    direction_prediction = frame.loc[
        direction_mask,
        "predicted_long",
    ].astype(int).to_numpy()
    direction_balanced = _balanced_accuracy(
        direction_truth,
        direction_prediction,
    )
    direction_rows = int(direction_mask.sum())
    actionable_rows = int(actionable.sum())
    direction_coverage = direction_rows / max(1, actionable_rows)
    direction_correct = int((direction_truth == direction_prediction).sum())
    direction_accuracy = (
        float(direction_correct / direction_rows)
        if direction_rows
        else None
    )
    direction_wilson_lower = _wilson_lower_bound(
        direction_correct,
        direction_rows,
    )
    predicted_long_count = int((direction_prediction == 1).sum())
    predicted_short_count = int((direction_prediction == 0).sum())

    return {
        "opportunity_predicted_positive": predicted_positive,
        "opportunity_actual_positive": actual_positive,
        "opportunity_balanced_accuracy": opportunity_balanced,
        "opportunity_precision": float(opportunity_precision),
        "opportunity_recall": float(opportunity_recall),
        "direction_evaluated_rows": direction_rows,
        "direction_actionable_rows": actionable_rows,
        "direction_coverage": float(direction_coverage),
        "direction_accuracy": direction_accuracy,
        "direction_wilson_lower_95": direction_wilson_lower,
        "direction_balanced_accuracy": direction_balanced,
        "direction_predicted_long": predicted_long_count,
        "direction_predicted_short": predicted_short_count,
    }


def select_execution_thresholds(
    selection_frame: pd.DataFrame,
    *,
    minimum_opportunity_predictions: int = MIN_OPPORTUNITY_PREDICTIONS,
    minimum_direction_rows: int = MIN_DIRECTION_EVALUATED_ROWS,
) -> ExecutionThresholdChoice:
    """Select execution thresholds from inner classification evidence only.

    Sparse realized trade P&L is reported for diagnostics but never used to
    choose the thresholds. This prevents threshold optimization on a handful of
    trades while preserving a strict untouched outer validation.
    """
    if minimum_opportunity_predictions < 1:
        raise ValueError("minimum_opportunity_predictions must be positive")
    if minimum_direction_rows < 1:
        raise ValueError("minimum_direction_rows must be positive")

    candidates: list[dict[str, Any]] = []
    for opportunity_threshold in OPPORTUNITY_THRESHOLD_GRID:
        for action_margin_floor in ACTION_MARGIN_GRID:
            evaluated = apply_v11_execution_policy(
                selection_frame,
                opportunity_threshold=opportunity_threshold,
                action_margin_floor=action_margin_floor,
            )
            classification = _classification_metrics(
                selection_frame,
                opportunity_threshold=opportunity_threshold,
                action_margin_floor=action_margin_floor,
            )
            trading = _candidate_trading_metrics(evaluated)
            opportunity_balanced = classification[
                "opportunity_balanced_accuracy"
            ]
            direction_balanced = classification[
                "direction_balanced_accuracy"
            ]
            eligible = (
                int(classification["opportunity_predicted_positive"])
                >= minimum_opportunity_predictions
                and opportunity_balanced is not None
                and float(opportunity_balanced)
                >= MIN_OPPORTUNITY_BALANCED_ACCURACY
                and float(classification["opportunity_recall"])
                >= MIN_OPPORTUNITY_RECALL
                and int(classification["direction_evaluated_rows"])
                >= minimum_direction_rows
                and direction_balanced is not None
                and float(direction_balanced)
                >= MIN_DIRECTION_BALANCED_ACCURACY
                and classification["direction_wilson_lower_95"] is not None
                and float(classification["direction_wilson_lower_95"])
                > MIN_DIRECTION_WILSON_LOWER_BOUND
                and int(classification["direction_predicted_long"]) > 0
                and int(classification["direction_predicted_short"]) > 0
            )
            candidates.append(
                {
                    "opportunity_threshold": float(opportunity_threshold),
                    "action_margin_floor": float(action_margin_floor),
                    "eligible": bool(eligible),
                    **classification,
                    **trading,
                }
            )

    eligible_rows = [row for row in candidates if row["eligible"]]
    if not eligible_rows:
        fallback = apply_v11_execution_policy(
            selection_frame,
            opportunity_threshold=0.60,
            action_margin_floor=0.10,
        )
        fallback_metrics = {
            **_classification_metrics(
                selection_frame,
                opportunity_threshold=0.60,
                action_margin_floor=0.10,
            ),
            **_candidate_trading_metrics(fallback),
        }
        return ExecutionThresholdChoice(
            opportunity_threshold=0.60,
            action_margin_floor=0.10,
            eligible=False,
            reason=(
                "No inner-selection candidate met opportunity balanced-accuracy/"
                "recall and statistically significant two-sided direction "
                "confidence requirements; "
                "conservative v10 thresholds retained."
            ),
            metrics=fallback_metrics,
            candidates=tuple(candidates),
        )

    def key(row: dict[str, Any]) -> tuple[float, float, float, float, float, float, float]:
        return (
            float(row["opportunity_balanced_accuracy"]),
            float(row["direction_wilson_lower_95"]),
            float(row["direction_balanced_accuracy"]),
            float(row["opportunity_recall"]),
            float(row["direction_coverage"]),
            float(row["opportunity_threshold"]),
            float(row["action_margin_floor"]),
        )

    selected = max(eligible_rows, key=key)
    return ExecutionThresholdChoice(
        opportunity_threshold=float(selected["opportunity_threshold"]),
        action_margin_floor=float(selected["action_margin_floor"]),
        eligible=True,
        reason=(
            "Selected strictly from inner chronological classification "
            "calibration/coverage evidence; sparse trade P&L was not optimized."
        ),
        metrics=dict(selected),
        candidates=tuple(candidates),
    )
