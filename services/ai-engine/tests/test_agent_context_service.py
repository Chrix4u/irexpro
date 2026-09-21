"""Tests for cached advisory Agent Council context snapshots."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from app.domain.agents.context_service import AgentContextService
from app.domain.agents.macro_context import MacroContextEvent
from app.domain.agents.providers.bls_calendar import BlsCalendarProviderError

NOW = datetime.now(UTC)


def high_impact_event() -> MacroContextEvent:
    return MacroContextEvent(
        source_id="us_bls",
        source_event_id="bls:test-cpi",
        event_family="CPI",
        title="Consumer Price Index",
        currency="USD",
        impact="HIGH",
        status="SCHEDULED",
        observed_at=NOW - timedelta(minutes=1),
        available_at=NOW - timedelta(minutes=1),
        scheduled_for=NOW + timedelta(minutes=10),
    )


@pytest.mark.asyncio
async def test_high_impact_usd_event_becomes_advisory_block_snapshot():
    provider = AsyncMock()
    provider.fetch.return_value = [high_impact_event()]
    service = AgentContextService(bls_provider=provider)

    snapshot = await service.snapshot_for(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.80,
    )

    assert snapshot.status == "BLOCKED"
    assert snapshot.consensus_direction == "NEUTRAL"
    assert snapshot.source_state == "AVAILABLE"
    assert snapshot.evidence_count == 1
    assert len(snapshot.evidence) == 1
    assert snapshot.evidence[0].source == "MACRO_NEWS"
    assert snapshot.evidence[0].stance == "BLOCK"
    assert snapshot.advisory_only is True
    assert snapshot.execution_authority is False


@pytest.mark.asyncio
async def test_context_service_reuses_fresh_calendar_cache():
    provider = AsyncMock()
    provider.fetch.return_value = [high_impact_event()]
    service = AgentContextService(
        bls_provider=provider,
        refresh_seconds=300,
    )

    first = await service.snapshot_for(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.80,
    )
    second = await service.snapshot_for(
        instrument="GBPUSD",
        quant_direction="SELL",
        quant_confidence=0.75,
    )

    assert first.source_state == "AVAILABLE"
    assert second.source_state == "AVAILABLE"
    assert provider.fetch.await_count == 1


@pytest.mark.asyncio
async def test_bls_failure_degrades_to_unavailable_without_fabricating_context():
    provider = AsyncMock()
    provider.fetch.side_effect = BlsCalendarProviderError("upstream unavailable")
    service = AgentContextService(
        bls_provider=provider,
        failure_retry_seconds=60,
    )

    first = await service.snapshot_for(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.80,
    )
    second = await service.snapshot_for(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.80,
    )

    assert first.status == "INSUFFICIENT"
    assert first.source_state == "UNAVAILABLE"
    assert first.evidence_count == 0
    assert first.evidence == []
    assert second.source_state == "UNAVAILABLE"
    assert provider.fetch.await_count == 1


@pytest.mark.asyncio
async def test_bls_refresh_timeout_degrades_to_unavailable_without_blocking_signal_context():
    provider = AsyncMock()

    async def slow_fetch():
        await asyncio.sleep(0.1)
        return [high_impact_event()]

    provider.fetch.side_effect = slow_fetch
    service = AgentContextService(
        bls_provider=provider,
        fetch_timeout_seconds=0.01,
    )

    snapshot = await service.snapshot_for(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.80,
    )

    assert snapshot.status == "INSUFFICIENT"
    assert snapshot.source_state == "UNAVAILABLE"
    assert snapshot.evidence_count == 0


@pytest.mark.asyncio
async def test_non_usd_pair_is_not_applicable_and_does_not_fetch_bls():
    provider = AsyncMock()
    service = AgentContextService(bls_provider=provider)

    snapshot = await service.snapshot_for(
        instrument="EURGBP",
        quant_direction="BUY",
        quant_confidence=0.70,
    )

    assert snapshot.status == "INSUFFICIENT"
    assert snapshot.source_state == "NOT_APPLICABLE"
    assert snapshot.evidence_count == 0
    provider.fetch.assert_not_awaited()


@pytest.mark.parametrize(
    ("refresh_seconds", "failure_retry_seconds", "fetch_timeout_seconds", "message"),
    [
        (0, 60, 3.0, "refresh_seconds must be greater than 0"),
        (300, 0, 3.0, "failure_retry_seconds must be greater than 0"),
        (300, 60, 0, "fetch_timeout_seconds must be finite"),
        (300, 60, 5.01, "fetch_timeout_seconds must be finite"),
    ],
)
def test_context_service_rejects_invalid_timing_configuration(
    refresh_seconds,
    failure_retry_seconds,
    fetch_timeout_seconds,
    message,
):
    with pytest.raises(ValueError, match=message):
        AgentContextService(
            bls_provider=AsyncMock(),
            refresh_seconds=refresh_seconds,
            failure_retry_seconds=failure_retry_seconds,
            fetch_timeout_seconds=fetch_timeout_seconds,
        )
