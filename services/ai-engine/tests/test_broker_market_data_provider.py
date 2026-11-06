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
    assert mock_client.get.await_args.args[0] == TEST_SETTINGS.nestjs_market_data_url
    assert mock_client.get.await_args.kwargs["params"]["advanceSimulation"] == "true"


@pytest.mark.asyncio
async def test_user_fields_are_query_data_not_request_target():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"candles": []}

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    malicious_user_id = "//evil.example/%2F?redirect=https://evil.example"
    with patch("app.domain.market_data.providers.broker_provider.httpx.AsyncClient", return_value=mock_client):
        await provider.get_ohlcv(
            "EUR/USD",
            "M1",
            100,
            user_id=malicious_user_id,
            broker_connection_id="conn&next=https://evil.example",
        )

    assert mock_client.get.await_args.args[0] == TEST_SETTINGS.nestjs_market_data_url
    assert mock_client.get.await_args.kwargs["params"]["userId"] == malicious_user_id
    assert mock_client.get.await_args.kwargs["params"]["brokerConnectionId"] == "conn&next=https://evil.example"


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


@pytest.mark.asyncio
async def test_read_only_503_retries_once_and_uses_fresh_received_bars():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    rejected = MagicMock(status_code=503)
    recovered = MagicMock(status_code=200)
    recovered.json.return_value = {"candles": [{
        "timestamp": "2026-11-06T09:30:00Z",
        "open": 1.10, "high": 1.11, "low": 1.09, "close": 1.10,
        "volume": 120, "tickVolume": 100, "spreadPoints": 2,
        "priceDigits": 5, "instrument": "EURUSD", "timeframe": "M5",
    }]}
    client = AsyncMock()
    client.get = AsyncMock(side_effect=[rejected, recovered])
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)

    with (
        patch(
            "app.domain.market_data.providers.broker_provider.httpx.AsyncClient",
            return_value=client,
        ),
        patch("app.domain.market_data.providers.broker_provider.asyncio.sleep",
              new_callable=AsyncMock) as sleep,
    ):
        candles = await provider.get_ohlcv(
            "EURUSD", "M5", user_id="u1", broker_connection_id="c1"
        )

    assert len(candles) == 1
    assert candles[0].source == "broker"
    assert client.get.await_count == 2
    assert client.get.await_args_list[0].kwargs["timeout"] == 15.0
    assert client.get.await_args_list[1].kwargs["timeout"] == 3.0
    sleep.assert_awaited_once()


@pytest.mark.asyncio
async def test_read_only_timeout_can_recover_on_second_attempt():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    good = MagicMock(status_code=200)
    good.json.return_value = {"candles": []}
    client = AsyncMock()
    client.get = AsyncMock(side_effect=[
        httpx.TimeoutException("secret=must-not-be-exposed"), good,
    ])
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)

    with (
        patch(
            "app.domain.market_data.providers.broker_provider.httpx.AsyncClient",
            return_value=client,
        ),
        patch("app.domain.market_data.providers.broker_provider.asyncio.sleep",
              new_callable=AsyncMock),
    ):
        assert await provider.get_ohlcv(
            "GBPUSD", "H1", user_id="u1", broker_connection_id="c1"
        ) == []
    assert client.get.await_count == 2


@pytest.mark.asyncio
async def test_read_only_retry_exhaustion_stays_unavailable():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    denied = MagicMock(status_code=503)
    client = AsyncMock()
    client.get = AsyncMock(return_value=denied)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    with (
        patch(
            "app.domain.market_data.providers.broker_provider.httpx.AsyncClient",
            return_value=client,
        ),
        patch("app.domain.market_data.providers.broker_provider.asyncio.sleep",
              new_callable=AsyncMock),
    ):
        with pytest.raises(MarketDataError, match="HTTP 503"):
            await provider.get_ohlcv(
                "AUDUSD", "M15", user_id="u1", broker_connection_id="c1"
            )
    assert client.get.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 403, 404, 429])
async def test_non_retryable_errors_fail_closed_without_second_request(status):
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    response = MagicMock(status_code=status)
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)

    with patch(
        "app.domain.market_data.providers.broker_provider.httpx.AsyncClient",
        return_value=client,
    ):
        with pytest.raises(MarketDataError):
            await provider.get_ohlcv(
                "EURUSD", "M1", user_id="u1", broker_connection_id="c1"
            )
    client.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_never_retries_paper_simulation_advance():
    provider = BrokerMarketDataProvider(settings=TEST_SETTINGS)
    response = MagicMock(status_code=503)
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    with patch(
        "app.domain.market_data.providers.broker_provider.httpx.AsyncClient",
        return_value=client,
    ):
        with pytest.raises(MarketDataError, match="HTTP 503"):
            await provider.get_ohlcv(
                "EURUSD", "M1", user_id="u1", broker_connection_id="c1",
                advance_simulation=True,
            )
    client.get.assert_awaited_once()
    assert client.get.await_args.kwargs["params"]["advanceSimulation"] == "true"


def test_does_not_expose_secrets_in_exceptions():
    try:
        raise MarketDataError("Market data access denied")
    except MarketDataError as e:
        assert TEST_SETTINGS.nestjs_internal_api_key not in str(e)
