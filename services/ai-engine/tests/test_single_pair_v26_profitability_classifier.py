"""Tests for USDJPY v26 profitability-classifier governance."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training import single_pair_v26_profitability_classifier as v26
from app.domain.training.model_qualification import (
    EVENT_LONG_ACTIONABLE_TARGET_COLUMN,
    EVENT_LONG_NET_RETURN_COLUMN,
    EVENT_SHORT_ACTIONABLE_TARGET_COLUMN,
    EVENT_SHORT_NET_RETURN_COLUMN,
)


def _scored(side: str, returns: list[float]) -> pd.DataFrame:
    rows = len(returns)
    other = "short" if side == "long" else "long"
    return pd.DataFrame(
        {
            "decision_time": pd.date_range(
                "2026-01-01",
                periods=rows,
                freq="min",
                tz="UTC",
            ),
            "instrument": ["USDJPY"] * rows,
            f"{side}_action_probability": [0.12] * rows,
            f"{side}_profit_probability": [0.70] * rows,
            f"{other}_action_probability": [0.01] * rows,
            f"{other}_profit_probability": [0.20] * rows,
            f"event_{side}_net_return": returns,
            f"event_{other}_net_return": [0.0] * rows,
            "m1_volatility_20": np.linspace(0.00004, 0.00020, rows),
            "h1_rsi_14": np.linspace(0.40, 0.80, rows),
            "m1_spread_bps": [0.25] * rows,
        }
    )


def test_v26_profitability_target_uses_after_friction_net_return_sign() -> None:
    frame = pd.DataFrame(
        {
            EVENT_LONG_ACTIONABLE_TARGET_COLUMN: [1, 0, 0],
            EVENT_SHORT_ACTIONABLE_TARGET_COLUMN: [0, 1, 0],
            EVENT_LONG_NET_RETURN_COLUMN: [0.001, 0.0, -0.001],
            EVENT_SHORT_NET_RETURN_COLUMN: [-0.001, 0.002, 0.0],
        }
    )
    labeled = v26._with_profitability_targets(frame)
    assert labeled[v26.LONG_PROFITABLE_TARGET].tolist() == [1, 0, 0]
    assert labeled[v26.SHORT_PROFITABLE_TARGET].tolist() == [0, 1, 0]


def test_v26_enables_side_with_broad_inner_economic_evidence() -> None:
    segment = [0.001] * 10 + [-0.0005] * 5
    scored = _scored("long", segment * 3)
    selected = v26.select_side_policy(scored, side="long")
    assert selected["enabled"] is True
    assert selected["trade_count"] >= v26.MIN_SELECTION_TRADES
    assert selected["positive_segments"] >= v26.MIN_POSITIVE_SEGMENTS
    assert (
        selected["profit_factor_infinite"]
        or selected["profit_factor"] >= v26.MIN_SELECTION_PROFIT_FACTOR
    )


def test_v26_rejects_side_without_temporally_distributed_evidence() -> None:
    returns = [0.001] * 15 + [-0.001] * 15 + [-0.001] * 15
    scored = _scored("short", returns)
    selected = v26.select_side_policy(scored, side="short")
    assert selected["enabled"] is False
    assert selected["reason"] == "no_inner_profitability_policy_met_economic_evidence"


def test_v26_keeps_outer_and_inner_evidence_gates_locked() -> None:
    assert v26.MIN_SELECTION_TRADES == 30
    assert v26.MIN_SELECTION_PROFIT_FACTOR == 1.15
    assert v26.MIN_POSITIVE_SEGMENTS == 2
    assert v26.SEGMENT_COUNT == 3
    assert v26.MIN_OUTER_TRADES == 20
    assert v26.MIN_PER_FOLD_TRADES == 3
    assert v26.MAX_FOLD_TRADE_CONCENTRATION == 0.80
