"""OHLCV market data schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class OHLCVCandle(BaseModel):
    """
    A single OHLCV candle.
    Prices stored as floats internally but displayed as strings for decimal safety.
    """
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    tick_volume: float | None = None
    trade_volume: float | None = None
    spread_points: float | None = None
    price_digits: int | None = None
    broker_time: str | None = None
    instrument: str
    timeframe: str
    source: str = "mock"

    @property
    def open_str(self) -> str:
        return f"{self.open:.5f}"

    @property
    def close_str(self) -> str:
        return f"{self.close:.5f}"


class OHLCVRequest(BaseModel):
    instrument: str = Field(..., min_length=3)
    timeframe: str = "H1"
    limit: int = Field(default=100, ge=10, le=500)


class OHLCVResponse(BaseModel):
    instrument: str
    timeframe: str
    candles: list[OHLCVCandle]
    source: str
    count: int
