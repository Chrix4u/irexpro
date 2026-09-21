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
    account_type: Literal["DEMO", "LIVE"] = Field(..., alias="accountType")
    # Round 5 (session authority): the NestJS API forwards the TradingSession's
    # durable executionMode. "paper" is kept for backward compatibility with
    # older API versions. Scheduled signal generation itself stays paper-only —
    # the risk + execution gates own the enforcement boundary.
    mode: Literal["paper", "PAPER_ONLY", "SEMI_AUTO", "FULL_AUTO"] = "paper"

    model_config = {"populate_by_name": True}


class SessionStopRequest(BaseModel):
    trading_session_id: str = Field(..., alias="tradingSessionId")

    model_config = {"populate_by_name": True}


class SessionStatusRequest(BaseModel):
    trading_session_id: str = Field(..., alias="tradingSessionId")

    model_config = {"populate_by_name": True}


class SessionSchedulerStatusResponse(BaseModel):
    enabled: bool
    registered: bool
    trading_session_id: str
    active: bool
    instruments: list[str]
    timeframe: str | None = None
    interval_seconds: int | None = None
    source: str | None = None
    last_run_at: str | None = None
    next_run_at: str | None = None
    last_decision: str | None = None
    last_reason: str | None = None
    last_confidence_score: float | None = None
    last_confidence_at: str | None = None
    confidence_threshold: float | None = None
    model_version: str | None = None
    model_mode: str | None = None
    model_loaded: bool | None = None
    last_market_data_at: str | None = None
    market_data_age_seconds: float | None = None
    market_data_cache_bypassed: bool = False
    last_publish_failed: bool = False


class SessionSchedulerResponse(BaseModel):
    registered: bool
    trading_session_id: str
    message: str
