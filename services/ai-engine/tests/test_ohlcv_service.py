"""Tests for expanded OHLCVService."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest

from app.core.config import Settings
from app.core.errors import MarketDataError
from app.domain.market_data.ohlcv_service import OHLCVService
from app.domain.market_data.providers.mock_provider import MockMarketDataProvider
from app.domain.market_data.redis_cache import OHLCVRedisCache
from app.domain.market_data.schemas import OHLCVCandle


@pytest.mark.asyncio
async def test_mock_source_returns_validated_candles():
    service = OHLCVService(
        mock_provider=MockMarketDataProvider(),
        cache=OHLCVRedisCache(redis_client=None),
    )
    candles = await service.get_ohlcv("mock", "EURUSD", "H1", limit=100)
    assert len(candles) >= 10


@pytest.mark.asyncio
async def test_mock_blocked_in_production_without_flag():
    service = OHLCVService(cache=OHLCVRedisCache(redis_client=None))
    settings = Settings(ai_engine_env="production", ai_allow_mock_market_data=False)
    with patch("app.domain.market_data.ohlcv_service.get_settings", return_value=settings):
        with pytest.raises(MarketDataError, match="blocked in production"):
            await service.get_ohlcv("mock", "EURUSD", "H1")


@pytest.mark.asyncio
async def test_broker_source_requires_user_and_connection():
    service = OHLCVService(cache=OHLCVRedisCache(redis_client=None))
    with pytest.raises(MarketDataError, match="requires userId"):
        await service.get_ohlcv("broker", "EURUSD", "H1")


@pytest.mark.asyncio
async def test_cache_hit_skips_provider():
    redis = AsyncMock()
    cache = OHLCVRedisCache(redis_client=redis)
    service = OHLCVService(mock_provider=MockMarketDataProvider(), cache=cache)

    candles = await service.get_ohlcv("mock", "EURUSD", "H1", limit=100)
    await cache.cache_ohlcv("mock", "EURUSD", "H1", candles)

    import json

    payload = json.dumps({
        "cached_at": datetime.now(UTC).isoformat(),
        "expires_at": datetime.now(UTC).timestamp() + 300,
        "candles": [c.model_dump(mode="json") for c in candles],
    })
    redis.get = AsyncMock(return_value=payload)

    cached = await service.get_ohlcv("mock", "EURUSD", "H1", limit=50)
    assert len(cached) >= 10


def _broker_candles(
    latest: datetime,
    timeframe: str = "H1",
    source: str = "broker",
) -> list[OHLCVCandle]:
    spacing = timedelta(hours=1)
    candles: list[OHLCVCandle] = []
    for index in range(12):
        timestamp = latest - spacing * (11 - index)
        close = 1.10 + index * 0.00001
        candles.append(
            OHLCVCandle(
                timestamp=timestamp,
                open=close - 0.00002,
                high=close + 0.00005,
                low=close - 0.00005,
                close=close,
                volume=1000,
                instrument="EURUSD",
                timeframe=timeframe,
                source=source,
            )
        )
    return candles


@pytest.mark.asyncio
async def test_broker_source_rejects_years_stale_candles_before_inference():
    broker = AsyncMock()
    broker.get_ohlcv = AsyncMock(
        return_value=_broker_candles(datetime.now(UTC) - timedelta(days=30))
    )
    service = OHLCVService(
        broker_provider=broker,
        cache=OHLCVRedisCache(redis_client=None),
    )

    with pytest.raises(MarketDataError, match="stale"):
        await service.get_ohlcv(
            "broker",
            "EURUSD",
            "H1",
            user_id="user-1",
            broker_connection_id="conn-1",
            bypass_cache=True,
        )


@pytest.mark.asyncio
async def test_broker_source_accepts_recent_candles():
    broker = AsyncMock()
    broker.get_ohlcv = AsyncMock(
        return_value=_broker_candles(datetime.now(UTC) - timedelta(minutes=30))
    )
    service = OHLCVService(
        broker_provider=broker,
        cache=OHLCVRedisCache(redis_client=None),
    )

    candles = await service.get_ohlcv(
        "broker",
        "EURUSD",
        "H1",
        user_id="user-1",
        broker_connection_id="conn-1",
        bypass_cache=True,
    )

    assert len(candles) == 12


@pytest.mark.asyncio
async def test_paper_simulator_uses_simulated_time_not_wall_clock_freshness():
    broker = AsyncMock()
    broker.get_ohlcv = AsyncMock(
        return_value=_broker_candles(
            datetime(2024, 1, 2, 3, 4, 6, tzinfo=UTC),
            source="paper-broker",
        )
    )
    service = OHLCVService(
        broker_provider=broker,
        cache=OHLCVRedisCache(redis_client=None),
    )

    candles = await service.get_ohlcv(
        "broker",
        "EURUSD",
        "H1",
        user_id="user-1",
        broker_connection_id="conn-1",
        bypass_cache=True,
        advance_simulation=True,
    )

    assert len(candles) == 12
    assert candles[-1].source == "paper-broker"
    assert broker.get_ohlcv.await_args.kwargs["advance_simulation"] is True
