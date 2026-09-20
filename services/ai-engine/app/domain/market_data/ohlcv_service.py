"""OHLCVService — orchestrates providers + Redis cache with validation."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from app.core.config import get_settings
from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.domain.market_data.providers.broker_provider import BrokerMarketDataProvider
from app.domain.market_data.providers.mock_provider import MockMarketDataProvider
from app.domain.market_data.redis_cache import OHLCVRedisCache
from app.domain.market_data.schemas import OHLCVCandle

logger = get_logger(__name__)

MIN_CANDLE_COUNT = 10
MarketDataSource = Literal["mock", "broker"]

TIMEFRAME_SECONDS: dict[str, int] = {
    "M1": 60,
    "M5": 5 * 60,
    "M15": 15 * 60,
    "M30": 30 * 60,
    "H1": 60 * 60,
    "H4": 4 * 60 * 60,
    "D1": 24 * 60 * 60,
}
BROKER_FRESHNESS_MULTIPLIER = 3
BROKER_FRESHNESS_MIN_OPEN_SECONDS = 15 * 60
BROKER_MAX_WALL_AGE_SECONDS = 7 * 24 * 60 * 60
MARKET_CLOCK_STEP = timedelta(minutes=15)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _looks_like_fx_symbol(instrument: str) -> bool:
    normalized = instrument.upper().replace("/", "")
    return len(normalized) == 6 and normalized.isalpha()


def _is_fx_market_open(timestamp: datetime) -> bool:
    timestamp = _as_utc(timestamp)
    weekday = timestamp.weekday()
    if weekday <= 3:
        return True
    if weekday == 4:
        # Use 21:00 UTC as the conservative Friday close across DST seasons.
        return timestamp.hour < 21
    if weekday == 5:
        return False
    # Use 22:00 UTC as the conservative Sunday reopen across DST seasons.
    return timestamp.hour >= 22


def _fx_market_open_elapsed_seconds(start: datetime, end: datetime) -> float:
    cursor = _as_utc(start)
    end = _as_utc(end)
    elapsed = 0.0
    while cursor < end:
        next_cursor = min(cursor + MARKET_CLOCK_STEP, end)
        midpoint = cursor + (next_cursor - cursor) / 2
        if _is_fx_market_open(midpoint):
            elapsed += (next_cursor - cursor).total_seconds()
        cursor = next_cursor
    return elapsed


class OHLCVService:
    """
    Fetches OHLCV candles from mock or broker sources.
    Uses Redis cache first; falls back to provider on cache miss.
    Validates candle ordering and data quality before returning.
    """

    def __init__(
        self,
        mock_provider: MockMarketDataProvider | None = None,
        broker_provider: BrokerMarketDataProvider | None = None,
        cache: OHLCVRedisCache | None = None,
    ) -> None:
        self._mock = mock_provider or MockMarketDataProvider()
        self._broker = broker_provider or BrokerMarketDataProvider()
        self._cache = cache or OHLCVRedisCache()

    async def get_ohlcv(
        self,
        source: MarketDataSource,
        instrument: str,
        timeframe: str,
        limit: int = 100,
        user_id: str | None = None,
        broker_connection_id: str | None = None,
        bypass_cache: bool = False,
    ) -> list[OHLCVCandle]:
        settings = get_settings()

        if source == "mock":
            if settings.is_production and not settings.ai_allow_mock_market_data:
                raise MarketDataError(
                    "Mock market data is blocked in production. "
                    "Set AI_ALLOW_MOCK_MARKET_DATA=true to override."
                )
        elif source == "broker":
            if not user_id or not broker_connection_id:
                raise MarketDataError("Broker source requires userId and brokerConnectionId")
        else:
            raise MarketDataError(f"Unknown market data source: {source}")

        if not bypass_cache:
            cached = await self._cache.get_cached_ohlcv(source, instrument, timeframe)
            if cached:
                return self._validate_candles(cached[-limit:], instrument, timeframe, source)

        if source == "mock":
            candles = await self._mock.get_ohlcv(instrument, timeframe, limit)
        else:
            candles = await self._broker.get_ohlcv(
                instrument,
                timeframe,
                limit,
                user_id=user_id,
                broker_connection_id=broker_connection_id,
            )

        validated = self._validate_candles(candles, instrument, timeframe, source)
        await self._cache.cache_ohlcv(source, instrument, timeframe, validated)
        return validated

    async def get_candles(
        self,
        instrument: str,
        timeframe: str,
        limit: int = 100,
        bypass_cache: bool = False,
        source: MarketDataSource = "mock",
        user_id: str | None = None,
        broker_connection_id: str | None = None,
    ) -> list[OHLCVCandle]:
        """Backward-compatible wrapper for mock/broker OHLCV fetch."""
        return await self.get_ohlcv(
            source=source,
            instrument=instrument,
            timeframe=timeframe,
            limit=limit,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
            bypass_cache=bypass_cache,
        )

    def _validate_candles(
        self,
        candles: list[OHLCVCandle],
        instrument: str,
        timeframe: str,
        source: MarketDataSource,
    ) -> list[OHLCVCandle]:
        if len(candles) < MIN_CANDLE_COUNT:
            raise MarketDataError(
                f"Insufficient candle data: {len(candles)} (minimum {MIN_CANDLE_COUNT} required)"
            )

        now = datetime.now(UTC)
        seen_timestamps: set[datetime] = set()
        sorted_candles = sorted(candles, key=lambda c: c.timestamp)

        for candle in sorted_candles:
            ts = candle.timestamp
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=UTC)
            if ts > now:
                raise MarketDataError("Candle timestamp is in the future")
            if ts in seen_timestamps:
                raise MarketDataError("Duplicate candle timestamps detected")
            seen_timestamps.add(ts)

        if source == "broker":
            latest = _as_utc(sorted_candles[-1].timestamp)
            wall_age_seconds = max(0.0, (now - latest).total_seconds())
            if wall_age_seconds > BROKER_MAX_WALL_AGE_SECONDS:
                raise MarketDataError(
                    "Broker market data is stale: latest candle is more than 7 days old"
                )

            timeframe_seconds = TIMEFRAME_SECONDS.get(timeframe.upper())
            if timeframe_seconds is None:
                raise MarketDataError(
                    f"Unsupported broker timeframe for freshness validation: {timeframe}"
                )

            allowed_open_age = max(
                BROKER_FRESHNESS_MIN_OPEN_SECONDS,
                timeframe_seconds * BROKER_FRESHNESS_MULTIPLIER,
            )
            open_age_seconds = (
                _fx_market_open_elapsed_seconds(latest, now)
                if _looks_like_fx_symbol(instrument)
                else wall_age_seconds
            )
            if open_age_seconds > allowed_open_age:
                raise MarketDataError(
                    "Broker market data is stale: latest candle is outside the "
                    f"{timeframe.upper()} freshness window"
                )

        return sorted_candles
