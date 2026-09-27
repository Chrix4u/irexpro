"""Governance tests for USDJPY v18 causal side-regime router."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training import single_pair_v18_regime_router as v18


def _frame() -> pd.DataFrame:
    n = 24
    trend = np.concatenate([
        np.linspace(-1.0, -0.2, 8),
        np.linspace(-0.1, 0.1, 8),
        np.linspace(0.2, 1.0, 8),
    ])
    vol = np.linspace(0.00005, 0.00020, n)
    return pd.DataFrame(
        {
            "trend_alignment_score": trend,
            "m1_volatility_20": vol,
            "long_action_probability": [0.20] * n,
            "short_action_probability": [0.20] * n,
            "long_expected_net_bps": [1.0] * n,
            "short_expected_net_bps": [1.0] * n,
            "long_payoff_ratio": [1.50] * n,
            "short_payoff_ratio": [1.50] * n,
            "event_long_net_return": [0.001] * 18 + [-0.0005] * 6,
            "event_short_net_return": [-0.0005] * 6 + [0.001] * 18,
        }
    )


def test_v18_router_uses_only_bounded_causal_regimes() -> None:
    router = v18.select_regime_router(_frame())
    assert set(router["boundaries"]) == {"trend_q33", "trend_q67", "vol_q50"}
    assert router["enabled_long_regimes"] >= 1
    assert router["enabled_short_regimes"] >= 1


def test_v18_keeps_economic_and_outer_gates_locked() -> None:
    assert v18.PAYOFF_RATIO_FLOOR == 1.15
    assert v18.MIN_REGIME_SELECTION_PROFIT_FACTOR == 1.15
    assert v18.MIN_OUTER_TRADES == 20
    assert v18.MIN_PER_FOLD_TRADES == 3
    assert v18.MAX_FOLD_TRADE_CONCENTRATION == 0.80
