"""Tests for trusted macro/event context supplied to the Agent Council."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domain.agents.context_sources import (
    TrustedContextSource,
    TrustedContextSourceRegistry,
    default_trusted_source_registry,
)
from app.domain.agents.coordinator import assess_agent_context
from app.domain.agents.macro_context import (
    MacroContextEvent,
    build_high_impact_event_evidence,
    normalize_fx_instrument,
)

NOW = datetime(2026, 9, 21, 12, 0, tzinfo=UTC)


def event(
    *,
    source_id: str = "ecb",
    source_event_id: str = "event-1",
    event_family: str = "POLICY_RATE_DECISION",
    currency: str = "EUR",
    impact: str = "HIGH",
    scheduled_for: datetime = NOW + timedelta(minutes=10),
    observed_at: datetime = NOW - timedelta(days=1),
    available_at: datetime = NOW - timedelta(days=1),
) -> MacroContextEvent:
    return MacroContextEvent(
        source_id=source_id,
        source_event_id=source_event_id,
        event_family=event_family,
        title="Policy rate decision",
        currency=currency,
        impact=impact,
        observed_at=observed_at,
        available_at=available_at,
        scheduled_for=scheduled_for,
    )


def test_default_registry_covers_all_six_pair_currencies_with_official_sources():
    registry = default_trusted_source_registry()

    for currency in {"EUR", "GBP", "USD", "JPY", "AUD", "CAD", "CHF"}:
        sources = registry.list_enabled_for_currency(currency)
        assert sources
        assert all(source.credibility == 1.0 for source in sources)


def test_registry_rejects_duplicate_source_ids_case_insensitively():
    source = TrustedContextSource(
        source_id="official_one",
        display_name="Official One",
        source_type="OFFICIAL_STATISTICS",
        currencies={"USD"},
        credibility=1.0,
    )
    duplicate = source.model_copy(update={"source_id": "OFFICIAL_ONE"})

    with pytest.raises(ValueError, match="duplicate trusted context source"):
        TrustedContextSourceRegistry([source, duplicate])


def test_high_impact_event_window_creates_advisory_block_context():
    evidence = build_high_impact_event_evidence(
        events=[event()],
        registry=default_trusted_source_registry(),
        instrument="EUR/USD",
        evaluated_at=NOW,
    )

    assert len(evidence) == 1
    item = evidence[0]
    assert item.instrument == "EURUSD"
    assert item.stance == "BLOCK"
    assert item.verified_sources == 1
    assert item.execution_authority if hasattr(item, "execution_authority") else True
    assert item.metadata["minutesToEvent"] == pytest.approx(10.0)

    assessment = assess_agent_context(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.80,
        evidence=evidence,
        evaluated_at=NOW,
    )
    assert assessment.status == "BLOCKED"
    assert assessment.advisory_only is True
    assert assessment.execution_authority is False


def test_event_family_rejects_noncanonical_identity():
    with pytest.raises(ValueError):
        event(event_family="!! malformed !!")


def test_future_available_event_is_not_visible_to_historical_evaluation():
    future = event(
        observed_at=NOW - timedelta(minutes=1),
        available_at=NOW + timedelta(seconds=1),
    )

    evidence = build_high_impact_event_evidence(
        events=[future],
        registry=default_trusted_source_registry(),
        instrument="EURUSD",
        evaluated_at=NOW,
    )

    assert evidence == []


def test_event_outside_configured_window_does_not_block():
    outside = event(scheduled_for=NOW + timedelta(minutes=31))

    evidence = build_high_impact_event_evidence(
        events=[outside],
        registry=default_trusted_source_registry(),
        instrument="EURUSD",
        evaluated_at=NOW,
        pre_event_minutes=30,
    )

    assert evidence == []


def test_medium_impact_and_untrusted_sources_are_excluded():
    medium = event(impact="MEDIUM")
    unknown = event(source_id="unknown_feed", source_event_id="unknown-1")

    evidence = build_high_impact_event_evidence(
        events=[medium, unknown],
        registry=default_trusted_source_registry(),
        instrument="EURUSD",
        evaluated_at=NOW,
    )

    assert evidence == []


def test_cross_source_event_dedup_counts_only_distinct_trusted_sources():
    registry = TrustedContextSourceRegistry(
        [
            TrustedContextSource(
                source_id="calendar_primary",
                display_name="Primary Calendar",
                source_type="ECONOMIC_CALENDAR",
                currencies={"EUR"},
                credibility=0.85,
                requires_corroboration=True,
            ),
            TrustedContextSource(
                source_id="calendar_backup",
                display_name="Backup Calendar",
                source_type="ECONOMIC_CALENDAR",
                currencies={"EUR"},
                credibility=0.90,
                requires_corroboration=True,
            ),
        ]
    )
    primary = event(
        source_id="calendar_primary",
        source_event_id="p-1",
        scheduled_for=NOW + timedelta(minutes=5, seconds=5),
    )
    primary_duplicate = primary.model_copy(update={"source_event_id": "p-duplicate"})
    backup = event(
        source_id="calendar_backup",
        source_event_id="b-1",
        scheduled_for=NOW + timedelta(minutes=5, seconds=40),
    )

    evidence = build_high_impact_event_evidence(
        events=[primary, primary_duplicate, backup],
        registry=registry,
        instrument="EURUSD",
        evaluated_at=NOW,
    )

    assert len(evidence) == 1
    assert evidence[0].verified_sources == 2
    assert evidence[0].credibility == pytest.approx(0.90)
    assert evidence[0].metadata["verifiedSourceIds"] == [
        "calendar_backup",
        "calendar_primary",
    ]


def test_source_requiring_corroboration_cannot_block_by_itself():
    registry = TrustedContextSourceRegistry(
        [
            TrustedContextSource(
                source_id="single_news",
                display_name="Single News Feed",
                source_type="FINANCIAL_NEWS",
                currencies={"EUR"},
                credibility=0.90,
                requires_corroboration=True,
            )
        ]
    )

    evidence = build_high_impact_event_evidence(
        events=[event(source_id="single_news")],
        registry=registry,
        instrument="EURUSD",
        evaluated_at=NOW,
    )

    assert evidence == []


@pytest.mark.parametrize(
    ("raw", "normalized"),
    [
        ("eurusd", "EURUSD"),
        ("EUR/USD", "EURUSD"),
        ("EUR-USD", "EURUSD"),
        (" EUR_USD ", "EURUSD"),
    ],
)
def test_fx_instrument_normalization(raw, normalized):
    assert normalize_fx_instrument(raw) == normalized


def test_fx_instrument_normalization_rejects_ambiguous_symbols():
    with pytest.raises(ValueError, match="six-letter FX pair"):
        normalize_fx_instrument("EURUSD.r")
