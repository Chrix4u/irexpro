"""
BrokerMarketDataProvider — fetches OHLCV via NestJS internal market-data endpoint.

IMPORTANT:
- Does NOT call MetaAPI or any broker directly from Python.
- Does NOT handle broker credentials.
- All broker access is mediated by the NestJS BrokerService + IBrokerAdapter.
"""
from __future__ import annotations

from datetime import datetime
from urllib.parse import urlencode

import httpx

from app.core.config import Settings, get_settings
from app.core.errors import MarketDataError
from app.core.logging import get_logger
from app.domain.market_data.providers.base import MarketDataProvider
from app.domain.market_data.schemas import OHLCVCandle

logger = get_logger(__name__)

INTERNAL_API_KEY_HEADER = "x-irexpro-internal-api-key"
HTTP_TIMEOUT_SECONDS = 15.0


class BrokerMarketDataProvider(MarketDataProvider):
    """Fetches OHLCV candles through the NestJS internal market-data API."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    @property
    def provider_name(self) -> str:
        return "broker"

    def is_available(self) -> bool:
        return bool(self._settings.nestjs_api_base_url and self._settings.nestjs_internal_api_key)

    def _get_headers(self) -> dict[str, str]:
        return {
            INTERNAL_API_KEY_HEADER: self._settings.nestjs_internal_api_key,
            "Accept": "application/json",
        }

    def build_request_url(
        self,
        user_id: str,
        broker_connection_id: str,
        instrument: str,
        timeframe: str,
        limit: int,
        before: datetime | None = None,
    ) -> str:
        base = self._settings.nestjs_market_data_url
        params: dict[str, str | int] = {
            "userId": user_id,
            "brokerConnectionId": broker_connection_id,
            "instrument": instrument.upper(),
            "timeframe": timeframe.upper(),
            "limit": limit,
        }
        if before is not None:
            params["before"] = before.isoformat()
        return f"{base}?{urlencode(params)}"

    async def get_ohlcv(
        self,
        instrument: str,
        timeframe: str,
        limit: int = 100,
        user_id: str | None = None,
        broker_connection_id: str | None = None,
    ) -> list[OHLCVCandle]:
        return await self.get_historical_ohlcv(
            instrument=instrument,
            timeframe=timeframe,
            limit=limit,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
        )

    async def get_historical_ohlcv(
        self,
        instrument: str,
        timeframe: str,
        limit: int = 500,
        user_id: str | None = None,
        broker_connection_id: str | None = None,
        before: datetime | None = None,
    ) -> list[OHLCVCandle]:
        """Fetch one broker-authoritative historical page."""
        if not user_id or not broker_connection_id:
            raise MarketDataError("Broker market data requires userId and brokerConnectionId")
        if limit < 10 or limit > 500:
            raise MarketDataError("Historical market-data page size must be between 10 and 500")

        url = self.build_request_url(
            user_id,
            broker_connection_id,
            instrument,
            timeframe,
            limit,
            before=before,
        )

        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
                response = await client.get(url, headers=self._get_headers())

            if response.status_code in (401, 403):
                raise MarketDataError("Market data access denied")

            if response.status_code >= 400:
                raise MarketDataError(f"Market data request failed with HTTP {response.status_code}")

            data = response.json()
            return self._parse_response(data, instrument, timeframe)
        except MarketDataError:
            raise
        except httpx.TimeoutException as e:
            raise MarketDataError("Market data request timed out") from e
        except Exception as e:
            raise MarketDataError("Unable to fetch broker market data") from e

    def _parse_response(self, data: dict, instrument: str, timeframe: str) -> list[OHLCVCandle]:
        candles: list[OHLCVCandle] = []
        for raw in data.get("candles", []):
            ts = raw["timestamp"]
            if isinstance(ts, str):
                timestamp = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            else:
                timestamp = ts

            candles.append(
                OHLCVCandle(
                    timestamp=timestamp,
                    open=float(raw["open"]),
                    high=float(raw["high"]),
                    low=float(raw["low"]),
                    close=float(raw["close"]),
                    volume=float(raw.get("volume", 0)),
                    instrument=raw.get("instrument", instrument.upper()),
                    timeframe=raw.get("timeframe", timeframe.upper()),
                    source="broker",
                )
            )
        return candles

    async def get_latest_price(self, instrument: str) -> float:
        raise NotImplementedError("Use get_ohlcv for broker-sourced prices")
