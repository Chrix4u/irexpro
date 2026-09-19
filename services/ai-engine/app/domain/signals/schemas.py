"""
AiSignalCandidate schema — compatible with NestJS Sprint 6 AiSignalCandidate interface.

IMPORTANT:
- This is a signal CANDIDATE only. It is never executed directly.
- All candidates must be sent to NestJS AiSignalService.receiveSignal()
- NestJS will route through Strategy Orchestrator → Risk Engine → Execution Engine
- The Python service NEVER calls the broker or execution engine directly.

See: apps/api/src/modules/strategy/interfaces/strategy.interface.ts
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator, model_validator


class AiSignalCandidate(BaseModel):
    """Signal candidate produced by the AI engine. Never executed directly."""

    signal_id: str = Field(default_factory=lambda: str(uuid4()), description="Unique signal UUID")
    user_id: str = Field(..., description="Target user UUID")
    trading_session_id: str = Field(..., description="Active trading session UUID")
    broker_connection_id: str = Field(..., description="Broker connection UUID")

    instrument: str = Field(..., min_length=3, description="Forex pair e.g. EURUSD")
    direction: Literal["BUY", "SELL"] = Field(..., description="Trade direction")

    confidence_score: float = Field(..., ge=0.0, le=1.0, description="Model confidence 0–1")
    suggested_entry_price: float | None = Field(None, description="Optional limit entry price")
    suggested_stop_loss: float = Field(..., gt=0, description="Mandatory stop-loss price")
    suggested_take_profit: float = Field(..., gt=0, description="Mandatory take-profit price")
    suggested_volume: float = Field(..., gt=0, description="Lot size (positive)")

    timeframe: str = Field(..., description="Chart timeframe e.g. H1, M15")
    strategy_code: str = Field(..., description="Internal strategy identifier")
    market_regime: str | None = Field(None, description="trending / ranging / volatile")
    volatility_score: float | None = Field(None, ge=0.0, le=1.0)

    generated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        description="Must be timezone-aware",
    )
    model_version: str = Field(..., description="AI model version string")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Opaque audit metadata")

    @field_validator("generated_at")
    @classmethod
    def must_be_timezone_aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("generated_at must be timezone-aware")
        return v

    @model_validator(mode="after")
    def validate_sl_tp_direction(self) -> AiSignalCandidate:
        """Basic SL/TP sanity checks (not exhaustive — Risk Engine does full validation)."""
        if self.suggested_entry_price is not None and self.suggested_entry_price > 0:
            entry = self.suggested_entry_price
            if self.direction == "BUY" and self.suggested_stop_loss >= entry:
                raise ValueError("BUY signal: stop_loss must be below entry price")
            if self.direction == "SELL" and self.suggested_stop_loss <= entry:
                raise ValueError("SELL signal: stop_loss must be above entry price")
        return self


class NoSignalResult(BaseModel):
    """Returned when the AI engine decides not to generate a signal."""
    reason: str
    instrument: str
    confidence_score: float | None = None
    threshold: float
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class SignalGenerationRequest(BaseModel):
    """Request to generate a signal for a specific user/session/instrument."""
    user_id: str
    trading_session_id: str
    broker_connection_id: str
    instrument: str
    timeframe: str = "H1"
    candles_limit: int = Field(default=100, ge=10, le=500)


class SignalGenerationResponse(BaseModel):
    """Response from signal generation plus truthful inference/data provenance."""
    generated: bool
    signal: AiSignalCandidate | None = None
    no_signal: NoSignalResult | None = None
    mode: str = "paper"
    model_version: str | None = None
    model_mode: str | None = None
    model_loaded: bool = False
    model_evaluated: bool = False
    market_data_source: str | None = None
    market_data_cache_status: str | None = None
    market_data_cache_age_seconds: float | None = None
    market_data_fetched_at: datetime | None = None
    latest_market_data_at: datetime | None = None
    market_data_age_seconds: float | None = None
    market_data_fingerprint: str | None = None
