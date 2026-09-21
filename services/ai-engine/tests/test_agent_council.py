"""Tests for the advisory autonomous Agent Council."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domain.agents import AgentEvidence, assess_agent_context


NOW = datetime(2026, 9, 21, 0, 0, tzinfo=UTC)


def evidence(
    source_id: str,
    stance: str,
    *,
    confidence: float = 0.8,
    credibility: float = 0.9,
    available_at: datetime = NOW,
    instrument: str = "EURUSD",
) -> AgentEvidence:
    return AgentEvidence(
        source="MACRO_NEWS",
        source_id=source_id,
        instrument=instrument,
        stance=stance,
        confidence=confidence,
        credibility=credibility,
        observed_at=available_at - timedelta(seconds=5),
        available_at=available_at,
        summary=f"{source_id} concise verified context",
        verified_sources=2,
    )


def test_aligned_context_supports_quant_without_execution_authority():
    result = assess_agent_context(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.72,
        evidence=[evidence("trusted-1", "BUY")],
        evaluated_at=NOW,
    )

    assert result.status == "ALIGNED"
    assert result.consensus_direction == "BUY"
    assert result.weighted_support == pytest.approx(0.72)
    assert result.disagreement_score == 0
    assert result.advisory_only is True
    assert result.execution_authority is False


def test_conflicting_context_is_explicit_instead_of_overriding_quant():
    result = assess_agent_context(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.75,
        evidence=[
            evidence("bearish-macro", "SELL", confidence=0.95, credibility=0.95),
            evidence("weak-bullish", "BUY", confidence=0.30, credibility=0.50),
        ],
        evaluated_at=NOW,
    )

    assert result.status == "CONFLICT"
    assert result.consensus_direction == "SELL"
    assert result.weighted_opposition > result.weighted_support
    assert result.execution_authority is False


def test_credible_block_context_marks_assessment_blocked_but_remains_advisory():
    result = assess_agent_context(
        instrument="GBPUSD",
        quant_direction="SELL",
        quant_confidence=0.82,
        evidence=[
            AgentEvidence(
                source="RISK",
                source_id="high-impact-event-window",
                instrument="GBPUSD",
                stance="BLOCK",
                confidence=0.90,
                credibility=1.0,
                observed_at=NOW,
                available_at=NOW,
                summary="High-impact macro event window is active.",
                verified_sources=1,
            )
        ],
        evaluated_at=NOW,
    )

    assert result.status == "BLOCKED"
    assert result.consensus_direction == "NEUTRAL"
    assert result.advisory_only is True
    assert result.execution_authority is False


def test_future_stale_and_other_instrument_evidence_are_rejected_causally():
    result = assess_agent_context(
        instrument="EURUSD",
        quant_direction="BUY",
        quant_confidence=0.70,
        evidence=[
            evidence("future", "BUY", available_at=NOW + timedelta(seconds=1)),
            evidence("stale", "SELL", available_at=NOW - timedelta(hours=2)),
            evidence("other-pair", "SELL", instrument="USDJPY"),
        ],
        evaluated_at=NOW,
        max_age_seconds=3600,
    )

    assert result.status == "INSUFFICIENT"
    assert set(result.rejected_source_ids) == {"future", "stale", "other-pair"}
    assert result.evidence_used == []


def test_evidence_rejects_noncausal_availability_order():
    with pytest.raises(ValueError, match="available_at cannot precede observed_at"):
        AgentEvidence(
            source="MACRO_NEWS",
            source_id="bad-clock",
            instrument="EURUSD",
            stance="NEUTRAL",
            confidence=0.5,
            credibility=0.8,
            observed_at=NOW,
            available_at=NOW - timedelta(seconds=1),
            summary="Invalid non-causal evidence.",
        )
