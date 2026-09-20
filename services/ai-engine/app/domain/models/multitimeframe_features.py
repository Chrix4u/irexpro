"""Shared multi-timeframe feature contract for training and runtime inference."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from app.domain.market_data.schemas import OHLCVCandle
from app.domain.models.feature_engineering import compute_features

RUNTIME_TIMEFRAMES = ("M1", "M5", "M15", "H1", "H4")
TIMEFRAME_MINUTES = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "H1": 60,
    "H4": 240,
}
INITIAL_FOREX_UNIVERSE = (
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
)
NORMALIZED_FEATURE_SUFFIXES = (
    "simple_return",
    "price_vs_ma20",
    "volatility_10",
    "candle_body",
    "volume_change",
    "range_pct",
    "ma5_vs_ma20",
    "ma10_vs_ma20",
    "log_tick_volume",
)
TIME_FEATURE_COLUMNS = (
    "minute_of_day_sin",
    "minute_of_day_cos",
    "day_of_week_sin",
    "day_of_week_cos",
)


def multitimeframe_feature_columns() -> list[str]:
    columns = [
        f"{timeframe.lower()}_{suffix}"
        for timeframe in RUNTIME_TIMEFRAMES
        for suffix in NORMALIZED_FEATURE_SUFFIXES
    ]
    columns.extend(["m1_spread_bps", *TIME_FEATURE_COLUMNS])
    columns.extend(f"instrument_{instrument}" for instrument in INITIAL_FOREX_UNIVERSE)
    return columns


MULTITIMEFRAME_FEATURE_COLUMNS = multitimeframe_feature_columns()


@dataclass(frozen=True)
class RuntimeFeatureBundle:
    features: dict[str, float]
    decision_time: datetime
    latest_m1: OHLCVCandle
    latest_by_timeframe: dict[str, OHLCVCandle]


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _closed_candles(
    candles: list[OHLCVCandle],
    timeframe: str,
    decision_time: datetime,
) -> list[OHLCVCandle]:
    duration = timedelta(minutes=TIMEFRAME_MINUTES[timeframe])
    decision = _as_utc(decision_time)
    ordered = sorted(candles, key=lambda candle: _as_utc(candle.timestamp))
    return [
        candle
        for candle in ordered
        if _as_utc(candle.timestamp) + duration <= decision
    ]


def _timeframe_frame(candles: list[OHLCVCandle]) -> pd.DataFrame:
    records = []
    for candle in candles:
        tick_volume = (
            float(candle.tick_volume)
            if candle.tick_volume is not None
            else float(candle.volume)
        )
        records.append(
            {
                "timestamp": _as_utc(candle.timestamp),
                "open": float(candle.open),
                "high": float(candle.high),
                "low": float(candle.low),
                "close": float(candle.close),
                "volume": tick_volume,
                "tick_volume": tick_volume,
            }
        )
    return pd.DataFrame.from_records(records).sort_values("timestamp").reset_index(drop=True)


def _latest_timeframe_features(
    candles: list[OHLCVCandle],
    timeframe: str,
    decision_time: datetime,
) -> tuple[dict[str, float], OHLCVCandle]:
    closed = _closed_candles(candles, timeframe, decision_time)
    if len(closed) < 20:
        raise ValueError(
            f"{timeframe} requires at least 20 fully closed candles; got {len(closed)}"
        )

    frame = _timeframe_frame(closed)
    featured = compute_features(frame)
    latest = featured.iloc[-1]
    eps = 1e-12

    close = float(latest["close"])
    high = float(latest["high"])
    low = float(latest["low"])
    ma5 = float(latest["ma_5"])
    ma10 = float(latest["ma_10"])
    ma20 = float(latest["ma_20"])
    tick_volume = max(float(latest["tick_volume"]), 0.0)

    values = {
        "simple_return": float(latest["simple_return"]),
        "price_vs_ma20": float(latest["price_vs_ma20"]),
        "volatility_10": float(latest["volatility_10"]),
        "candle_body": float(latest["candle_body"]),
        "volume_change": float(latest["volume_change"]),
        "range_pct": (high - low) / max(abs(close), eps),
        "ma5_vs_ma20": ma5 / max(abs(ma20), eps) - 1.0,
        "ma10_vs_ma20": ma10 / max(abs(ma20), eps) - 1.0,
        "log_tick_volume": float(np.log1p(tick_volume)),
    }

    if not np.isfinite(np.asarray(list(values.values()), dtype=float)).all():
        raise ValueError(f"{timeframe} runtime feature vector contains non-finite values")
    return values, closed[-1]


def build_multitimeframe_runtime_features(
    candles_by_timeframe: dict[str, list[OHLCVCandle]],
    *,
    instrument: str,
    now: datetime | None = None,
) -> RuntimeFeatureBundle:
    """Build the exact pooled-MTF feature vector using fully closed candles only."""
    symbol = instrument.upper()
    if symbol not in INITIAL_FOREX_UNIVERSE:
        raise ValueError(f"Unsupported initial-universe instrument: {symbol}")

    missing = [
        timeframe
        for timeframe in RUNTIME_TIMEFRAMES
        if timeframe not in candles_by_timeframe
    ]
    if missing:
        raise ValueError(f"Missing runtime timeframes: {missing}")

    observed_now = _as_utc(now or datetime.now(UTC))

    # Anchor every context feature to the availability of the latest fully
    # closed M1 bar. This mirrors the research decision-time contract.
    closed_m1 = _closed_candles(
        candles_by_timeframe["M1"],
        "M1",
        observed_now,
    )
    if len(closed_m1) < 20:
        raise ValueError(
            f"M1 requires at least 20 fully closed candles; got {len(closed_m1)}"
        )
    latest_m1 = closed_m1[-1]
    decision_time = _as_utc(latest_m1.timestamp) + timedelta(minutes=1)

    features: dict[str, float] = {}
    latest_by_timeframe: dict[str, OHLCVCandle] = {}

    for timeframe in RUNTIME_TIMEFRAMES:
        tf_values, latest_candle = _latest_timeframe_features(
            candles_by_timeframe[timeframe],
            timeframe,
            decision_time,
        )
        prefix = timeframe.lower()
        for suffix, value in tf_values.items():
            features[f"{prefix}_{suffix}"] = value
        latest_by_timeframe[timeframe] = latest_candle

    if latest_m1.spread_points is None or latest_m1.price_digits is None:
        raise ValueError(
            "M1 broker candle is missing spread_points/price_digits required "
            "for the trained friction-aware model"
        )
    if latest_m1.spread_points < 0:
        raise ValueError("M1 spread_points cannot be negative")
    if latest_m1.price_digits < 0 or latest_m1.price_digits > 12:
        raise ValueError("M1 price_digits must be between 0 and 12")

    point_size = 10.0 ** (-int(latest_m1.price_digits))
    spread_price = float(latest_m1.spread_points) * point_size
    if latest_m1.close <= 0:
        raise ValueError("M1 close must be positive")
    features["m1_spread_bps"] = spread_price / float(latest_m1.close) * 10_000.0

    minute_of_day = decision_time.hour * 60 + decision_time.minute
    features["minute_of_day_sin"] = float(
        np.sin(2.0 * np.pi * minute_of_day / 1440.0)
    )
    features["minute_of_day_cos"] = float(
        np.cos(2.0 * np.pi * minute_of_day / 1440.0)
    )
    day_of_week = decision_time.weekday()
    features["day_of_week_sin"] = float(
        np.sin(2.0 * np.pi * day_of_week / 7.0)
    )
    features["day_of_week_cos"] = float(
        np.cos(2.0 * np.pi * day_of_week / 7.0)
    )

    for candidate in INITIAL_FOREX_UNIVERSE:
        features[f"instrument_{candidate}"] = 1.0 if candidate == symbol else 0.0

    if list(features) != MULTITIMEFRAME_FEATURE_COLUMNS:
        raise ValueError("Runtime MTF feature order diverged from canonical schema")
    if not np.isfinite(np.asarray(list(features.values()), dtype=float)).all():
        raise ValueError("Runtime MTF feature vector contains non-finite values")

    return RuntimeFeatureBundle(
        features=features,
        decision_time=decision_time,
        latest_m1=latest_m1,
        latest_by_timeframe=latest_by_timeframe,
    )
