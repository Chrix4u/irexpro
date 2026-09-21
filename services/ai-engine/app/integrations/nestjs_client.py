"""
NestJsClient — publishes AiSignalCandidate to the NestJS internal signals endpoint.

IMPORTANT:
- Signals are NEVER executed here.
- This client only POSTs the candidate to NestJS.
- NestJS routes through AiSignalService → StrategyOrchestrator → Risk Engine → Execution.
- The internal API key header must match NESTJS_INTERNAL_API_KEY in the NestJS .env.

Endpoint: POST {NESTJS_API_BASE_URL}{NESTJS_AI_SIGNAL_ENDPOINT}
Header:   x-irexpro-internal-api-key: <key>
"""
from __future__ import annotations

from datetime import datetime

import httpx

from app.core.config import get_settings
from app.core.errors import NestJsIntegrationError
from app.core.logging import get_logger
from app.domain.signals.schemas import AiSignalCandidate

logger = get_logger(__name__)

INTERNAL_API_KEY_HEADER = "x-irexpro-internal-api-key"
HTTP_TIMEOUT_SECONDS = 10.0


def _to_nestjs_payload(candidate: AiSignalCandidate) -> dict:
    """Convert AiSignalCandidate to the NestJS expected field names (camelCase)."""
    return {
        "signalId": candidate.signal_id,
        "userId": candidate.user_id,
        "tradingSessionId": candidate.trading_session_id,
        "brokerConnectionId": candidate.broker_connection_id,
        "instrument": candidate.instrument,
        "direction": candidate.direction,
        "confidenceScore": candidate.confidence_score,
        "suggestedEntryPrice": candidate.suggested_entry_price,
        "suggestedStopLoss": candidate.suggested_stop_loss,
        "suggestedTakeProfit": candidate.suggested_take_profit,
        "suggestedVolume": candidate.suggested_volume,
        "timeframe": candidate.timeframe,
        "strategyCode": candidate.strategy_code,
        "marketRegime": candidate.market_regime,
        "volatilityScore": candidate.volatility_score,
        "generatedAt": candidate.generated_at.isoformat(),
        "modelVersion": candidate.model_version,
        "agentContext": (
            {
                "version": candidate.agent_context.version,
                "status": candidate.agent_context.status,
                "consensusDirection": candidate.agent_context.consensus_direction,
                "weightedSupport": candidate.agent_context.weighted_support,
                "weightedOpposition": candidate.agent_context.weighted_opposition,
                "disagreementScore": candidate.agent_context.disagreement_score,
                "evidenceCount": candidate.agent_context.evidence_count,
                "rejectedCount": candidate.agent_context.rejected_count,
                "evidence": [
                    {
                        "source": item.source,
                        "sourceId": item.source_id,
                        "stance": item.stance,
                        "confidence": item.confidence,
                        "credibility": item.credibility,
                        "verifiedSources": item.verified_sources,
                        "availableAt": item.available_at.isoformat(),
                        "summary": item.summary,
                    }
                    for item in candidate.agent_context.evidence
                ],
                "sourceState": candidate.agent_context.source_state,
                "evaluatedAt": candidate.agent_context.evaluated_at.isoformat(),
                "advisoryOnly": candidate.agent_context.advisory_only,
                "executionAuthority": candidate.agent_context.execution_authority,
            }
            if candidate.agent_context is not None
            else None
        ),
        "metadata": candidate.metadata,
    }


class NestJsClient:
    """HTTP client for publishing AI signal candidates to the NestJS API."""

    def __init__(self, settings=None) -> None:
        self._settings = settings or get_settings()

    def _get_headers(self) -> dict[str, str]:
        return {
            INTERNAL_API_KEY_HEADER: self._settings.nestjs_internal_api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def publish_signal(self, candidate: AiSignalCandidate) -> dict:
        """
        POST the signal candidate to NestJS.
        Returns the NestJS response payload on success.
        Raises NestJsIntegrationError on failure.
        """
        url = self._settings.nestjs_signal_url
        payload = _to_nestjs_payload(candidate)

        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
                response = await client.post(url, json=payload, headers=self._get_headers())

            if response.status_code in (200, 201):
                logger.info(
                    "Signal published to NestJS",
                    signal_id=candidate.signal_id,
                    instrument=candidate.instrument,
                    status=response.status_code,
                )
                return response.json()
            else:
                logger.warning(
                    "NestJS rejected signal",
                    signal_id=candidate.signal_id,
                    status=response.status_code,
                    # NOTE: Do not log response body — may contain sensitive context
                )
                raise NestJsIntegrationError(
                    f"NestJS returned HTTP {response.status_code} for signal {candidate.signal_id}"
                )
        except NestJsIntegrationError:
            raise
        except Exception as e:
            logger.error("NestJS client error", error=str(e), signal_id=candidate.signal_id)
            raise NestJsIntegrationError(f"Failed to reach NestJS API: {e}") from e

    async def health_check(self) -> dict:
        """Ping the NestJS health endpoint to verify connectivity."""
        health_url = f"{self._settings.nestjs_api_base_url.rstrip('/v1')}/health"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(health_url)
            return {
                "nestjs_reachable": response.status_code == 200,
                "status_code": response.status_code,
                "checked_at": datetime.utcnow().isoformat(),
            }
        except Exception as e:
            return {
                "nestjs_reachable": False,
                "error": str(e),
                "checked_at": datetime.utcnow().isoformat(),
            }
