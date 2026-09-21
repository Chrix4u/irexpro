"""Typed contracts for iRexPro's advisory autonomous-agent council."""
from __future__ import annotations

import re
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

_SENSITIVE_METADATA_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "authorization",
        "private_key",
    }
)
_SENSITIVE_METADATA_SEGMENTS = frozenset(
    {
        "credential",
        "credentials",
        "passwd",
        "password",
        "secret",
        "token",
    }
)


def _normalize_metadata_key(key: Any) -> str:
    raw = str(key).strip().replace("-", "_").replace(" ", "_")
    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", raw)
    return re.sub(r"_+", "_", snake).lower()


def _contains_sensitive_metadata_key(value: Any) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = _normalize_metadata_key(key)
            segments = frozenset(part for part in normalized.split("_") if part)
            if (
                normalized in _SENSITIVE_METADATA_KEYS
                or bool(segments & _SENSITIVE_METADATA_SEGMENTS)
            ):
                return True
            if _contains_sensitive_metadata_key(nested):
                return True
    elif isinstance(value, list | tuple | set):
        return any(_contains_sensitive_metadata_key(item) for item in value)
    return False


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

    @field_validator("source_id", "instrument", "summary")
    @classmethod
    def text_fields_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("agent evidence text fields cannot be blank")
        return value

    @field_validator("observed_at", "available_at")
    @classmethod
    def timestamps_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("agent evidence timestamps must be timezone-aware")
        return value

    @field_validator("metadata")
    @classmethod
    def metadata_must_not_contain_credentials(
        cls, value: dict[str, Any]
    ) -> dict[str, Any]:
        if _contains_sensitive_metadata_key(value):
            raise ValueError("agent evidence metadata cannot contain credential-like keys")
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
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("generated_at must be timezone-aware")
        return value
