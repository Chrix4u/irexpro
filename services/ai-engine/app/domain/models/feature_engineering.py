"""
Feature engineering for the AI Signal Engine.

IMPORTANT WARNINGS:
1. These features are BASELINE ONLY — not a profitable trading strategy.
2. No lookahead bias is permitted: features must use only data available
   at the time of the candle being evaluated (index i uses data [0..i] only).
3. Features are inputs to the model, not trading signals.
4. Do not overfit to historical data.
5. Do not present these as predictive of profitable outcomes.
"""
from __future__ import annotations

import pandas as pd

from app.domain.market_data.schemas import OHLCVCandle


def candles_to_dataframe(candles: list[OHLCVCandle]) -> pd.DataFrame:
    """Convert a list of OHLCVCandle to a pandas DataFrame, sorted by timestamp."""
    records = [
        {
            "timestamp": c.timestamp,
            "open": c.open,
            "high": c.high,
            "low": c.low,
            "close": c.close,
            "volume": c.volume,
        }
        for c in candles
    ]
    df = pd.DataFrame(records).sort_values("timestamp").reset_index(drop=True)
    return df


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute basic technical features.

    All rolling calculations use only past data (shift or min_periods ensures this).
    No future data leakage is possible in this implementation.

    Features:
    - simple_return: (close - prev_close) / prev_close
    - ma_5, ma_10, ma_20: simple moving averages
    - price_vs_ma20: (close - ma_20) / ma_20  — momentum proxy
    - volatility_10: rolling std of simple returns over 10 bars
    - candle_body: abs(close - open) / (high - low + 1e-10)  — candle body ratio
    - hl_range: (high - low)  — candle range
    - volume_change: (volume - prev_volume) / (prev_volume + 1e-10)
    """
    result = df.copy()

    # Avoid division by zero throughout
    eps = 1e-10

    # Simple return (no lookahead: uses only current and prior close)
    result["simple_return"] = result["close"].pct_change()

    # Moving averages (min_periods prevents NaN-based cheating)
    result["ma_5"] = result["close"].rolling(5, min_periods=1).mean()
    result["ma_10"] = result["close"].rolling(10, min_periods=1).mean()
    result["ma_20"] = result["close"].rolling(20, min_periods=1).mean()

    # Price relative to MA20 — trend direction proxy
    result["price_vs_ma20"] = (result["close"] - result["ma_20"]) / (result["ma_20"] + eps)

    # Rolling volatility of returns (10-bar window, no lookahead)
    result["volatility_10"] = result["simple_return"].rolling(10, min_periods=2).std()

    # Candle body size relative to full range
    range_ = (result["high"] - result["low"]).clip(lower=eps)
    result["candle_body"] = (result["close"] - result["open"]).abs() / range_

    # High-low range
    result["hl_range"] = result["high"] - result["low"]

    # Volume change
    result["volume_change"] = result["volume"].pct_change()

    # Richer causal features used by the multi-timeframe v2 model. These are
    # computed here so offline corpus construction and runtime inference share
    # exactly the same formulas. FEATURE_COLUMNS below intentionally remains
    # the legacy single-timeframe contract.
    result["momentum_3"] = result["close"].pct_change(3)
    result["momentum_5"] = result["close"].pct_change(5)
    result["momentum_10"] = result["close"].pct_change(10)
    result["volatility_20"] = result["simple_return"].rolling(20, min_periods=3).std()
    result["signed_candle_body"] = (result["close"] - result["open"]) / range_

    previous_close = result["close"].shift(1)
    true_range = pd.concat(
        [
            result["high"] - result["low"],
            (result["high"] - previous_close).abs(),
            (result["low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr_14 = true_range.rolling(14, min_periods=2).mean()
    result["atr_pct_14"] = atr_14 / (result["close"].abs() + eps)

    delta = result["close"].diff()
    average_gain = delta.clip(lower=0.0).rolling(14, min_periods=2).mean()
    average_loss = (-delta.clip(upper=0.0)).rolling(14, min_periods=2).mean()
    result["rsi_14"] = average_gain / (average_gain + average_loss + eps)

    rolling_low = result["low"].rolling(20, min_periods=2).min()
    rolling_high = result["high"].rolling(20, min_periods=2).max()
    result["close_position_20"] = (
        2.0
        * (result["close"] - rolling_low)
        / (rolling_high - rolling_low + eps)
        - 1.0
    )

    volume_mean = result["volume"].rolling(20, min_periods=3).mean()
    volume_std = result["volume"].rolling(20, min_periods=3).std()
    result["volume_zscore_20"] = (
        (result["volume"] - volume_mean) / (volume_std + eps)
    ).clip(lower=-10.0, upper=10.0)

    range_pct = range_ / (result["close"].abs() + eps)
    rolling_range = range_pct.rolling(20, min_periods=3).mean()
    result["range_expansion_20"] = range_pct / (rolling_range + eps) - 1.0

    # Causal market-structure features for the MTF v3 research contract.
    # The breakout reference explicitly excludes the current candle via shift(1),
    # so the current close is compared only with a range that was already known.
    prior_high_20 = result["high"].shift(1).rolling(20, min_periods=5).max()
    prior_low_20 = result["low"].shift(1).rolling(20, min_periods=5).min()
    breakout_strength = pd.Series(0.0, index=result.index, dtype=float)
    breakout_up = result["close"] > prior_high_20
    breakout_down = result["close"] < prior_low_20
    breakout_strength.loc[breakout_up] = (
        (result.loc[breakout_up, "close"] - prior_high_20.loc[breakout_up])
        / (atr_14.loc[breakout_up] + eps)
    )
    breakout_strength.loc[breakout_down] = (
        (result.loc[breakout_down, "close"] - prior_low_20.loc[breakout_down])
        / (atr_14.loc[breakout_down] + eps)
    )
    result["breakout_strength_20"] = breakout_strength.clip(lower=-10.0, upper=10.0)

    short_range = range_pct.rolling(5, min_periods=3).mean()
    long_range = range_pct.rolling(20, min_periods=5).mean()
    result["range_compression_5_20"] = (
        short_range / (long_range + eps) - 1.0
    ).clip(lower=-10.0, upper=10.0)

    result["momentum_acceleration_3_10"] = (
        result["momentum_3"] / 3.0 - result["momentum_10"] / 10.0
    ).clip(lower=-1.0, upper=1.0)

    # Fill remaining NaNs with neutral values. The legacy single-timeframe
    # contract stays unchanged while MTF v2 consumes the extra columns below.
    feature_cols = [
        "simple_return", "ma_5", "ma_10", "ma_20",
        "price_vs_ma20", "volatility_10", "candle_body", "hl_range", "volume_change",
        "momentum_3", "momentum_5", "momentum_10", "volatility_20",
        "signed_candle_body", "atr_pct_14", "rsi_14", "close_position_20",
        "volume_zscore_20", "range_expansion_20", "breakout_strength_20",
        "range_compression_5_20", "momentum_acceleration_3_10",
    ]
    result[feature_cols] = result[feature_cols].fillna(0.0)

    return result


FEATURE_COLUMNS = [
    "simple_return",
    "ma_5",
    "ma_10",
    "ma_20",
    "price_vs_ma20",
    "volatility_10",
    "candle_body",
    "hl_range",
    "volume_change",
]


def extract_latest_features(df: pd.DataFrame) -> dict[str, float]:
    """Extract the most recent row's features as a dict."""
    featured = compute_features(df)
    last = featured.iloc[-1]
    return {col: float(last[col]) for col in FEATURE_COLUMNS}
