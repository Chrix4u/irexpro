"""Tests for USDJPY v23 LONG expected-net floor governance."""
from __future__ import annotations

import pandas as pd

from app.domain.training import single_pair_v23_long_net_floor as v23


def _scored(
    returns: list[float],
    expected_net_bps: list[float],
    *,
    probability: float = 0.20,
) -> pd.DataFrame:
    n = len(returns)
    return pd.DataFrame(
        {
            "long_action_probability": [probability] * n,
            "long_expected_net_bps": expected_net_bps,
            "long_payoff_ratio": [1.50] * n,
            "event_long_net_return": returns,
        }
    )


def test_v23_falls_back_to_v15_long_policy_when_no_stronger_floor_qualifies() -> None:
    scored = _scored(
        [-0.001] * 20,
        [0.10 + (index * 0.05) for index in range(20)],
    )
    selected = v23.select_long_expected_net_floor(
        scored,
        classification_choice={"threshold": 0.10},
    )
    assert selected["enabled"] is True
    assert selected["reason"] == "fallback_to_v15_long_policy_no_stronger_inner_floor"
    assert selected["threshold"] == 0.10
    assert selected["expected_net_floor_bps"] == 0.0


def test_v23_can_select_stronger_profitable_long_floor() -> None:
    expected = [0.10] * 10 + [1.50] * 12
    returns = [-0.001] * 10 + [0.001] * 9 + [-0.0005] * 3
    selected = v23.select_long_expected_net_floor(
        _scored(returns, expected),
        classification_choice={"threshold": 0.10},
    )
    assert selected["enabled"] is True
    assert selected["reason"] == "inner_only_long_expected_net_floor_selection"
    assert selected["expected_net_floor_bps"] > 0.0
    assert selected["trade_count"] >= v23.MIN_LONG_FLOOR_SELECTION_TRADES
    assert selected["total_return"] > 0.0
    assert (
        selected["profit_factor"] is None
        or selected["profit_factor"] >= v23.MIN_LONG_FLOOR_SELECTION_PROFIT_FACTOR
    )


def test_v23_keeps_locked_economic_and_outer_gates() -> None:
    assert v23.PAYOFF_RATIO_FLOOR == 1.15
    assert v23.MIN_LONG_FLOOR_SELECTION_PROFIT_FACTOR == 1.15
    assert v23.MIN_SHORT_SELECTION_PROFIT_FACTOR == 1.15
    assert v23.MIN_OUTER_TRADES == 20
    assert v23.MIN_PER_FOLD_TRADES == 3
    assert v23.MAX_FOLD_TRADE_CONCENTRATION == 0.80
    assert v23.LONG_EXPECTED_NET_FLOOR_GRID_BPS == (
        0.0,
        0.25,
        0.50,
        0.75,
        1.00,
        1.50,
        2.00,
    )
