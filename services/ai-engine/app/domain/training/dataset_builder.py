"""
Offline dataset construction for XGBoost research/training.

The training dataset is built from historical OHLCV only. Feature rows at
index i may use candles [0..i]; labels may use future candles solely as the
supervised target and are never included in inference features.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from app.domain.models import feature_engineering


REQUIRED_OHLCV_COLUMNS = {"timestamp", "open", "high", "low", "close", "volume"}
TARGET_COLUMN = "target"
FUTURE_RETURN_COLUMN = "future_return"


def load_ohlcv_csv(path: str | Path) -> pd.DataFrame:
    """Load and validate historical OHLCV CSV data."""
    df = pd.read_csv(path, parse_dates=["timestamp"])
    missing = REQUIRED_OHLCV_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"Dataset missing columns: {sorted(missing)}")

    df = df.sort_values("timestamp").reset_index(drop=True)
    if df.empty:
        raise ValueError("Dataset is empty")
    if df["timestamp"].isna().any():
        raise ValueError("Dataset contains invalid timestamps")
    if df["timestamp"].duplicated().any():
        raise ValueError("Dataset contains duplicate timestamps")

    numeric_columns = ["open", "high", "low", "close", "volume"]
    for column in numeric_columns:
        df[column] = pd.to_numeric(df[column], errors="coerce")

    if df[numeric_columns].isna().any().any():
        raise ValueError("Dataset contains non-numeric OHLCV values")
    if not np.isfinite(df[numeric_columns].to_numpy(dtype=float)).all():
        raise ValueError("Dataset contains non-finite OHLCV values")
    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        raise ValueError("OHLC prices must be greater than zero")
    if (df["volume"] < 0).any():
        raise ValueError("Volume cannot be negative")
    if (df["high"] < df[["open", "close", "low"]].max(axis=1)).any():
        raise ValueError("Dataset contains invalid candle highs")
    if (df["low"] > df[["open", "close", "high"]].min(axis=1)).any():
        raise ValueError("Dataset contains invalid candle lows")

    return df


def build_feature_rows(df: pd.DataFrame, min_history: int = 20) -> pd.DataFrame:
    """
    Build feature rows without lookahead.

    compute_features() uses rolling/current-and-past values only. Building the
    full frame is equivalent to evaluating each prefix independently, while
    avoiding the previous O(n^2) training cost.
    """
    if min_history < 1:
        raise ValueError("min_history must be at least 1")
    if len(df) <= min_history:
        raise ValueError("Dataset is too small for requested feature history")

    featured = feature_engineering.compute_features(df)
    rows = featured.loc[:, feature_engineering.FEATURE_COLUMNS].copy()
    rows["target_index"] = np.arange(len(df))
    rows["timestamp"] = df["timestamp"].values
    return rows.iloc[min_history:].reset_index(drop=True)


def build_supervised_dataset(
    df: pd.DataFrame,
    *,
    horizon_bars: int = 3,
    neutral_return_threshold: float = 0.0002,
    min_history: int = 20,
) -> pd.DataFrame:
    """
    Build a binary directional training dataset.

    target=1 means the close horizon_bars in the future is above the current
    close by more than the neutral threshold. target=0 means it is below by
    more than the threshold. Near-flat observations are excluded rather than
    forcing noisy labels.

    Future values are used only to construct the target and future_return
    research columns; neither is part of FEATURE_COLUMNS.
    """
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be at least 1")
    if neutral_return_threshold < 0:
        raise ValueError("neutral_return_threshold cannot be negative")
    if len(df) <= min_history + horizon_bars:
        raise ValueError("Dataset is too small for requested history and horizon")

    rows = build_feature_rows(df, min_history=min_history)
    source_indices = rows["target_index"].astype(int)

    current_close = df.loc[source_indices, "close"].to_numpy(dtype=float)
    future_close = df["close"].shift(-horizon_bars).loc[source_indices].to_numpy(dtype=float)
    future_return = (future_close / current_close) - 1.0

    rows[FUTURE_RETURN_COLUMN] = future_return
    rows = rows[np.isfinite(rows[FUTURE_RETURN_COLUMN])].copy()

    if neutral_return_threshold > 0:
        rows = rows[
            rows[FUTURE_RETURN_COLUMN].abs() >= neutral_return_threshold
        ].copy()

    rows[TARGET_COLUMN] = (rows[FUTURE_RETURN_COLUMN] > 0).astype(int)
    return rows.reset_index(drop=True)


def detect_future_leakage(feature_df: pd.DataFrame) -> bool:
    """
    Detect basic row-order leakage indicators.

    This is a structural guard, not a proof that arbitrary user-defined
    features are leakage free.
    """
    if "target_index" not in feature_df.columns:
        return True
    indices = feature_df["target_index"].tolist()
    return indices != sorted(indices)
