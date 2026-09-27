"""Tests for USDJPY v25 temporal-consistency governance."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training import single_pair_v25_temporal_consistency as v25


def _frame(returns: list[float], *, side: str = "long") -> pd.DataFrame:
    rows = len(returns)
    other = "short" if side == "long" else "long"
    data = {
        "decision_time": pd.date_range(
            "2026-01-01",
            periods=rows,
            freq="min",
            tz="UTC",
        ),
        "instrument": ["USDJPY"] * rows,
        "m1_volatility_20": np.linspace(0.00005, 0.00020, rows),
        "h1_rsi_14": np.linspace(0.40, 0.80, rows),
        f"{side}_action_probability": [0.20] * rows,
        f"{side}_expected_net_bps": [1.0] * rows,
        f"{side}_payoff_ratio": [1.5] * rows,
        f"event_{side}_net_return": returns,
        f"{other}_action_probability": [0.0] * rows,
        f"{other}_expected_net_bps": [0.0] * rows,
        f"{other}_payoff_ratio": [0.0] * rows,
        f"event_{other}_net_return": [0.0] * rows,
    }
    return pd.DataFrame(data)


def test_v25_enables_policy_with_distributed_positive_evidence() -> None:
    returns = (
        [0.001] * 4 + [-0.0004] * 2
        + [0.001] * 4 + [-0.0004] * 2
        + [0.001] * 4 + [-0.0004] * 2
    )
    selected = v25.select_temporally_stable_side_policy(
        _frame(returns),
        side="long",
    )
    assert selected["enabled"] is True
    assert selected["stable_segments"] >= v25.MIN_STABLE_SEGMENTS
    assert selected["trade_count"] >= v25.MIN_SIDE_SELECTION_TRADES


def test_v25_rejects_policy_concentrated_in_one_profitable_segment() -> None:
    returns = (
        [0.001] * 6
        + [-0.001] * 6
        + [-0.001] * 6
    )
    selected = v25.select_temporally_stable_side_policy(
        _frame(returns),
        side="long",
    )
    assert selected["enabled"] is False
    assert selected["reason"] == "no_temporally_stable_inner_policy"


def test_v25_keeps_locked_governance_floors() -> None:
    assert v25.PAYOFF_RATIO_FLOOR == 1.15
    assert v25.SELECTION_PROFIT_FACTOR_FLOOR == 1.15
    assert v25.SEGMENT_PROFIT_FACTOR_FLOOR == 1.00
    assert v25.MIN_STABLE_SEGMENTS == 2
    assert v25.SEGMENT_COUNT == 3
    assert v25.MIN_OUTER_TRADES == 20
    assert v25.MIN_PER_FOLD_TRADES == 3
