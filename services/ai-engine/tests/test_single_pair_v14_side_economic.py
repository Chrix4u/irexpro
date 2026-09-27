from __future__ import annotations

import pandas as pd

from app.domain.training.single_pair_v14_side_economic import (
    _candidate_report,
    select_economic_side_thresholds,
)


def _frame() -> pd.DataFrame:
    rows = []
    for i in range(40):
        long_win = i % 4 == 0
        short_win = i % 5 == 0
        rows.append(
            {
                "decision_time": f"2026-01-01T00:{i:02d}:00Z",
                "instrument": "USDJPY",
                "event_long_actionable_target": int(long_win),
                "event_short_actionable_target": int(short_win),
                "event_long_net_return": 0.001 if long_win else -0.0002,
                "event_short_net_return": 0.001 if short_win else -0.0002,
                "long_action_probability": 0.18 if long_win else 0.03,
                "short_action_probability": 0.18 if short_win else 0.03,
                "long_expected_upside_bps": 2.0 if long_win else 0.2,
                "long_expected_downside_bps": 0.5 if long_win else 0.8,
                "short_expected_upside_bps": 2.0 if short_win else 0.2,
                "short_expected_downside_bps": 0.5 if short_win else 0.8,
                "long_expected_net_bps": 1.5 if long_win else -0.6,
                "short_expected_net_bps": 1.5 if short_win else -0.6,
                "long_payoff_ratio": 4.0 if long_win else 0.25,
                "short_payoff_ratio": 4.0 if short_win else 0.25,
            }
        )
    return pd.DataFrame(rows)


def test_candidate_requires_two_sided_inner_evidence() -> None:
    report = _candidate_report(_frame(), long_threshold=0.04, short_threshold=0.04)
    assert report["trading"]["long_trades"] > 0
    assert report["trading"]["short_trades"] > 0
    assert report["eligible"] is True


def test_selector_returns_economic_two_sided_threshold_pair() -> None:
    result = select_economic_side_thresholds(_frame())
    assert result["selected"] is not None
    selected = result["selected"]
    assert selected["eligible"] is True
    assert selected["trading"]["long_trades"] >= 2
    assert selected["trading"]["short_trades"] >= 2
