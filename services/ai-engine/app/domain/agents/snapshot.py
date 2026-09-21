"""Browser-safe Agent Council snapshots attached to signal candidates."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.domain.agents.schemas import (
    AgentCouncilAssessment,
    AgentCouncilStatus,
    AgentEvidenceSource,
    AgentStance,
)

AgentContextSourceState = Literal["AVAILABLE", "UNAVAILABLE", "NOT_APPLICABLE"]


class AgentContextEvidenceSnapshot(BaseModel):
    """Concise accepted evidence; opaque provider metadata is intentionally excluded."""

    source: AgentEvidenceSource
    source_id: str = Field(..., min_length=1, max_length=160)
    stance: AgentStance
    confidence: float = Field(..., ge=0.0, le=1.0)
    credibility: float = Field(..., ge=0.0, le=1.0)
    verified_sources: int = Field(..., ge=0, le=100)
    available_at: datetime
    summary: str = Field(..., min_length=1, max_length=500)

    @field_validator("available_at")
    @classmethod
    def available_at_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("agent context evidence available_at must be timezone-aware")
        return value


class AgentContextSnapshot(BaseModel):
    """Read-only context recorded with a quantitative signal candidate."""

    version: Literal["agent-council-v1"] = "agent-council-v1"
    status: AgentCouncilStatus
    consensus_direction: Literal["BUY", "SELL", "NEUTRAL"]
    weighted_support: float = Field(..., ge=0.0)
    weighted_opposition: float = Field(..., ge=0.0)
    disagreement_score: float = Field(..., ge=0.0, le=1.0)
    evidence_count: int = Field(..., ge=0, le=100)
    rejected_count: int = Field(..., ge=0)
    evidence: list[AgentContextEvidenceSnapshot] = Field(default_factory=list, max_length=10)
    source_state: AgentContextSourceState
    evaluated_at: datetime
    advisory_only: Literal[True] = True
    execution_authority: Literal[False] = False

    @field_validator("evaluated_at")
    @classmethod
    def evaluated_at_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("agent context evaluated_at must be timezone-aware")
        return value

    @model_validator(mode="after")
    def validate_source_state_consistency(self) -> AgentContextSnapshot:
        if self.evidence_count < len(self.evidence):
            raise ValueError("evidence_count cannot be less than projected evidence length")
        if self.source_state != "AVAILABLE":
            if self.status != "INSUFFICIENT":
                raise ValueError("unavailable context must have INSUFFICIENT status")
            if self.evidence_count != 0 or self.evidence:
                raise ValueError("unavailable context cannot contain accepted evidence")
        return self


def build_agent_context_snapshot(
    assessment: AgentCouncilAssessment,
    *,
    source_state: AgentContextSourceState,
) -> AgentContextSnapshot:
    """Project a council assessment into the strict cross-service audit contract."""
    accepted = assessment.evidence_used[:10]
    return AgentContextSnapshot(
        status=assessment.status,
        consensus_direction=assessment.consensus_direction,
        weighted_support=assessment.weighted_support,
        weighted_opposition=assessment.weighted_opposition,
        disagreement_score=assessment.disagreement_score,
        evidence_count=len(assessment.evidence_used),
        rejected_count=len(assessment.rejected_source_ids),
        evidence=[
            AgentContextEvidenceSnapshot(
                source=item.source,
                source_id=item.source_id,
                stance=item.stance,
                confidence=item.confidence,
                credibility=item.credibility,
                verified_sources=item.verified_sources,
                available_at=item.available_at,
                summary=item.summary,
            )
            for item in accepted
        ],
        source_state=source_state,
        evaluated_at=assessment.generated_at,
    )
