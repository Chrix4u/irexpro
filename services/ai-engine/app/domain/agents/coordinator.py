"""Deterministic coordinator for advisory specialist-agent evidence."""
from __future__ import annotations

from datetime import UTC, datetime
from math import isfinite

from app.domain.agents.schemas import AgentCouncilAssessment, AgentEvidence


def assess_agent_context(
    *,
    instrument: str,
    quant_direction: str,
    quant_confidence: float,
    evidence: list[AgentEvidence],
    evaluated_at: datetime | None = None,
    max_age_seconds: int = 3600,
    minimum_context_weight: float = 0.20,
    block_weight_threshold: float = 0.50,
) -> AgentCouncilAssessment:
    """Synthesize causal context without creating an execution action."""
    now = evaluated_at or datetime.now(UTC)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("evaluated_at must be timezone-aware")
    if quant_direction not in {"BUY", "SELL"}:
        raise ValueError("quant_direction must be BUY or SELL")
    if not isfinite(quant_confidence) or not 0.0 <= quant_confidence <= 1.0:
        raise ValueError("quant_confidence must be finite and between 0 and 1")
    if not isfinite(max_age_seconds) or max_age_seconds < 0:
        raise ValueError("max_age_seconds must be finite and non-negative")
    if not isfinite(minimum_context_weight) or minimum_context_weight <= 0:
        raise ValueError("minimum_context_weight must be finite and greater than 0")
    if (
        not isfinite(block_weight_threshold)
        or not 0.0 < block_weight_threshold <= 1.0
    ):
        raise ValueError(
            "block_weight_threshold must be finite, greater than 0, and at most 1"
        )

    instrument_code = instrument.strip().upper()
    if not instrument_code:
        raise ValueError("instrument cannot be empty")

    accepted: list[AgentEvidence] = []
    rejected: list[str] = []
    seen_evidence: set[tuple[str, str]] = set()

    for item in evidence:
        if item.source == "QUANT":
            rejected.append(item.source_id)
            continue
        if item.instrument.strip().upper() != instrument_code:
            rejected.append(item.source_id)
            continue
        if item.available_at > now:
            rejected.append(item.source_id)
            continue
        age_seconds = max(0.0, (now - item.available_at).total_seconds())
        if age_seconds > max_age_seconds:
            rejected.append(item.source_id)
            continue
        if item.source == "MACRO_NEWS" and item.verified_sources < 1:
            rejected.append(item.source_id)
            continue

        evidence_key = (item.source, item.source_id.strip().casefold())
        if evidence_key in seen_evidence:
            rejected.append(item.source_id)
            continue
        seen_evidence.add(evidence_key)
        accepted.append(item)

    support = 0.0
    opposition = 0.0
    block_weight = 0.0

    for item in accepted:
        weight = item.confidence * item.credibility
        if item.stance == "BLOCK":
            block_weight = max(block_weight, weight)
        elif item.stance == quant_direction:
            support += weight
        elif item.stance in {"BUY", "SELL"}:
            opposition += weight

    directional_weight = support + opposition
    disagreement = (
        opposition / directional_weight if directional_weight > 0 else 0.0
    )

    if block_weight >= block_weight_threshold:
        status = "BLOCKED"
        consensus = "NEUTRAL"
    elif directional_weight < minimum_context_weight:
        status = "INSUFFICIENT"
        consensus = "NEUTRAL"
    elif opposition >= support:
        status = "CONFLICT"
        consensus = (
            "NEUTRAL"
            if opposition == support
            else ("SELL" if quant_direction == "BUY" else "BUY")
        )
    else:
        status = "ALIGNED"
        consensus = quant_direction

    return AgentCouncilAssessment(
        instrument=instrument_code,
        quant_direction=quant_direction,
        quant_confidence=quant_confidence,
        status=status,
        consensus_direction=consensus,
        weighted_support=round(support, 6),
        weighted_opposition=round(opposition, 6),
        disagreement_score=round(disagreement, 6),
        evidence_used=accepted,
        rejected_source_ids=rejected,
        generated_at=now,
    )
