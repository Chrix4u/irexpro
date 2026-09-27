"""Tests for USDJPY v16 two-sided economic regime governance."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training import single_pair_v16_two_sided_economic as v16


def _scored(long_returns: list[float], *, probability: float = 0.20) -> pd.DataFrame:
    rows = len(long_returns)
    return pd.DataFrame(
        {
            "long_action_probability": [probability] * rows,
            "long_expected_net_bps": [1.0] * rows,
            "long_payoff_ratio": [1.50] * rows,
            "event_long_net_return": long_returns,
            "m1_volatility_20": np.linspace(0.00005, 0.00020, rows),
            "h1_rsi_14": np.linspace(0.45, 0.90, rows),
        }
    )


def test_v16_long_selector_disables_side_without_inner_economic_evidence() -> None:
    selected = v16.select_long_regime_policy(_scored([-0.001] * 12))
    assert selected["enabled"] is False
    assert selected["reason"] == "no_inner_long_regime_candidate_met_economic_evidence"


def test_v16_long_selector_can_select_profitable_inner_policy() -> None:
    returns = [0.001] * 9 + [-0.0005] * 3
    selected = v16.select_long_regime_policy(_scored(returns))
    assert selected["enabled"] is True
    assert selected["trade_count"] >= v16.MIN_LONG_SELECTION_TRADES
    assert selected["total_return"] > 0.0
    assert (
        selected["profit_factor"] is None
        or selected["profit_factor"] >= v16.MIN_LONG_SELECTION_PROFIT_FACTOR
    )


def test_v16_governance_keeps_locked_economic_and_outer_gates() -> None:
    assert v16.PAYOFF_RATIO_FLOOR == 1.15
    assert v16.MIN_LONG_SELECTION_PROFIT_FACTOR == 1.15
    assert v16.MIN_SHORT_SELECTION_PROFIT_FACTOR == 1.15
    assert v16.MIN_OUTER_TRADES == 20
    assert v16.MIN_PER_FOLD_TRADES == 3
    assert v16.MAX_FOLD_TRADE_CONCENTRATION == 0.80
