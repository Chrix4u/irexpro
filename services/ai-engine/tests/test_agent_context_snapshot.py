"""Tests for strict cross-service Agent Council snapshots."""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.domain.agents.snapshot import (
    AgentContextEvidenceSnapshot,
    AgentContextSnapshot,
)

NOW = datetime(2026, 9, 21, 2, 0, tzinfo=UTC)


def test_snapshot_requires_timezone_aware_timestamps():
    with pytest.raises(ValueError, match="evaluated_at must be timezone-aware"):
        AgentContextSnapshot(
            status="INSUFFICIENT",
            consensus_direction="NEUTRAL",
            weighted_support=0,
            weighted_opposition=0,
            disagreement_score=0,
            evidence_count=0,
            rejected_count=0,
            evidence=[],
            source_state="AVAILABLE",
            evaluated_at=datetime(2026, 9, 21, 2, 0),
        )

    with pytest.raises(ValueError, match="available_at must be timezone-aware"):
        AgentContextEvidenceSnapshot(
            source="MACRO_NEWS",
            source_id="macro-event:test",
            stance="BLOCK",
            confidence=1,
            credibility=1,
            verified_sources=1,
            available_at=datetime(2026, 9, 21, 2, 0),
            summary="High-impact event context.",
        )


@pytest.mark.parametrize("source_state", ["UNAVAILABLE", "NOT_APPLICABLE"])
def test_nonavailable_source_state_cannot_claim_blocking_context(source_state):
    with pytest.raises(ValueError, match="must have INSUFFICIENT status"):
        AgentContextSnapshot(
            status="BLOCKED",
            consensus_direction="NEUTRAL",
            weighted_support=0,
            weighted_opposition=0,
            disagreement_score=0,
            evidence_count=0,
            rejected_count=0,
            evidence=[],
            source_state=source_state,
            evaluated_at=NOW,
        )


def test_nonavailable_source_state_cannot_carry_accepted_evidence():
    item = AgentContextEvidenceSnapshot(
        source="MACRO_NEWS",
        source_id="macro-event:test",
        stance="BLOCK",
        confidence=1,
        credibility=1,
        verified_sources=1,
        available_at=NOW,
        summary="High-impact event context.",
    )

    with pytest.raises(ValueError, match="cannot contain accepted evidence"):
        AgentContextSnapshot(
            status="INSUFFICIENT",
            consensus_direction="NEUTRAL",
            weighted_support=0,
            weighted_opposition=0,
            disagreement_score=0,
            evidence_count=1,
            rejected_count=0,
            evidence=[item],
            source_state="UNAVAILABLE",
            evaluated_at=NOW,
        )


def test_evidence_count_cannot_understate_projected_evidence():
    item = AgentContextEvidenceSnapshot(
        source="MACRO_NEWS",
        source_id="macro-event:test",
        stance="BLOCK",
        confidence=1,
        credibility=1,
        verified_sources=1,
        available_at=NOW,
        summary="High-impact event context.",
    )

    with pytest.raises(ValueError, match="evidence_count cannot be less"):
        AgentContextSnapshot(
            status="BLOCKED",
            consensus_direction="NEUTRAL",
            weighted_support=0,
            weighted_opposition=0,
            disagreement_score=0,
            evidence_count=0,
            rejected_count=0,
            evidence=[item],
            source_state="AVAILABLE",
            evaluated_at=NOW,
        )
