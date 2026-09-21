"""Causal high-impact macro-event context for the advisory Agent Council."""
from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.domain.agents.context_sources import TrustedContextSourceRegistry
from app.domain.agents.schemas import AgentEvidence

MacroImpact = Literal["LOW", "MEDIUM", "HIGH"]


def _aware(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value


def _canonical_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def normalize_fx_instrument(instrument: str) -> str:
    """Normalize a six-letter FX pair while rejecting ambiguous symbols."""
    normalized = re.sub(r"[\s/_-]+", "", instrument).upper()
    if len(normalized) != 6 or not normalized.isalpha():
        raise ValueError("instrument must resolve to a six-letter FX pair")
    return normalized


class MacroContextEvent(BaseModel):
    """Provider-normalized macro/calendar event with causal availability."""

    source_id: str = Field(..., min_length=2, max_length=80)
    source_event_id: str = Field(..., min_length=1, max_length=160)
    event_family: str = Field(\n        ...,\n        min_length=2,\n        max_length=80,\n        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$",\n    )
    title: str = Field(..., min_length=2, max_length=240)
    currency: str = Field(..., min_length=3, max_length=3)
    impact: MacroImpact
    observed_at: datetime
    available_at: datetime
    scheduled_for: datetime

    @field_validator("source_id", "source_event_id", "event_family", "title")
    @classmethod
    def text_fields_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("macro event text fields cannot be blank")
        return value

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        normalized = value.strip().upper()
        if len(normalized) != 3 or not normalized.isalpha():
            raise ValueError("currency must be a three-letter alphabetic code")
        return normalized

    @field_validator("observed_at", "available_at", "scheduled_for")
    @classmethod
    def timestamps_must_be_timezone_aware(cls, value: datetime) -> datetime:
        return _aware(value, "macro event timestamp")

    @model_validator(mode="after")
    def validate_availability_order(self) -> MacroContextEvent:
        if self.available_at < self.observed_at:
            raise ValueError("available_at cannot precede observed_at")
        return self

    def fingerprint(self) -> str:
        """Cross-source event identity independent of provider-specific IDs."""
        scheduled_utc = self.scheduled_for.astimezone(UTC).replace(
            second=0,
            microsecond=0,
        )
        material = "|".join(
            [
                self.currency,
                _canonical_text(self.event_family),
                scheduled_utc.isoformat(),
            ]
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()


def build_high_impact_event_evidence(
    *,
    events: list[MacroContextEvent],
    registry: TrustedContextSourceRegistry,
    instrument: str,
    evaluated_at: datetime,
    pre_event_minutes: int = 30,
    post_event_minutes: int = 15,
) -> list[AgentEvidence]:
    """
    Derive fresh advisory BLOCK evidence from already-known high-impact events.

    The event schedule must have been available by evaluated_at. The returned
    evidence is generated at evaluated_at so a calendar item learned days ago
    does not become artificially stale while its event window is active.
    """
    now = _aware(evaluated_at, "evaluated_at")
    if pre_event_minutes < 0 or post_event_minutes < 0:
        raise ValueError("event window minutes cannot be negative")

    pair = normalize_fx_instrument(instrument)
    relevant_currencies = {pair[:3], pair[3:]}

    grouped: dict[str, list[tuple[MacroContextEvent, float, bool]]] = defaultdict(list)
    for event in events:
        if event.currency not in relevant_currencies or event.impact != "HIGH":
            continue
        if event.available_at > now:
            continue

        source = registry.enabled_for_currency(event.source_id, event.currency)
        if source is None:
            continue

        fingerprint = event.fingerprint()
        grouped[fingerprint].append(
            (event, source.credibility, source.requires_corroboration)
        )

    evidence: list[AgentEvidence] = []
    for fingerprint, observations in grouped.items():
        by_source: dict[str, tuple[MacroContextEvent, float, bool]] = {}
        for observation in observations:
            event = observation[0]
            key = event.source_id.strip().casefold()
            current = by_source.get(key)
            if current is None or event.available_at < current[0].available_at:
                by_source[key] = observation

        verified = list(by_source.values())
        if not verified:
            continue

        representative = min(
            (item[0] for item in verified),
            key=lambda item: (item.available_at, item.source_id.casefold()),
        )
        requires_corroboration = all(item[2] for item in verified)
        if requires_corroboration and len(verified) < 2:
            continue

        minutes_to_event = (representative.scheduled_for - now).total_seconds() / 60.0
        if minutes_to_event > pre_event_minutes or minutes_to_event < -post_event_minutes:
            continue

        strongest_credibility = max(item[1] for item in verified)
        source_ids = sorted(item[0].source_id for item in verified)

        evidence.append(
            AgentEvidence(
                source="MACRO_NEWS",
                source_id=f"macro-event:{fingerprint}",
                instrument=pair,
                stance="BLOCK",
                confidence=1.0,
                credibility=strongest_credibility,
                observed_at=now,
                available_at=now,
                summary=(
                    f"High-impact {representative.currency} "
                    f"{representative.event_family} event is within the configured "
                    "risk window."
                ),
                verified_sources=len(verified),
                metadata={
                    "eventFingerprint": fingerprint,
                    "eventFamily": representative.event_family,
                    "impact": representative.impact,
                    "scheduledFor": representative.scheduled_for.astimezone(UTC).isoformat(),
                    "minutesToEvent": round(minutes_to_event, 3),
                    "verifiedSourceIds": source_ids,
                },
            )
        )

    return sorted(
        evidence,
        key=lambda item: (
            item.metadata.get("scheduledFor", ""),
            item.source_id,
        ),
    )
