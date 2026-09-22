"""Chronological validation helpers for offline model training."""
from __future__ import annotations

import math

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


def purged_walk_forward_splits(
    df: pd.DataFrame,
    *,
    min_train_size: int,
    validation_size: int,
    purge_gap: int,
    embargo_gap: int = 0,
    max_splits: int | None = None,
) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    """
    Build expanding-window walk-forward folds with purge and embargo gaps.

    The purge sits between each training window and its validation window so a
    forward-return label cannot cross the fold boundary. The embargo separates
    consecutive validation windows. Later folds may legitimately train on old
    validation observations because those observations are historical by then.
    """
    if min_train_size < 1:
        raise ValueError("min_train_size must be at least 1")
    if validation_size < 1:
        raise ValueError("validation_size must be at least 1")
    if purge_gap < 0:
        raise ValueError("purge_gap cannot be negative")
    if embargo_gap < 0:
        raise ValueError("embargo_gap cannot be negative")
    if max_splits is not None and max_splits < 1:
        raise ValueError("max_splits must be at least 1 when provided")

    validation_start = min_train_size + purge_gap
    splits: list[tuple[pd.DataFrame, pd.DataFrame]] = []

    while validation_start + validation_size <= len(df):
        train_end = validation_start - purge_gap
        train = df.iloc[:train_end].copy()
        validation = df.iloc[
            validation_start : validation_start + validation_size
        ].copy()

        if train.empty or validation.empty:
            break

        splits.append((train, validation))
        if max_splits is not None and len(splits) >= max_splits:
            break

        validation_start += validation_size + embargo_gap

    if not splits:
        raise ValueError("Dataset is too small for requested walk-forward configuration")
    return splits




def iter_purged_walk_forward_time_splits(
    df: pd.DataFrame,
    *,
    time_column: str,
    min_train_periods: int,
    validation_periods: int,
    purge_periods: int,
    embargo_periods: int = 0,
    max_splits: int | None = None,
):
    """
    Yield expanding walk-forward splits one fold at a time.

    This is semantically identical to purged_walk_forward_time_splits but avoids
    retaining every expanding train/validation DataFrame copy simultaneously.
    That is important for pooled multi-instrument research where each fold can
    contain hundreds of thousands of rows.
    """
    if time_column not in df.columns:
        raise ValueError(f"Missing time column: {time_column}")
    if min_train_periods < 1:
        raise ValueError("min_train_periods must be at least 1")
    if validation_periods < 1:
        raise ValueError("validation_periods must be at least 1")
    if purge_periods < 0:
        raise ValueError("purge_periods cannot be negative")
    if embargo_periods < 0:
        raise ValueError("embargo_periods cannot be negative")
    if max_splits is not None and max_splits < 1:
        raise ValueError("max_splits must be at least 1 when provided")

    times = pd.Series(pd.to_datetime(df[time_column], utc=True, errors="coerce"))
    if times.isna().any():
        raise ValueError(f"{time_column} contains invalid timestamps")

    unique_times = pd.Index(times.drop_duplicates().sort_values())
    validation_start = min_train_periods + purge_periods
    yielded = 0

    while validation_start + validation_periods <= len(unique_times):
        train_end = validation_start - purge_periods
        train_last = unique_times[train_end - 1]
        validation_first = unique_times[validation_start]
        validation_last = unique_times[
            validation_start + validation_periods - 1
        ]

        # unique_times is sorted and contains every timestamp represented by
        # the pooled frame. Boundary comparisons therefore select the exact
        # same timestamp sets as the previous isin(train_times/validation_times)
        # implementation while avoiding two large temporary Index objects.
        train = df.loc[times <= train_last].copy()
        validation = df.loc[
            (times >= validation_first) & (times <= validation_last)
        ].copy()
        if train.empty or validation.empty:
            break

        yield train, validation
        yielded += 1
        if max_splits is not None and yielded >= max_splits:
            break

        validation_start += validation_periods + embargo_periods

    if yielded == 0:
        raise ValueError(
            "Dataset is too small for requested time-based walk-forward configuration"
        )


def purged_walk_forward_time_splits(
    df: pd.DataFrame,
    *,
    time_column: str,
    min_train_periods: int,
    validation_periods: int,
    purge_periods: int,
    embargo_periods: int = 0,
    max_splits: int | None = None,
) -> list[tuple[pd.DataFrame, pd.DataFrame]]:
    """
    Return expanding walk-forward splits based on unique decision timestamps.

    Compatibility wrapper around the lazy iterator. Existing callers that need
    a materialized list keep the same API and exact fold boundaries.
    """
    return list(
        iter_purged_walk_forward_time_splits(
            df,
            time_column=time_column,
            min_train_periods=min_train_periods,
            validation_periods=validation_periods,
            purge_periods=purge_periods,
            embargo_periods=embargo_periods,
            max_splits=max_splits,
        )
    )

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


def compute_backtest_metrics(
    net_returns: pd.Series | np.ndarray,
    *,
    annualization_factor: float,
) -> dict[str, float | int | None]:
    """
    Compute net-of-cost return diagnostics for model-gating backtests.

    net_returns must already include spread, commission, slippage, and any other
    execution-cost assumptions. The annualization factor must match the return
    sampling interval used by the backtest.
    """
    returns = np.asarray(net_returns, dtype=float)
    if len(returns) == 0:
        raise ValueError("net_returns must be non-empty")
    if not np.isfinite(returns).all():
        raise ValueError("net_returns contains non-finite values")
    if annualization_factor <= 0:
        raise ValueError("annualization_factor must be greater than zero")
    if (returns <= -1.0).any():
        raise ValueError("net_returns cannot be less than or equal to -100%")

    equity = np.cumprod(1.0 + returns)
    running_peak = np.maximum.accumulate(np.concatenate(([1.0], equity)))[1:]
    drawdowns = (equity / running_peak) - 1.0

    mean_return = float(returns.mean())
    sample_std = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    downside = returns[returns < 0]
    downside_std = float(downside.std(ddof=1)) if len(downside) > 1 else 0.0

    sharpe = (
        mean_return / sample_std * math.sqrt(annualization_factor)
        if sample_std > 0
        else None
    )
    sortino = (
        mean_return / downside_std * math.sqrt(annualization_factor)
        if downside_std > 0
        else None
    )

    gross_profit = float(returns[returns > 0].sum())
    gross_loss = float(-returns[returns < 0].sum())
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None

    return {
        "trade_or_period_count": int(len(returns)),
        "total_return": float(equity[-1] - 1.0),
        "average_net_return": mean_return,
        "median_net_return": float(np.median(returns)),
        "win_rate": float((returns > 0).mean()),
        "profit_factor": float(profit_factor) if profit_factor is not None else None,
        "sharpe_ratio": float(sharpe) if sharpe is not None else None,
        "sortino_ratio": float(sortino) if sortino is not None else None,
        "max_drawdown": float(abs(drawdowns.min())),
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
