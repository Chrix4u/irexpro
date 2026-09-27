"""Tests for USDJPY v15 short-regime research governance."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training import single_pair_v15_short_regime as v15


def _scored(short_returns: list[float], *, short_probability: float = 0.20) -> pd.DataFrame:
    rows = len(short_returns)
    return pd.DataFrame(
        {
            "short_action_probability": [short_probability] * rows,
            "short_expected_net_bps": [1.0] * rows,
            "short_payoff_ratio": [1.50] * rows,
            "event_short_net_return": short_returns,
            "m1_volatility_20": np.linspace(0.00005, 0.00020, rows),
            "h1_rsi_14": np.linspace(0.45, 0.90, rows),
        }
    )


def test_v15_short_selector_disables_side_without_inner_economic_evidence() -> None:
    scored = _scored([-0.001] * 12)
    selected = v15.select_short_regime_policy(scored)

    assert selected["enabled"] is False
    assert selected["reason"] == "no_inner_short_regime_candidate_met_economic_evidence"


def test_v15_short_selector_can_select_profitable_inner_short_policy() -> None:
    returns = [0.001] * 9 + [-0.0005] * 3
    scored = _scored(returns)
    selected = v15.select_short_regime_policy(scored)

    assert selected["enabled"] is True
    assert selected["trade_count"] >= v15.MIN_SHORT_SELECTION_TRADES
    assert selected["total_return"] > 0.0
    assert (
        selected["profit_factor"] is None
        or selected["profit_factor"] >= v15.MIN_SHORT_SELECTION_PROFIT_FACTOR
    )


def test_v15_governance_keeps_locked_economic_floor_and_research_only_output(monkeypatch) -> None:
    assert v15.PAYOFF_RATIO_FLOOR == 1.15
    assert v15.MIN_SHORT_SELECTION_PROFIT_FACTOR == 1.15
    assert v15.MIN_OUTER_TRADES == 20
    assert v15.MIN_PER_FOLD_TRADES == 3
