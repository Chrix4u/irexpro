"""Governance tests for USDJPY v20 rolling economic candidate."""
from __future__ import annotations

import pandas as pd

from app.domain.training import single_pair_v20_rolling_economic as v20


def test_v20_recent_trim_uses_latest_periods() -> None:
    frame = pd.DataFrame(
        {
            "decision_time": pd.date_range(
                "2026-01-01", periods=8, freq="min", tz="UTC"
            ),
            "instrument": ["USDJPY"] * 8,
            "value": list(range(8)),
        }
    )
    trimmed = v20._trim_recent(frame, 3)
    assert trimmed["value"].tolist() == [5, 6, 7]


def test_v20_keeps_locked_economic_gates() -> None:
    assert v20.PAYOFF_RATIO_FLOOR == 1.15
    assert v20.ROLLING_TRAIN_FRACTION == 0.20
    assert v20.MIN_OUTER_TRADES == 20
    assert v20.MIN_PER_FOLD_TRADES == 3
    assert v20.MAX_FOLD_TRADE_CONCENTRATION == 0.80
