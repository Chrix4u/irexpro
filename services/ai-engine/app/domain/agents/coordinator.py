"""Deterministic coordinator for advisory specialist-agent evidence."""
from __future__ import annotations

from datetime import UTC, datetime

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
    if now.tzinfo is None:
        raise ValueError("evaluated_at must be timezone-aware")
    if quant_direction not in {"BUY", "SELL"}:
        raise ValueError("quant_direction must be BUY or SELL")
    if not 0.0 <= quant_confidence <= 1.0:
        raise ValueError("quant_confidence must be between 0 and 1")
    if max_age_seconds < 0:
        raise ValueError("max_age_seconds cannot be negative")

    instrument_code = instrument.upper()
    accepted: list[AgentEvidence] = []
    rejected: list[str] = []

    for item in evidence:
        if item.instrument.upper() != instrument_code:
            rejected.append(item.source_id)
            continue
        if item.available_at > now:
            rejected.append(item.source_id)
            continue
        age_seconds = max(0.0, (now - item.available_at).total_seconds())
        if age_seconds > max_age_seconds:
            rejected.append(item.source_id)
            continue
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
    elif opposition > support:
        status = "CONFLICT"
        consensus = "SELL" if quant_direction == "BUY" else "BUY"
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
