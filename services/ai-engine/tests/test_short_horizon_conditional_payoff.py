from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.short_horizon_conditional_payoff import (
    _conditional_severity_targets,
    score_conditional_payoff,
)


def _event_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "decision_time": pd.date_range("2026-01-01", periods=4, freq="min", tz="UTC"),
            "instrument": ["EURUSD"] * 4,
            "event_actionable_target": [1, 1, 0, 1],
            "event_direction_target": [1, 0, 1, 1],
            "event_barrier_return": [0.0002] * 4,
            "event_long_net_return": [0.0004, -0.0003, 0.0001, 0.0002],
            "event_short_net_return": [-0.0002, 0.0005, -0.0001, -0.0004],
        }
    )


def test_conditional_severity_targets_use_only_matching_event_rows() -> None:
    targets = _conditional_severity_targets(_event_frame())

    assert targets["long_favorable"].row_index.tolist() == [0, 3]
    assert targets["long_adverse"].row_index.tolist() == [1]
    assert targets["short_favorable"].row_index.tolist() == [1]
    assert targets["short_adverse"].row_index.tolist() == [0, 3]
    assert targets["long_favorable"].values.tolist() == pytest.approx([2.0, 1.0])
    assert targets["long_adverse"].values.tolist() == pytest.approx([1.5])
    assert targets["short_favorable"].values.tolist() == pytest.approx([2.5])
    assert targets["short_adverse"].values.tolist() == pytest.approx([1.0, 2.0])


def test_payoff_score_chooses_higher_expected_net_not_higher_probability() -> None:
    score = score_conditional_payoff(
        long_probability=np.array([0.40]),
        short_probability=np.array([0.60]),
        long_favorable_severity=np.array([3.0]),
        long_adverse_severity=np.array([0.5]),
        short_favorable_severity=np.array([0.8]),
        short_adverse_severity=np.array([2.0]),
    )

    assert score.long_expected_net.tolist() == pytest.approx([0.90])
    assert score.short_expected_net.tolist() == pytest.approx([-0.32])
    assert score.predicted_long.tolist() == [True]
    assert score.selected_expected_net.tolist() == pytest.approx([0.90])
    assert score.selected_payoff_ratio.tolist() == pytest.approx([4.0])


def test_payoff_score_rejects_non_finite_or_negative_severity() -> None:
    with pytest.raises(ValueError, match="finite non-negative"):
        score_conditional_payoff(
            long_probability=np.array([0.5]),
            short_probability=np.array([0.5]),
            long_favorable_severity=np.array([np.nan]),
            long_adverse_severity=np.array([0.5]),
            short_favorable_severity=np.array([0.5]),
            short_adverse_severity=np.array([0.5]),
        )

    with pytest.raises(ValueError, match="finite non-negative"):
        score_conditional_payoff(
            long_probability=np.array([0.5]),
            short_probability=np.array([0.5]),
            long_favorable_severity=np.array([-0.1]),
            long_adverse_severity=np.array([0.5]),
            short_favorable_severity=np.array([0.5]),
            short_adverse_severity=np.array([0.5]),
        )
