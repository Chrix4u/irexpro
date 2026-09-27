"""Governance tests for USDJPY v22 rank-calibrated direct-net policy."""
from __future__ import annotations

import pandas as pd

from app.domain.training import single_pair_v22_rank_calibrated_net as v22


def _scored(side: str, returns: list[float], direct_values: list[float] | None = None) -> pd.DataFrame:
    n = len(returns)
    values = direct_values or list(range(n))
    return pd.DataFrame(
        {
            "long_action_probability": [0.20] * n,
            "short_action_probability": [0.20] * n,
            "long_direct_net_bps": values,
            "short_direct_net_bps": values,
            "event_long_net_return": returns if side == "long" else [-0.001] * n,
            "event_short_net_return": returns if side == "short" else [-0.001] * n,
        }
    )


def test_v22_disables_side_without_inner_economic_evidence() -> None:
    selected = v22.select_rank_policy(
        _scored("long", [-0.001] * 20),
        side="long",
    )
    assert selected["enabled"] is False


def test_v22_selects_profitable_rank_policy() -> None:
    returns = [-0.001] * 10 + [0.001] * 10
    selected = v22.select_rank_policy(
        _scored("short", returns, direct_values=list(range(20))),
        side="short",
    )
    assert selected["enabled"] is True
    assert selected["trade_count"] >= v22.MIN_SIDE_SELECTION_TRADES
    assert selected["total_return"] > 0.0
    assert (
        selected["profit_factor"] is None
        or selected["profit_factor"] >= v22.MIN_SIDE_SELECTION_PROFIT_FACTOR
    )


def test_v22_outer_cutoff_comes_from_refit_calibration_distribution() -> None:
    policy = {
        "enabled": True,
        "side": "long",
        "probability_threshold": 0.10,
        "direct_net_quantile": 0.95,
    }
    scored = pd.DataFrame(
        {
            "long_direct_net_bps": list(range(100)),
        }
    )
    calibrated = v22.calibrate_outer_rank_policy(
        scored,
        selected_policy=policy,
    )
    assert calibrated["outer_calibration_cutoff_bps"] == 94.05
    assert calibrated["outer_calibration_scale_bps"] > 0.0


def test_v22_keeps_rank_and_outer_gates_locked() -> None:
    assert v22.DIRECT_NET_QUANTILES == (0.95, 0.98, 0.99)
    assert v22.MIN_SIDE_SELECTION_PROFIT_FACTOR == 1.15
    assert v22.MIN_OUTER_TRADES == 20
    assert v22.MIN_PER_FOLD_TRADES == 3
    assert v22.MAX_FOLD_TRADE_CONCENTRATION == 0.80
