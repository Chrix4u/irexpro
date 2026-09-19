"""Tests for chronological walk-forward validation."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.validation import (
    paper_evaluation_eligibility,
    summarize_walk_forward_metrics,
    walk_forward_splits,
)


def test_walk_forward_splits_expand_training_and_preserve_purge_gap():
    frame = pd.DataFrame(
        {
            "timestamp": pd.date_range(
                "2026-01-01",
                periods=100,
                freq="h",
                tz="UTC",
            ),
            "value": np.arange(100),
        }
    )

    folds = walk_forward_splits(
        frame,
        min_train_size=40,
        validation_size=10,
        purge_gap=3,
        step_size=10,
    )

    assert len(folds) == 5
    previous_train_size = 0

    for train, validation in folds:
        assert len(train) > previous_train_size
        previous_train_size = len(train)
        assert len(validation) == 10
        assert train["value"].max() + 4 == validation["value"].min()
        assert train["timestamp"].max() < validation["timestamp"].min()


def test_paper_evaluation_requires_multiple_structurally_valid_windows():
    valid_metrics = [
        {
            "sample_count": 100.0,
            "positive_rate": 0.5,
            "log_loss": 0.69,
            "brier_score": 0.25,
        }
        for _ in range(3)
    ]

    result = paper_evaluation_eligibility(
        window_metrics=valid_metrics,
        minimum_windows=3,
    )

    assert result["eligible_for_paper_evaluation"] is True
    assert result["reasons"] == []


def test_paper_evaluation_fails_when_window_has_one_target_class():
    metrics = [
        {
            "sample_count": 100.0,
            "positive_rate": 0.5,
            "log_loss": 0.69,
            "brier_score": 0.25,
        },
        {
            "sample_count": 100.0,
            "positive_rate": 1.0,
            "log_loss": 0.80,
            "brier_score": 0.30,
        },
        {
            "sample_count": 100.0,
            "positive_rate": 0.45,
            "log_loss": 0.70,
            "brier_score": 0.26,
        },
    ]

    result = paper_evaluation_eligibility(
        window_metrics=metrics,
        minimum_windows=3,
    )

    assert result["eligible_for_paper_evaluation"] is False
    assert any("does not contain both target classes" in reason for reason in result["reasons"])


def test_walk_forward_summary_reports_distribution_not_only_one_score():
    metrics = [
        {
            "accuracy": 0.52,
            "balanced_accuracy": 0.51,
            "precision": 0.53,
            "recall": 0.50,
            "f1": 0.51,
            "roc_auc": 0.54,
            "log_loss": 0.69,
            "brier_score": 0.25,
        },
        {
            "accuracy": 0.56,
            "balanced_accuracy": 0.55,
            "precision": 0.57,
            "recall": 0.54,
            "f1": 0.55,
            "roc_auc": 0.58,
            "log_loss": 0.67,
            "brier_score": 0.24,
        },
        {
            "accuracy": 0.50,
            "balanced_accuracy": 0.49,
            "precision": 0.51,
            "recall": 0.48,
            "f1": 0.49,
            "roc_auc": 0.52,
            "log_loss": 0.71,
            "brier_score": 0.26,
        },
    ]

    summary = summarize_walk_forward_metrics(metrics)

    assert summary["window_count"] == 3
    assert summary["balanced_accuracy_min"] == 0.49
    assert summary["balanced_accuracy_max"] == 0.55
    assert summary["log_loss_median"] == 0.69
