"""Tests for final multi-timeframe candidate packaging gates."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest

from app.domain.training.train_final_multitimeframe import (
    _chronological_final_split,
    _final_gate,
)


def _split_frame(periods: int = 700) -> pd.DataFrame:
    start = datetime(2026, 1, 5, 0, 0, tzinfo=UTC)
    return pd.DataFrame(
        {
            "decision_time": [
                start + timedelta(minutes=index) for index in range(periods)
            ],
            "instrument": [
                "EURUSD" if index % 2 == 0 else "GBPUSD"
                for index in range(periods)
            ],
            "target": [index % 2 for index in range(periods)],
        }
    )


def test_final_split_is_chronological_disjoint_and_purged():
    train, validation, test = _chronological_final_split(
        _split_frame(),
        horizon_bars=5,
    )

    assert train["decision_time"].max() < validation["decision_time"].min()
    assert validation["decision_time"].max() < test["decision_time"].min()

    train_gap = (
        validation["decision_time"].min() - train["decision_time"].max()
    ).total_seconds() / 60.0
    test_gap = (
        test["decision_time"].min() - validation["decision_time"].max()
    ).total_seconds() / 60.0

    assert train_gap > 5
    assert test_gap > 5
    assert set(train.index).isdisjoint(validation.index)
    assert set(validation.index).isdisjoint(test.index)


def test_final_split_rejects_too_few_periods():
    with pytest.raises(ValueError, match="At least 500 unique decision periods"):
        _chronological_final_split(
            _split_frame(periods=300),
            horizon_bars=5,
        )


def test_final_gate_requires_all_metrics_to_pass():
    passing = {
        "classification": {"balanced_accuracy": 0.55},
        "trading": {
            "sharpe_ratio": 1.2,
            "profit_factor": 1.25,
            "max_drawdown": 0.08,
        },
    }
    assert _final_gate(passing)["passed"] is True

    failing = {
        "classification": {"balanced_accuracy": 0.51},
        "trading": {
            "sharpe_ratio": 1.2,
            "profit_factor": 1.25,
            "max_drawdown": 0.08,
        },
    }
    result = _final_gate(failing)
    assert result["passed"] is False
    assert result["checks"]["balanced_accuracy"] is False
