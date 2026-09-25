import { createAiCopilotApi } from '@irexpro/api-client/ai-copilot';
import type {
  AiCopilotDecisionView,
  AiCopilotEvidenceSource,
  AiCopilotEvidenceState,
  AiCopilotEvidenceView,
  AiCopilotMarketView,
  AiCopilotPosture,
  AiCopilotRequest,
  AiCopilotRiskView,
  AiCopilotStatus,
  AiCopilotStrategyResearchView,
  AiCopilotTimeframe,
  AiCopilotView,
} from '@irexpro/types/ai-copilot';
import type { AiDecisionOutcome } from '@irexpro/types/ai-decision-explorer';
import { api } from '@/lib/api';

const copilotApi = createAiCopilotApi(api);
const TIMEFRAMES = new Set<AiCopilotTimeframe>(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']);
const STATUSES = new Set<AiCopilotStatus>(['READY', 'PARTIAL']);
const POSTURES = new Set<AiCopilotPosture>(['NORMAL', 'CAUTION', 'BLOCKED']);
const EVIDENCE_SOURCES = new Set<AiCopilotEvidenceSource>([
  'MARKET',
  'RISK',
  'AI_DECISION',
  'STRATEGY_RESEARCH',
]);
const EVIDENCE_STATES = new Set<AiCopilotEvidenceState>([
  'FRESH',
  'STALE',
  'AVAILABLE',
  'NONE',
  'UNAVAILABLE',
  'BLOCKED',
]);
const OUTCOMES = new Set<AiDecisionOutcome>([
  'RECEIVED',
  'IGNORED',
  'RISK_APPROVED',
  'RISK_REJECTED',
  'EXECUTION_SUCCEEDED',
  'EXECUTION_FAILED',
]);
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const INSTRUMENT = /^[A-Z0-9._-]{3,24}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value) && Number.isFinite(Number(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableScore(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isMarket(value: unknown): value is AiCopilotMarketView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['freshness', 'bid', 'ask', 'spread', 'quoteAt', 'retrievedAt'])
  ) {
    return false;
  }

  return (
    (value.freshness === 'FRESH' || value.freshness === 'STALE') &&
    isDecimal(value.bid) &&
    isDecimal(value.ask) &&
    isDecimal(value.spread) &&
    isIsoString(value.quoteAt) &&
    isIsoString(value.retrievedAt)
  );
}

function isRisk(value: unknown): value is AiCopilotRiskView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'killSwitchActive',
      'brokerConnected',
      'riskAcknowledgementAccepted',
      'openPositionSlotsRemaining',
      'todayTrades',
      'dailyTradeCountPolicy',
      'stalePortfolioSnapshots',
      'unavailablePortfolioSnapshots',
      'recentViolationCount',
    ])
  ) {
    return false;
  }

  return (
    typeof value.killSwitchActive === 'boolean' &&
    typeof value.brokerConnected === 'boolean' &&
    typeof value.riskAcknowledgementAccepted === 'boolean' &&
    isNonNegativeInteger(value.openPositionSlotsRemaining) &&
    isNonNegativeInteger(value.todayTrades) &&
    value.dailyTradeCountPolicy === 'UNBOUNDED' &&
    isNonNegativeInteger(value.stalePortfolioSnapshots) &&
    isNonNegativeInteger(value.unavailablePortfolioSnapshots) &&
    isNonNegativeInteger(value.recentViolationCount)
  );
}

function isDecision(value: unknown): value is AiCopilotDecisionView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'signalId',
      'outcome',
      'direction',
      'confidenceScore',
      'strategyCode',
      'modelVersion',
      'marketRegime',
      'receivedAt',
      'riskDecision',
      'executionStatus',
    ])
  ) {
    return false;
  }

  return (
    typeof value.signalId === 'string' &&
    value.signalId.length > 0 &&
    typeof value.outcome === 'string' &&
    OUTCOMES.has(value.outcome as AiDecisionOutcome) &&
    (value.direction === null || value.direction === 'BUY' || value.direction === 'SELL') &&
    isNullableScore(value.confidenceScore) &&
    isNullableString(value.strategyCode) &&
    isNullableString(value.modelVersion) &&
    isNullableString(value.marketRegime) &&
    isIsoString(value.receivedAt) &&
    (value.riskDecision === 'APPROVED' ||
      value.riskDecision === 'REJECTED' ||
      value.riskDecision === 'UNKNOWN') &&
    isNullableString(value.executionStatus)
  );
}

function isStrategyResearch(value: unknown): value is AiCopilotStrategyResearchView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'datasetId',
      'datasetVersion',
      'asOf',
      'scenarioId',
      'marketRegime',
      'strategyCode',
      'eligible',
      'score',
      'advisoryOnly',
    ])
  ) {
    return false;
  }

  return (
    typeof value.datasetId === 'string' &&
    typeof value.datasetVersion === 'string' &&
    isIsoString(value.asOf) &&
    typeof value.scenarioId === 'string' &&
    typeof value.marketRegime === 'string' &&
    typeof value.strategyCode === 'string' &&
    typeof value.eligible === 'boolean' &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.advisoryOnly === true
  );
}

function isEvidence(value: unknown): value is AiCopilotEvidenceView {
  if (!isRecord(value) || !hasExactKeys(value, ['source', 'state', 'summary'])) return false;
  return (
    typeof value.source === 'string' &&
    EVIDENCE_SOURCES.has(value.source as AiCopilotEvidenceSource) &&
    typeof value.state === 'string' &&
    EVIDENCE_STATES.has(value.state as AiCopilotEvidenceState) &&
    typeof value.summary === 'string' &&
    value.summary.length > 0
  );
}

export function isAiCopilotView(value: unknown): value is AiCopilotView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'generatedAt',
      'instrument',
      'timeframe',
      'status',
      'posture',
      'headline',
      'explanation',
      'market',
      'risk',
      'decision',
      'strategyResearch',
      'evidence',
      'nextChecks',
      'policy',
    ])
  ) {
    return false;
  }

  if (
    !isIsoString(value.generatedAt) ||
    typeof value.instrument !== 'string' ||
    !INSTRUMENT.test(value.instrument) ||
    typeof value.timeframe !== 'string' ||
    !TIMEFRAMES.has(value.timeframe as AiCopilotTimeframe) ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status as AiCopilotStatus) ||
    typeof value.posture !== 'string' ||
    !POSTURES.has(value.posture as AiCopilotPosture) ||
    typeof value.headline !== 'string' ||
    typeof value.explanation !== 'string' ||
    !(value.market === null || isMarket(value.market)) ||
    !(value.risk === null || isRisk(value.risk)) ||
    !(value.decision === null || isDecision(value.decision)) ||
    !(value.strategyResearch === null || isStrategyResearch(value.strategyResearch)) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(isEvidence) ||
    !Array.isArray(value.nextChecks) ||
    !value.nextChecks.every((item) => typeof item === 'string' && item.length > 0) ||
    !isRecord(value.policy) ||
    !hasExactKeys(value.policy, [
      'explanationOnly',
      'noTradeInstruction',
      'hiddenReasoningExposed',
      'strategyResearchAdvisoryOnly',
    ])
  ) {
    return false;
  }

  return (
    value.policy.explanationOnly === true &&
    value.policy.noTradeInstruction === true &&
    value.policy.hiddenReasoningExposed === false &&
    value.policy.strategyResearchAdvisoryOnly === true
  );
}

export async function loadAiCopilot(request: AiCopilotRequest): Promise<AiCopilotView> {
  const snapshot = await copilotApi.getContext(request);
  if (!isAiCopilotView(snapshot)) {
    throw new Error('Contextual AI Copilot contract mismatch');
  }
  return snapshot;
}
