"""Tests for walk-forward validation and staging backtest diagnostics."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.validation import (
    compute_backtest_metrics,
    purged_walk_forward_splits,
    purged_walk_forward_time_splits,
)


def test_purged_walk_forward_splits_preserve_purge_and_embargo():
    frame = pd.DataFrame({"row_id": np.arange(40)})

    splits = purged_walk_forward_splits(
        frame,
        min_train_size=12,
        validation_size=5,
        purge_gap=3,
        embargo_gap=2,
        max_splits=3,
    )

    assert len(splits) == 3

    first_train, first_validation = splits[0]
    second_train, second_validation = splits[1]

    assert first_train["row_id"].tolist() == list(range(12))
    assert first_validation["row_id"].tolist() == list(range(15, 20))

    assert second_train["row_id"].tolist() == list(range(19))
    assert second_validation["row_id"].tolist() == list(range(22, 27))

    assert first_train["row_id"].max() + 3 < first_validation["row_id"].min()
    assert first_validation["row_id"].max() + 2 < second_validation["row_id"].min()


def test_compute_backtest_metrics_reports_risk_and_return_diagnostics():
    returns = np.array([0.01, -0.004, 0.006, -0.003, 0.008, 0.002])

    metrics = compute_backtest_metrics(
        returns,
        annualization_factor=252.0,
    )

    assert metrics["trade_or_period_count"] == 6
    assert metrics["total_return"] > 0
    assert metrics["average_net_return"] > 0
    assert 0 < metrics["win_rate"] < 1
    assert metrics["profit_factor"] is not None
    assert metrics["profit_factor"] > 1
    assert metrics["sharpe_ratio"] is not None
    assert metrics["max_drawdown"] > 0


def test_time_based_walk_forward_counts_unique_minutes_not_rows():
    frame = pd.DataFrame(
        {
            "decision_time": list(pd.date_range("2026-01-01", periods=12, freq="min", tz="UTC"))
            * 2,
            "instrument": ["EURUSD"] * 12 + ["USDJPY"] * 12,
        }
    ).sort_values(["decision_time", "instrument"]).reset_index(drop=True)

    splits = purged_walk_forward_time_splits(
        frame,
        time_column="decision_time",
        min_train_periods=5,
        validation_periods=2,
        purge_periods=1,
        embargo_periods=1,
        max_splits=2,
    )

    first_train, first_validation = splits[0]
    second_train, second_validation = splits[1]

    assert first_train["decision_time"].nunique() == 5
    assert first_validation["decision_time"].nunique() == 2
    assert first_train["instrument"].nunique() == 2
    assert first_validation["instrument"].nunique() == 2
    assert first_train["decision_time"].max() < first_validation["decision_time"].min()

    assert second_train["decision_time"].nunique() == 8
    assert second_validation["decision_time"].nunique() == 2
