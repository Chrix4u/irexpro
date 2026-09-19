"""Tests for walk-forward validation and staging backtest diagnostics."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.validation import (
    compute_backtest_metrics,
    purged_walk_forward_splits,
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
