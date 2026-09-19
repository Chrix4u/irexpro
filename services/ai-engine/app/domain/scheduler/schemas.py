"""Scheduler request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SessionStartRequest(BaseModel):
    user_id: str = Field(..., alias="userId")
    trading_session_id: str = Field(..., alias="tradingSessionId")
    broker_connection_id: str = Field(..., alias="brokerConnectionId")
    instruments: list[str] = Field(..., min_length=1)
    timeframe: str = "H1"
    timeframes: list[str] | None = None
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


SchedulerDecision = Literal[
    "WAITING_FOR_FIRST_SCAN",
    "NO_SIGNAL",
    "SIGNAL_PUBLISHED",
    "LIVE_MODEL_BLOCKED",
    "ERROR",
]


class SessionSchedulerJobStatus(BaseModel):
    trading_session_id: str
    active: bool
    execution_mode: str
    instruments: list[str]
    timeframes: list[str]
    interval_seconds: int
    registered_at: datetime
    last_run_at: datetime | None = None
    next_run_at: datetime | None = None
    scan_count: int = 0
    last_decision: SchedulerDecision
    last_reason: str | None = None
    last_instrument: str | None = None
    last_timeframe: str | None = None
    last_confidence_score: float | None = None
    confidence_threshold: float | None = None
    last_signal_id: str | None = None


class SessionSchedulerStatusResponse(BaseModel):
    scheduler_enabled: bool
    scheduler_running: bool
    registered: bool
    active_model_version: str | None = None
    approved_for_live: bool | None = None
    job: SessionSchedulerJobStatus | None = None
