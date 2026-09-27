"""Governance tests for USDJPY v19 rolling-window candidate."""
from __future__ import annotations

import pandas as pd

from app.domain.training import single_pair_v19_rolling_window as v19


def test_v19_rolling_window_trims_old_periods() -> None:
    frame = pd.DataFrame(
        {
            "decision_time": pd.date_range(
                "2026-01-01", periods=10, freq="min", tz="UTC"
            ),
            "instrument": ["USDJPY"] * 10,
            "value": list(range(10)),
        }
    )
    trimmed = v19._trim_to_recent_periods(frame, rolling_periods=4)
    assert len(trimmed) == 4
    assert trimmed["value"].tolist() == [6, 7, 8, 9]


def test_v19_keeps_locked_risk_and_evidence_gates() -> None:
    assert v19.PAYOFF_RATIO_FLOOR == 1.15
    assert v19.ROLLING_TRAIN_FRACTION == 0.20
    assert v19.OUTER_MIN_TRAIN_FRACTION == 0.40
    assert v19.OUTER_VALIDATION_FRACTION == 0.10
    assert v19.MIN_OUTER_TRADES == 30
    assert v19.MIN_PER_FOLD_TRADES == 5
    assert v19.MAX_FOLD_TRADE_CONCENTRATION == 0.80
