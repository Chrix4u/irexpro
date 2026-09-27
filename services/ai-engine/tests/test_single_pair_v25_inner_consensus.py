"""Governance tests for USDJPY v25 inner-consensus research."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training import single_pair_v25_inner_consensus as v25


def _scored(side: str, returns: list[float]) -> pd.DataFrame:
    rows = len(returns)
    base = {
        "decision_time": pd.date_range("2026-01-01", periods=rows, freq="min", tz="UTC"),
        "instrument": ["USDJPY"] * rows,
        "m1_volatility_20": np.linspace(0.00005, 0.00020, rows),
        "h1_rsi_14": np.linspace(0.45, 0.90, rows),
        "long_action_probability": [0.20] * rows,
        "short_action_probability": [0.20] * rows,
        "long_expected_net_bps": [1.0] * rows,
        "short_expected_net_bps": [1.0] * rows,
        "long_payoff_ratio": [1.50] * rows,
        "short_payoff_ratio": [1.50] * rows,
        "event_long_net_return": [0.0] * rows,
        "event_short_net_return": [0.0] * rows,
    }
    base[f"event_{side}_net_return"] = returns
    return pd.DataFrame(base)


def test_v25_rejects_policy_without_cross_window_stability() -> None:
    frame = _scored("long", [0.001] * 4 + [-0.002] * 4 + [0.001] * 4)
    selected = v25.select_consensus_policy(frame, side="long")
    assert selected["enabled"] is False


def test_v25_can_accept_policy_with_cross_window_positive_evidence() -> None:
    frame = _scored(
        "short",
        [0.001, 0.001, 0.001, -0.0003] * 3,
    )
    selected = v25.select_consensus_policy(frame, side="short")
    assert selected["enabled"] is True
    assert selected["active_windows"] >= v25.MIN_ACTIVE_SELECTION_WINDOWS
    assert selected["positive_windows"] >= v25.MIN_POSITIVE_SELECTION_WINDOWS
    assert selected["trade_count"] >= v25.MIN_TOTAL_SELECTION_TRADES


def test_v25_governance_is_locked() -> None:
    assert v25.TRAIN_FRACTIONS == (0.60, 0.94)
    assert v25.INNER_WINDOWS == 3
    assert v25.MIN_AGGREGATE_SELECTION_PF == 1.15
    assert v25.PAYOFF_RATIO_FLOOR == 1.15
    assert v25.MIN_OUTER_TRADES == 20
    assert v25.MIN_PER_FOLD_TRADES == 3
