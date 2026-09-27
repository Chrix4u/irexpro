"""Leakage-safe v11 opportunity calibration and execution-threshold selection.

This module is deliberately separate from frozen v10. Thresholds are selected
only on inner chronological selection data and then locked for outer-fold use.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

OPPORTUNITY_THRESHOLD_GRID = (0.35, 0.40, 0.45, 0.50, 0.55, 0.60)
ACTION_MARGIN_GRID = (0.03, 0.05, 0.075, 0.10)
PAYOFF_RATIO_FLOOR = 1.15
DIRECTION_CONFIDENCE_FLOOR = 0.60
MIN_SELECTION_TRADES = 30
MIN_SELECTION_SIDE_TRADES = 3


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


def _candidate_metrics(frame: pd.DataFrame) -> dict[str, Any]:
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


def select_execution_thresholds(
    selection_frame: pd.DataFrame,
    *,
    minimum_trades: int = MIN_SELECTION_TRADES,
    minimum_side_trades: int = MIN_SELECTION_SIDE_TRADES,
) -> ExecutionThresholdChoice:
    """Select thresholds using inner selection data only.

    Eligibility requires enough trades, positive economics, PF >= 1.15, and
    evidence from both directions. If no candidate qualifies, the conservative
    v10 thresholds are retained and the choice is marked ineligible.
    """
    if minimum_trades < 1:
        raise ValueError("minimum_trades must be positive")
    if minimum_side_trades < 0:
        raise ValueError("minimum_side_trades cannot be negative")

    candidates: list[dict[str, Any]] = []
    for opportunity_threshold in OPPORTUNITY_THRESHOLD_GRID:
        for action_margin_floor in ACTION_MARGIN_GRID:
            evaluated = apply_v11_execution_policy(
                selection_frame,
                opportunity_threshold=opportunity_threshold,
                action_margin_floor=action_margin_floor,
            )
            metrics = _candidate_metrics(evaluated)
            profit_factor = metrics["profit_factor"]
            eligible = (
                int(metrics["trade_count"]) >= minimum_trades
                and int(metrics["long_trades"]) >= minimum_side_trades
                and int(metrics["short_trades"]) >= minimum_side_trades
                and float(metrics["total_return"]) > 0.0
                and profit_factor is not None
                and float(profit_factor) >= 1.15
            )
            candidates.append(
                {
                    "opportunity_threshold": float(opportunity_threshold),
                    "action_margin_floor": float(action_margin_floor),
                    "eligible": bool(eligible),
                    **metrics,
                }
            )

    eligible_rows = [row for row in candidates if row["eligible"]]
    if not eligible_rows:
        fallback = apply_v11_execution_policy(
            selection_frame,
            opportunity_threshold=0.60,
            action_margin_floor=0.10,
        )
        return ExecutionThresholdChoice(
            opportunity_threshold=0.60,
            action_margin_floor=0.10,
            eligible=False,
            reason=(
                "No inner-selection candidate met evidence, two-sided coverage, "
                "positive-return, and profit-factor requirements; conservative "
                "v10 thresholds retained."
            ),
            metrics=_candidate_metrics(fallback),
            candidates=tuple(candidates),
        )

    def key(row: dict[str, Any]) -> tuple[float, float, float, float, float, float]:
        pf = float(row["profit_factor"])
        side_balance = min(int(row["long_trades"]), int(row["short_trades"]))
        return (
            min(float(row["trade_count"]), 100.0) / 100.0,
            min(float(side_balance), 20.0) / 20.0,
            pf,
            float(row["total_return"]),
            float(row["opportunity_threshold"]),
            float(row["action_margin_floor"]),
        )

    selected = max(eligible_rows, key=key)
    return ExecutionThresholdChoice(
        opportunity_threshold=float(selected["opportunity_threshold"]),
        action_margin_floor=float(selected["action_margin_floor"]),
        eligible=True,
        reason="Selected strictly from inner chronological selection evidence.",
        metrics=dict(selected),
        candidates=tuple(candidates),
    )
