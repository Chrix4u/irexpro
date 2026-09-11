"""Scheduler request/response schemas."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class SessionStartRequest(BaseModel):
    user_id: str = Field(..., alias="userId")
    trading_session_id: str = Field(..., alias="tradingSessionId")
    broker_connection_id: str = Field(..., alias="brokerConnectionId")
    instruments: list[str] = Field(..., min_length=1)
    timeframe: str = "H1"
    interval_seconds: int | None = Field(default=None, alias="intervalSeconds")
    source: Literal["broker", "mock"] = "broker"
    # Round 5 (session authority): the NestJS API forwards the TradingSession's
    # durable executionMode. "paper" is kept for backward compatibility with
    # older API versions. Scheduled signal generation itself stays paper-only —
    # the risk + execution gates own the enforcement boundary.
    mode: Literal["paper", "PAPER_ONLY", "SEMI_AUTO", "FULL_AUTO"] = "paper"

    model_config = {"populate_by_name": True}


class SessionStopRequest(BaseModel):
    trading_session_id: str = Field(..., alias="tradingSessionId")

    model_config = {"populate_by_name": True}


class SessionSchedulerResponse(BaseModel):
    registered: bool
    trading_session_id: str
    message: str
