"""Cached official-source context service for advisory Agent Council snapshots."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from app.core.logging import get_logger
from app.domain.agents.context_sources import (
    TrustedContextSourceRegistry,
    default_trusted_source_registry,
)
from app.domain.agents.coordinator import assess_agent_context
from app.domain.agents.macro_context import (
    MacroContextEvent,
    build_high_impact_event_evidence,
    normalize_fx_instrument,
)
from app.domain.agents.providers.bls_calendar import (
    BlsCalendarProviderError,
    BlsOfficialCalendarProvider,
)
from app.domain.agents.snapshot import AgentContextSnapshot, build_agent_context_snapshot

logger = get_logger(__name__)


class AgentContextService:
    """
    Produce advisory context with a short-lived official-calendar cache.

    Context never changes model confidence, position size, risk limits, or
    execution. Provider failure degrades to an explicit UNAVAILABLE snapshot.
    """

    def __init__(
        self,
        *,
        bls_provider: BlsOfficialCalendarProvider | None = None,
        registry: TrustedContextSourceRegistry | None = None,
        refresh_seconds: int = 300,
        failure_retry_seconds: int = 60,
    ) -> None:
        if refresh_seconds <= 0:
            raise ValueError("refresh_seconds must be greater than 0")
        if failure_retry_seconds <= 0:
            raise ValueError("failure_retry_seconds must be greater than 0")

        self._bls = bls_provider or BlsOfficialCalendarProvider()
        self._registry = registry or default_trusted_source_registry()
        self._refresh_interval = timedelta(seconds=refresh_seconds)
        self._failure_retry = timedelta(seconds=failure_retry_seconds)
        self._lock = asyncio.Lock()
        self._cached_events: list[MacroContextEvent] = []
        self._cache_refreshed_at: datetime | None = None
        self._last_failure_at: datetime | None = None

    async def snapshot_for(
        self,
        *,
        instrument: str,
        quant_direction: str,
        quant_confidence: float,
    ) -> AgentContextSnapshot:
        pair = normalize_fx_instrument(instrument)
        relevant_currencies = {pair[:3], pair[3:]}

        if "USD" not in relevant_currencies:
            now = datetime.now(UTC)
            assessment = assess_agent_context(
                instrument=pair,
                quant_direction=quant_direction,
                quant_confidence=quant_confidence,
                evidence=[],
                evaluated_at=now,
            )
            return build_agent_context_snapshot(
                assessment,
                source_state="NOT_APPLICABLE",
            )

        events, source_state = await self._current_bls_events()
        evaluated_at = datetime.now(UTC)
        evidence = build_high_impact_event_evidence(
            events=events,
            registry=self._registry,
            instrument=pair,
            evaluated_at=evaluated_at,
        )
        assessment = assess_agent_context(
            instrument=pair,
            quant_direction=quant_direction,
            quant_confidence=quant_confidence,
            evidence=evidence,
            evaluated_at=evaluated_at,
        )
        return build_agent_context_snapshot(
            assessment,
            source_state=source_state,
        )

    async def _current_bls_events(
        self,
    ) -> tuple[list[MacroContextEvent], LiteralSourceState]:
        now = datetime.now(UTC)
        if self._cache_is_fresh(now):
            return list(self._cached_events), "AVAILABLE"
        if self._failure_is_throttled(now):
            return [], "UNAVAILABLE"

        async with self._lock:
            now = datetime.now(UTC)
            if self._cache_is_fresh(now):
                return list(self._cached_events), "AVAILABLE"
            if self._failure_is_throttled(now):
                return [], "UNAVAILABLE"

            try:
                events = await self._bls.fetch()
            except BlsCalendarProviderError:
                self._last_failure_at = datetime.now(UTC)
                logger.warning("Official BLS context source unavailable")
                return [], "UNAVAILABLE"

            self._cached_events = list(events)
            self._cache_refreshed_at = datetime.now(UTC)
            self._last_failure_at = None
            return list(self._cached_events), "AVAILABLE"

    def _cache_is_fresh(self, now: datetime) -> bool:
        return (
            self._cache_refreshed_at is not None
            and now - self._cache_refreshed_at <= self._refresh_interval
        )

    def _failure_is_throttled(self, now: datetime) -> bool:
        return (
            self._last_failure_at is not None
            and now - self._last_failure_at <= self._failure_retry
        )


LiteralSourceState = Literal["AVAILABLE", "UNAVAILABLE"]
