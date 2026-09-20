"""Tests for BrokerMarketDataProvider."""
from __future__ import annotations

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


def test_build_url_can_request_one_paper_simulation_heartbeat():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    url = provider.build_request_url(
        user_id="user-1",
        broker_connection_id="conn-1",
        instrument="EURUSD",
        timeframe="M1",
        limit=100,
        advance_simulation=True,
    )
    assert "advanceSimulation=true" in url


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
                "tickVolume": "950",
                "tradeVolume": "12.5",
                "spreadPoints": "2",
                "priceDigits": 5,
                "brokerTime": "2024-01-01 00:00:00.000",
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
    assert candles[0].tick_volume == 950.0
    assert candles[0].trade_volume == 12.5
    assert candles[0].spread_points == 2.0
    assert candles[0].price_digits == 5
    assert candles[0].broker_time == "2024-01-01 00:00:00.000"


@pytest.mark.asyncio
async def test_preserves_paper_simulator_provenance():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "source": "paper-broker",
        "candles": [
            {
                "timestamp": "2024-01-02T03:04:06+00:00",
                "open": "1.10000",
                "high": "1.10100",
                "low": "1.09900",
                "close": "1.10050",
                "volume": "1000",
                "tickVolume": "1000",
                "spreadPoints": "10",
                "priceDigits": 5,
                "instrument": "EURUSD",
                "timeframe": "M1",
                "source": "paper-broker",
            }
        ],
    }

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.domain.market_data.providers.broker_provider.httpx.AsyncClient", return_value=mock_client):
        candles = await provider.get_ohlcv(
            "EURUSD",
            "M1",
            100,
            user_id="user-1",
            broker_connection_id="conn-1",
            advance_simulation=True,
        )

    assert candles[0].source == "paper-broker"
    requested_url = mock_client.get.await_args.args[0]
    assert "advanceSimulation=true" in requested_url


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
