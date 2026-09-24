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
    broker_id: str | None = Field(default=None, alias="brokerId")
    research_uat: bool = Field(default=False, alias="researchUat")
    replay_steps_per_cycle: int = Field(
        default=1,
        ge=1,
        le=30,
        alias="replayStepsPerCycle",
    )
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
    research_uat: bool = False
    replay_steps_per_cycle: int = 1
    replay_steps_last_cycle: int = 0
    replay_steps_total: int = 0
    signals_published_total: int = 0
    last_strategy_outcome: str | None = None
    last_strategy_reason: str | None = None
    last_trade_id: str | None = None
    executions_succeeded_total: int = 0
    downstream_rejected_total: int = 0


class SessionSchedulerResponse(BaseModel):
    registered: bool
    trading_session_id: str
    message: str
