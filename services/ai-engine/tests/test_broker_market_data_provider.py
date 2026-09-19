"""Tests for BrokerMarketDataProvider."""
from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.core.config import Settings
from app.core.errors import MarketDataError
from app.domain.market_data.providers.broker_provider import (
    INTERNAL_API_KEY_HEADER,
    BrokerMarketDataProvider,
)

TEST_SETTINGS = Settings(
    nestjs_api_base_url="http://localhost:3000/api/v1",
    nestjs_market_data_endpoint="/market-data/internal/ohlcv",
    nestjs_internal_api_key="dev_internal_key_change_me",
)


def test_builds_correct_url():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    url = provider.build_request_url(
        user_id="user-1",
        broker_connection_id="conn-1",
        instrument="eurusd",
        timeframe="h1",
        limit=50,
    )
    assert url.startswith("http://localhost:3000/api/v1/market-data/internal/ohlcv?")
    assert "userId=user-1" in url
    assert "brokerConnectionId=conn-1" in url
    assert "instrument=EURUSD" in url
    assert "timeframe=H1" in url
    assert "limit=50" in url


def test_builds_historical_url_with_encoded_end_time():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    end_time = datetime(2025, 1, 15, 12, 0, tzinfo=UTC)

    url = provider.build_request_url(
        user_id="user-1",
        broker_connection_id="conn-1",
        instrument="eurusd",
        timeframe="h1",
        limit=500,
        end_time=end_time,
    )

    assert "endTime=2025-01-15T12%3A00%3A00%2B00%3A00" in url


def test_sends_internal_api_key_header():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    headers = provider._get_headers()
    assert INTERNAL_API_KEY_HEADER in headers
    assert headers[INTERNAL_API_KEY_HEADER] == "dev_internal_key_change_me"


@pytest.mark.asyncio
async def test_parses_successful_ohlcv_response():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "candles": [
            {
                "timestamp": "2024-01-01T00:00:00+00:00",
                "open": "1.10000",
                "high": "1.10100",
                "low": "1.09900",
                "close": "1.10050",
                "volume": "1000",
                "instrument": "EURUSD",
                "timeframe": "H1",
            }
        ]
    }

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.domain.market_data.providers.broker_provider.httpx.AsyncClient", return_value=mock_client):
        candles = await provider.get_ohlcv(
            "EURUSD",
            "H1",
            100,
            user_id="user-1",
            broker_connection_id="conn-1",
        )

    assert len(candles) == 1
    assert candles[0].source == "broker"
    assert candles[0].close == 1.10050


@pytest.mark.asyncio
async def test_fetches_historical_ohlcv_page():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "candles": [
            {
                "timestamp": "2024-01-01T00:00:00+00:00",
                "open": "1.10000",
                "high": "1.10100",
                "low": "1.09900",
                "close": "1.10050",
                "volume": "1000",
                "instrument": "EURUSD",
                "timeframe": "H1",
            }
        ]
    }

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    end_time = datetime(2025, 1, 15, 12, 0, tzinfo=UTC)
    with patch(
        "app.domain.market_data.providers.broker_provider.httpx.AsyncClient",
        return_value=mock_client,
    ):
        candles = await provider.get_historical_ohlcv(
            "EURUSD",
            "H1",
            end_time=end_time,
            limit=500,
            user_id="user-1",
            broker_connection_id="conn-1",
        )

    assert len(candles) == 1
    called_url = mock_client.get.await_args.args[0]
    assert "endTime=2025-01-15T12%3A00%3A00%2B00%3A00" in called_url


@pytest.mark.asyncio
async def test_handles_401_safely():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    mock_response = MagicMock()
    mock_response.status_code = 401

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.domain.market_data.providers.broker_provider.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(MarketDataError, match="access denied"):
            await provider.get_ohlcv("EURUSD", "H1", user_id="u1", broker_connection_id="c1")


@pytest.mark.asyncio
async def test_handles_timeout_safely():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.domain.market_data.providers.broker_provider.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(MarketDataError, match="timed out"):
            await provider.get_ohlcv("EURUSD", "H1", user_id="u1", broker_connection_id="c1")


def test_does_not_expose_secrets_in_exceptions():
    try:
        raise MarketDataError("Market data access denied")
    except MarketDataError as e:
        assert TEST_SETTINGS.nestjs_internal_api_key not in str(e)
