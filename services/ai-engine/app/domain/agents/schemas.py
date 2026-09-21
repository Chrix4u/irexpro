"""Typed contracts for iRexPro's advisory autonomous-agent council."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

AgentEvidenceSource = Literal[
    "QUANT",
    "MACRO_NEWS",
    "REGIME",
    "RISK",
    "REFLECTION",
]
AgentStance = Literal["BUY", "SELL", "NEUTRAL", "BLOCK"]
AgentCouncilStatus = Literal["ALIGNED", "CONFLICT", "INSUFFICIENT", "BLOCKED"]


class AgentEvidence(BaseModel):
    """A concise, auditable observation produced by one specialist agent."""

    source: AgentEvidenceSource
    source_id: str = Field(..., min_length=1, max_length=160)
    instrument: str = Field(..., min_length=3, max_length=24)
    stance: AgentStance
    confidence: float = Field(..., ge=0.0, le=1.0)
    credibility: float = Field(..., ge=0.0, le=1.0)
    observed_at: datetime
    available_at: datetime
    summary: str = Field(..., min_length=1, max_length=500)
    verified_sources: int = Field(default=0, ge=0, le=100)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("observed_at", "available_at")
    @classmethod
    def timestamps_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("agent evidence timestamps must be timezone-aware")
        return value

    @model_validator(mode="after")
    def validate_availability_order(self) -> AgentEvidence:
        if self.available_at < self.observed_at:
            raise ValueError("available_at cannot precede observed_at")
        return self


class AgentCouncilAssessment(BaseModel):
    """Advisory synthesis of specialist-agent evidence; never an order."""

    instrument: str
    quant_direction: Literal["BUY", "SELL"]
    quant_confidence: float = Field(..., ge=0.0, le=1.0)
    status: AgentCouncilStatus
    consensus_direction: Literal["BUY", "SELL", "NEUTRAL"]
    weighted_support: float = Field(..., ge=0.0)
    weighted_opposition: float = Field(..., ge=0.0)
    disagreement_score: float = Field(..., ge=0.0, le=1.0)
    evidence_used: list[AgentEvidence] = Field(default_factory=list)
    rejected_source_ids: list[str] = Field(default_factory=list)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    advisory_only: Literal[True] = True
    execution_authority: Literal[False] = False

    @field_validator("generated_at")
    @classmethod
    def generated_at_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("generated_at must be timezone-aware")
        return value
