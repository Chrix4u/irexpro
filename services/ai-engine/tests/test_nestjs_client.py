"""Tests for NestJsClient."""
from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.errors import NestJsIntegrationError
from app.domain.agents.snapshot import (
    AgentContextEvidenceSnapshot,
    AgentContextSnapshot,
)
from app.domain.signals.schemas import AiSignalCandidate
from app.integrations.nestjs_client import INTERNAL_API_KEY_HEADER, NestJsClient, _to_nestjs_payload


def make_candidate() -> AiSignalCandidate:
    return AiSignalCandidate(
        user_id="u1",
        trading_session_id="s1",
        broker_connection_id="c1",
        instrument="EURUSD",
        direction="BUY",
        confidence_score=0.75,
        suggested_stop_loss=1.07000,
        suggested_take_profit=1.10000,
        suggested_volume=0.01,
        timeframe="H1",
        strategy_code="baseline-h1",
        model_version="baseline-xgboost-v0.1.0",
        generated_at=datetime.now(UTC),
    )


def test_to_nestjs_payload_uses_camel_case():
    candidate = make_candidate()
    payload = _to_nestjs_payload(candidate)
    assert "signalId" in payload
    assert "userId" in payload
    assert "tradingSessionId" in payload
    assert "confidenceScore" in payload
    assert "suggestedStopLoss" in payload
    assert "suggestedTakeProfit" in payload
    assert "modelVersion" in payload
    assert "generatedAt" in payload


def test_to_nestjs_payload_projects_agent_context_without_provider_metadata():
    candidate = make_candidate()
    candidate.agent_context = AgentContextSnapshot(
        status="BLOCKED",
        consensus_direction="NEUTRAL",
        weighted_support=0.0,
        weighted_opposition=0.0,
        disagreement_score=0.0,
        evidence_count=1,
        rejected_count=0,
        evidence=[
            AgentContextEvidenceSnapshot(
                source="MACRO_NEWS",
                source_id="macro-event:abc",
                stance="BLOCK",
                confidence=1.0,
                credibility=1.0,
                verified_sources=1,
                available_at=datetime.now(UTC),
                summary="High-impact USD CPI event is within the configured risk window.",
            )
        ],
        source_state="AVAILABLE",
        evaluated_at=datetime.now(UTC),
    )

    payload = _to_nestjs_payload(candidate)
    context = payload["agentContext"]

    assert context["status"] == "BLOCKED"
    assert context["consensusDirection"] == "NEUTRAL"
    assert context["advisoryOnly"] is True
    assert context["executionAuthority"] is False
    assert context["evidence"][0]["source"] == "MACRO_NEWS"
    assert "metadata" not in context["evidence"][0]


def test_to_nestjs_payload_no_secrets():
    """Payload must not contain secret-like fields."""
    candidate = make_candidate()
    payload = _to_nestjs_payload(candidate)
    forbidden = ["password", "accessToken", "refreshToken", "apiKey", "encryptedCredentials"]
    for field in forbidden:
        assert field not in payload, f"Forbidden field '{field}' found in payload"


@pytest.mark.asyncio
async def test_nestjs_client_builds_correct_headers():
    """Client must include the internal API key header."""
    settings = MagicMock()
    settings.nestjs_internal_api_key = "test-key-abc"
    settings.nestjs_signal_url = "http://localhost:3000/api/v1/ai/internal/signals"

    client = NestJsClient(settings=settings)
    headers = client._get_headers()
    assert headers[INTERNAL_API_KEY_HEADER] == "test-key-abc"
    assert headers["Content-Type"] == "application/json"


@pytest.mark.asyncio
async def test_nestjs_client_raises_on_non_200():
    """Should raise NestJsIntegrationError on non-2xx response."""
    settings = MagicMock()
    settings.nestjs_internal_api_key = "test-key"
    settings.nestjs_signal_url = "http://localhost:3000/api/v1/ai/internal/signals"

    candidate = make_candidate()
    client = NestJsClient(settings=settings)

    mock_response = MagicMock()
    mock_response.status_code = 401

    with patch("app.integrations.nestjs_client.httpx.AsyncClient") as mock_http:
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_ctx)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_ctx.post = AsyncMock(return_value=mock_response)
        mock_http.return_value = mock_ctx

        with pytest.raises(NestJsIntegrationError):
            await client.publish_signal(candidate)


@pytest.mark.asyncio
async def test_nestjs_client_metadata_secret_filtering():
    """Metadata in signal must not contain forbidden fields before publishing."""
    from app.core.security import sanitize_metadata

    dirty_metadata = {
        "explainability_version": "1.0",
        "password": "should-be-removed",
        "apiKey": "also-removed",
        "method": "heuristic",
    }
    clean = sanitize_metadata(dirty_metadata)
    assert "password" not in clean
    assert "apiKey" not in clean
    assert "explainability_version" in clean
    assert "method" in clean
