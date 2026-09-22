"""Tests for feature engineering — anti-lookahead and basic correctness."""
from __future__ import annotations

import pytest

from app.domain.market_data.providers.mock_provider import MockMarketDataProvider
from app.domain.models.feature_engineering import (
    FEATURE_COLUMNS,
    candles_to_dataframe,
    compute_features,
    extract_latest_features,
)


@pytest.mark.asyncio
async def test_feature_engineering_no_future_leakage():
    """
    Anti-lookahead test: features computed on rows 0..N must not change
    when row N+1 is appended.
    """
    provider = MockMarketDataProvider()
    candles_21 = await provider.get_ohlcv("EURUSD", "H1", limit=21)

    # Use the same candle series — truncate in-memory rather than re-fetching with
    # a different limit (mock provider phase depends on limit, so re-fetching would
    # produce a different window shape, not an extra row).
    df_21 = candles_to_dataframe(candles_21)
    df_20 = candles_to_dataframe(candles_21[:20])

    feat_20 = compute_features(df_20)
    feat_21 = compute_features(df_21)

    # Row at index 19 in df_20 must match row at index 19 in df_21 for all features
    for col in FEATURE_COLUMNS:
        v20 = feat_20.iloc[19][col]
        v21 = feat_21.iloc[19][col]
        assert abs(v20 - v21) < 1e-9, (
            f"Lookahead detected in feature '{col}': "
            f"row 19 changed from {v20} to {v21} when row 20 was added"
        )

    for col in (
        "breakout_strength_20",
        "range_compression_5_20",
        "momentum_acceleration_3_10",
    ):
        v20 = feat_20.iloc[19][col]
        v21 = feat_21.iloc[19][col]
        assert abs(v20 - v21) < 1e-9, (
            f"Lookahead detected in MTF v3 feature '{col}': "
            f"row 19 changed from {v20} to {v21} when row 20 was added"
        )


@pytest.mark.asyncio
async def test_feature_columns_all_present():
    provider = MockMarketDataProvider()
    candles = await provider.get_ohlcv("EURUSD", "H1", limit=30)
    df = candles_to_dataframe(candles)
    result = compute_features(df)
    for col in FEATURE_COLUMNS:
        assert col in result.columns, f"Missing feature: {col}"


@pytest.mark.asyncio
async def test_no_nan_in_features_after_fill():
    provider = MockMarketDataProvider()
    candles = await provider.get_ohlcv("EURUSD", "H1", limit=30)
    df = candles_to_dataframe(candles)
    result = compute_features(df)
    for col in FEATURE_COLUMNS:
        assert not result[col].isna().any(), f"NaN found in feature '{col}'"


@pytest.mark.asyncio
async def test_extract_latest_features_returns_dict():
    provider = MockMarketDataProvider()
    candles = await provider.get_ohlcv("EURUSD", "H1", limit=30)
    df = candles_to_dataframe(candles)
    features = extract_latest_features(df)
    assert isinstance(features, dict)
    assert set(features.keys()) == set(FEATURE_COLUMNS)
