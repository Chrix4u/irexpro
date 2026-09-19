"""Chronological validation helpers for offline model training."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
)


def time_ordered_split(
    df: pd.DataFrame,
    train_ratio: float = 0.8,
    purge_gap: int = 0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Split by time order and optionally purge rows from the end of training.

    purge_gap should be at least the prediction horizon for supervised market
    labels so the last training labels cannot overlap the validation period.
    """
    if not 0.0 < train_ratio < 1.0:
        raise ValueError("train_ratio must be between 0 and 1")
    if purge_gap < 0:
        raise ValueError("purge_gap cannot be negative")
    if len(df) < 2:
        raise ValueError("Dataset too small for split")

    split_idx = int(len(df) * train_ratio)
    train_end = split_idx - purge_gap
    if train_end < 1 or split_idx >= len(df):
        raise ValueError("Split produced empty train or validation set")

    train = df.iloc[:train_end].copy()
    val = df.iloc[split_idx:].copy()
    return train, val


def compute_classification_metrics(
    y_true: pd.Series | np.ndarray,
    positive_probabilities: pd.Series | np.ndarray,
    threshold: float = 0.5,
) -> dict[str, float | None]:
    """Compute directional-classification metrics without making return claims."""
    y = np.asarray(y_true, dtype=int)
    probabilities = np.asarray(positive_probabilities, dtype=float)

    if len(y) == 0 or len(y) != len(probabilities):
        raise ValueError("Validation labels/probabilities must be non-empty and equal length")
    if not 0.0 < threshold < 1.0:
        raise ValueError("threshold must be between 0 and 1")

    probabilities = np.clip(probabilities, 1e-7, 1.0 - 1e-7)
    predictions = (probabilities >= threshold).astype(int)
    has_both_classes = len(np.unique(y)) == 2

    return {
        "accuracy": float(accuracy_score(y, predictions)),
        "balanced_accuracy": float(balanced_accuracy_score(y, predictions)),
        "precision": float(precision_score(y, predictions, zero_division=0)),
        "recall": float(recall_score(y, predictions, zero_division=0)),
        "f1": float(f1_score(y, predictions, zero_division=0)),
        "roc_auc": float(roc_auc_score(y, probabilities)) if has_both_classes else None,
        "log_loss": float(log_loss(y, probabilities, labels=[0, 1])),
        "brier_score": float(brier_score_loss(y, probabilities)),
        "sample_count": float(len(y)),
        "positive_rate": float(y.mean()),
    }


def compute_validation_metrics_placeholder(
    y_true: pd.Series,
    y_pred: pd.Series,
) -> dict[str, float]:
    """Backward-compatible helper retained for older callers/tests."""
    accuracy = float((y_true == y_pred).mean()) if len(y_true) else 0.0
    return {
        "accuracy_placeholder": accuracy,
        "sample_count": float(len(y_true)),
    }
