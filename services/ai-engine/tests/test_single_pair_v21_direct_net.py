"""Governance tests for USDJPY v21 direct-net candidate."""
from __future__ import annotations

import pandas as pd

from app.domain.training import single_pair_v21_direct_net as v21


def _scored(side: str, returns: list[float]) -> pd.DataFrame:
    n = len(returns)
    frame = pd.DataFrame(
        {
            "long_action_probability": [0.20] * n,
            "short_action_probability": [0.20] * n,
            "long_direct_net_bps": [1.0] * n,
            "short_direct_net_bps": [1.0] * n,
            "event_long_net_return": returns if side == "long" else [-0.001] * n,
            "event_short_net_return": returns if side == "short" else [-0.001] * n,
        }
    )
    return frame


def test_v21_disables_side_without_inner_economic_evidence() -> None:
    selected = v21.select_direct_net_side_policy(
        _scored("long", [-0.001] * 12),
        side="long",
    )
    assert selected["enabled"] is False


def test_v21_selects_profitable_direct_net_policy() -> None:
    selected = v21.select_direct_net_side_policy(
        _scored("short", [0.001] * 9 + [-0.0005] * 3),
        side="short",
    )
    assert selected["enabled"] is True
    assert selected["trade_count"] >= v21.MIN_SIDE_SELECTION_TRADES
    assert selected["total_return"] > 0.0
    assert (
        selected["profit_factor"] is None
        or selected["profit_factor"] >= v21.MIN_SIDE_SELECTION_PROFIT_FACTOR
    )


def test_v21_keeps_economic_and_outer_gates_locked() -> None:
    assert v21.MIN_SIDE_SELECTION_PROFIT_FACTOR == 1.15
    assert v21.MIN_OUTER_TRADES == 20
    assert v21.MIN_PER_FOLD_TRADES == 3
    assert v21.MAX_FOLD_TRADE_CONCENTRATION == 0.80
    assert v21.DIRECT_NET_FLOOR_GRID == (0.0, 0.25, 0.50, 1.00)
