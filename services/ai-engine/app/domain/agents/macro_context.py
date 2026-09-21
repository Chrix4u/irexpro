"""Causal high-impact macro-event context for the advisory Agent Council."""
from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from datetime import UTC, datetime
from math import isfinite
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.domain.agents.context_sources import (
    TrustedContextSource,
    TrustedContextSourceRegistry,
)
from app.domain.agents.schemas import AgentEvidence

MacroImpact = Literal["LOW", "MEDIUM", "HIGH"]
MacroEventStatus = Literal["SCHEDULED", "CANCELLED"]
_MAX_EVENT_WINDOW_MINUTES = 24 * 60


def _aware(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value


def _canonical_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _canonical_identity(value: str) -> str:
    return value.strip().casefold()


def _validate_event_window(value: int | float, field_name: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not isfinite(value)
        or not 0 <= value <= _MAX_EVENT_WINDOW_MINUTES
    ):
        raise ValueError(
            f"{field_name} must be finite and between 0 and "
            f"{_MAX_EVENT_WINDOW_MINUTES} minutes"
        )


def normalize_fx_instrument(instrument: str) -> str:
    """Normalize a six-letter FX pair while rejecting ambiguous symbols."""
    normalized = re.sub(r"[\s/_-]+", "", instrument).upper()
    if len(normalized) != 6 or not normalized.isalpha():
        raise ValueError("instrument must resolve to a six-letter FX pair")
    return normalized


class MacroContextEvent(BaseModel):
    """Provider-normalized macro/calendar event with causal availability."""

    model_config = ConfigDict(frozen=True)

    source_id: str = Field(..., min_length=2, max_length=80)
    source_event_id: str = Field(..., min_length=1, max_length=160)
    event_family: str = Field(
        ...,
        min_length=2,
        max_length=80,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
    )
    title: str = Field(..., min_length=2, max_length=240)
    currency: str = Field(..., min_length=3, max_length=3)
    impact: MacroImpact
    status: MacroEventStatus = "SCHEDULED"
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

    def revision_key(self) -> tuple[str, str]:
        """Stable provider-event identity used to resolve historical revisions."""
        return (
            _canonical_identity(self.source_id),
            _canonical_identity(self.source_event_id),
        )

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


def _latest_known_revisions(
    events: list[MacroContextEvent],
    evaluated_at: datetime,
) -> list[MacroContextEvent]:
    """Resolve each source event to one deterministic latest-known revision."""
    latest: dict[tuple[str, str], MacroContextEvent] = {}
    conflicted: set[tuple[str, str]] = set()

    for event in events:
        if event.available_at > evaluated_at:
            continue

        key = event.revision_key()
        current = latest.get(key)
        if current is None:
            latest[key] = event
            continue

        event_clock = (event.available_at, event.observed_at)
        current_clock = (current.available_at, current.observed_at)

        if event_clock > current_clock:
            latest[key] = event
            conflicted.discard(key)
        elif event_clock == current_clock and event != current:
            conflicted.add(key)

    return [event for key, event in latest.items() if key not in conflicted]


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

    Revisions are resolved causally before impact/window filtering. The returned
    evidence is generated at evaluated_at, while original source timestamps are
    retained in metadata for audit and historical replay.
    """
    now = _aware(evaluated_at, "evaluated_at")
    _validate_event_window(pre_event_minutes, "pre_event_minutes")
    _validate_event_window(post_event_minutes, "post_event_minutes")

    pair = normalize_fx_instrument(instrument)
    relevant_currencies = {pair[:3], pair[3:]}

    grouped: dict[
        str,
        list[tuple[MacroContextEvent, TrustedContextSource]],
    ] = defaultdict(list)

    for event in _latest_known_revisions(events, now):
        if event.status != "SCHEDULED":
            continue
        if event.currency not in relevant_currencies or event.impact != "HIGH":
            continue

        source = registry.enabled_for_currency(event.source_id, event.currency)
        if source is None:
            continue

        grouped[event.fingerprint()].append((event, source))

    evidence: list[AgentEvidence] = []
    for fingerprint, observations in grouped.items():
        by_source: dict[
            str,
            tuple[MacroContextEvent, TrustedContextSource],
        ] = {}
        for observation in observations:
            event, _ = observation
            key = _canonical_identity(event.source_id)
            current = by_source.get(key)
            if current is None or (
                event.available_at,
                event.observed_at,
            ) > (
                current[0].available_at,
                current[0].observed_at,
            ):
                by_source[key] = observation

        verified = list(by_source.values())
        if not verified:
            continue

        by_independence_group: dict[
            str,
            tuple[MacroContextEvent, TrustedContextSource],
        ] = {}
        for observation in verified:
            _, source = observation
            current = by_independence_group.get(source.independence_key)
            if current is None or source.credibility > current[1].credibility:
                by_independence_group[source.independence_key] = observation

        independent = list(by_independence_group.values())
        requires_corroboration = any(
            source.requires_corroboration for _, source in verified
        )
        if requires_corroboration and len(independent) < 2:
            continue

        representative, _ = max(
            verified,
            key=lambda item: (
                item[0].available_at,
                item[0].observed_at,
                item[1].credibility,
                item[0].source_id.casefold(),
            ),
        )

        minutes_to_event = (representative.scheduled_for - now).total_seconds() / 60.0
        if minutes_to_event > pre_event_minutes or minutes_to_event < -post_event_minutes:
            continue

        strongest_credibility = max(source.credibility for _, source in independent)
        source_ids = sorted(event.source_id for event, _ in verified)
        independence_groups = sorted(source.independence_key for _, source in independent)

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
                verified_sources=len(independent),
                metadata={
                    "eventFingerprint": fingerprint,
                    "eventFamily": representative.event_family,
                    "impact": representative.impact,
                    "scheduledFor": representative.scheduled_for.astimezone(UTC).isoformat(),
                    "minutesToEvent": round(minutes_to_event, 3),
                    "sourceObservedAt": representative.observed_at.astimezone(UTC).isoformat(),
                    "sourceAvailableAt": representative.available_at.astimezone(UTC).isoformat(),
                    "sourceEventId": representative.source_event_id,
                    "verifiedSourceIds": source_ids,
                    "independenceGroups": independence_groups,
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
