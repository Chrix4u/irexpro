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


def walk_forward_splits(
    df: pd.DataFrame,
    *,
    min_train_size: int,
    validation_size: int,
    purge_gap: int = 0,
    step_size: int | None = None,
) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    """
    Build expanding-window, chronological train/validation folds.

    Each fold trains on all data available before the validation window,
    removes purge_gap observations immediately before validation, and never
    shuffles or reuses future rows in the training set.
    """
    if min_train_size < 1:
        raise ValueError("min_train_size must be at least 1")
    if validation_size < 1:
        raise ValueError("validation_size must be at least 1")
    if purge_gap < 0:
        raise ValueError("purge_gap cannot be negative")

    step = validation_size if step_size is None else step_size
    if step < 1:
        raise ValueError("step_size must be at least 1")

    first_validation_start = min_train_size + purge_gap
    if first_validation_start + validation_size > len(df):
        raise ValueError("Dataset too small for requested walk-forward configuration")

    folds: list[tuple[pd.DataFrame, pd.DataFrame]] = []
    validation_start = first_validation_start

    while validation_start + validation_size <= len(df):
        train_end = validation_start - purge_gap
        train = df.iloc[:train_end].copy()
        validation = df.iloc[
            validation_start : validation_start + validation_size
        ].copy()
        folds.append((train, validation))
        validation_start += step

    return folds


def summarize_walk_forward_metrics(
    window_metrics: list[dict[str, float | None]],
) -> dict[str, float | int | None | str]:
    """Summarize validation windows without turning metrics into profit claims."""
    if not window_metrics:
        raise ValueError("At least one walk-forward validation window is required")

    metric_names = (
        "accuracy",
        "balanced_accuracy",
        "precision",
        "recall",
        "f1",
        "roc_auc",
        "log_loss",
        "brier_score",
    )
    summary: dict[str, float | int | None | str] = {
        "status": "complete",
        "window_count": len(window_metrics),
    }

    for name in metric_names:
        values = [
            float(window[name])
            for window in window_metrics
            if window.get(name) is not None and np.isfinite(float(window[name]))
        ]
        if not values:
            summary[f"{name}_mean"] = None
            summary[f"{name}_median"] = None
            summary[f"{name}_min"] = None
            summary[f"{name}_max"] = None
            continue

        array = np.asarray(values, dtype=float)
        summary[f"{name}_mean"] = float(array.mean())
        summary[f"{name}_median"] = float(np.median(array))
        summary[f"{name}_min"] = float(array.min())
        summary[f"{name}_max"] = float(array.max())

    return summary


def paper_evaluation_eligibility(
    *,
    window_metrics: list[dict[str, float | None]],
    minimum_windows: int = 3,
) -> dict[str, object]:
    """
    Determine whether validation evidence is structurally sufficient for paper evaluation.

    This gate does not claim model quality, profitability, or live suitability.
    It only verifies that the candidate was evaluated across multiple chronological
    windows with both classes represented and finite probability-loss metrics.
    """
    reasons: list[str] = []

    if minimum_windows < 2:
        raise ValueError("minimum_windows must be at least 2")
    if len(window_metrics) < minimum_windows:
        reasons.append(
            f"requires at least {minimum_windows} walk-forward windows; "
            f"received {len(window_metrics)}"
        )

    for index, metrics in enumerate(window_metrics, start=1):
        sample_count = float(metrics.get("sample_count") or 0.0)
        positive_rate = float(metrics.get("positive_rate") or 0.0)
        log_loss_value = metrics.get("log_loss")
        brier_value = metrics.get("brier_score")

        if sample_count <= 0:
            reasons.append(f"window {index} has no validation samples")
        if not 0.0 < positive_rate < 1.0:
            reasons.append(f"window {index} does not contain both target classes")
        if log_loss_value is None or not np.isfinite(float(log_loss_value)):
            reasons.append(f"window {index} has invalid log_loss")
        if brier_value is None or not np.isfinite(float(brier_value)):
            reasons.append(f"window {index} has invalid brier_score")

    return {
        "eligible_for_paper_evaluation": not reasons,
        "minimum_windows": minimum_windows,
        "observed_windows": len(window_metrics),
        "reasons": reasons,
        "note": (
            "Eligibility confirms validation-process completeness only; it is not "
            "evidence of profitability or live-trading suitability."
        ),
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
