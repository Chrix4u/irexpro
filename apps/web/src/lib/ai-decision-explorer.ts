import { createAiDecisionExplorerApi } from '@irexpro/api-client/ai-decision-explorer';
import type {
  AiDecisionAgentContextView,
  AiDecisionExplorerView,
  AiDecisionOutcome,
  AiDecisionStage,
  AiDecisionStageStatus,
  AiDecisionSummaryView,
  AiDecisionTimelineEntryView,
  AiDecisionTradeView,
} from '@irexpro/types/ai-decision-explorer';
import { api } from '@/lib/api';

const decisionExplorerApi = createAiDecisionExplorerApi(api);

const OUTCOMES = new Set<AiDecisionOutcome>([
  'RECEIVED',
  'IGNORED',
  'RISK_APPROVED',
  'RISK_REJECTED',
  'EXECUTION_SUCCEEDED',
  'EXECUTION_FAILED',
]);
const STAGES = new Set<AiDecisionStage>(['SIGNAL', 'ELIGIBILITY', 'RISK', 'EXECUTION']);
const STAGE_STATUSES = new Set<AiDecisionStageStatus>([
  'RECEIVED',
  'APPROVED',
  'REJECTED',
  'SUCCEEDED',
  'FAILED',
]);
const TRADE_STATUSES = new Set([
  'PENDING',
  'OPEN',
  'CLOSED',
  'REJECTED',
  'CANCELLED',
  'RECONCILIATION_PENDING',
]);
const CLOSE_REASONS = new Set([
  'STOP_LOSS_HIT',
  'TAKE_PROFIT_HIT',
  'MANUAL_CLOSE',
  'AI_CLOSE_SIGNAL',
  'KILL_SWITCH_FORCE_CLOSE',
  'BROKER_CLOSE',
  'RECONCILIATION',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function isNullableIsoString(value: unknown): value is string | null {
  return value === null || isIsoString(value);
}

function isNullableScore(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

const AGENT_CONTEXT_STATUSES = new Set(['ALIGNED', 'CONFLICT', 'INSUFFICIENT', 'BLOCKED']);
const AGENT_CONTEXT_DIRECTIONS = new Set(['BUY', 'SELL', 'NEUTRAL']);
const AGENT_CONTEXT_SOURCE_STATES = new Set(['AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE']);
const AGENT_CONTEXT_SOURCES = new Set(['QUANT', 'MACRO_NEWS', 'REGIME', 'RISK', 'REFLECTION']);
const AGENT_CONTEXT_STANCES = new Set(['BUY', 'SELL', 'NEUTRAL', 'BLOCK']);

function isAgentContext(value: unknown): value is AiDecisionAgentContextView {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'version',
      'status',
      'consensusDirection',
      'weightedSupport',
      'weightedOpposition',
      'disagreementScore',
      'evidenceCount',
      'rejectedCount',
      'evidence',
      'sourceState',
      'evaluatedAt',
      'advisoryOnly',
      'executionAuthority',
    ])
  ) {
    return false;
  }

  if (
    value.version !== 'agent-council-v1' ||
    typeof value.status !== 'string' ||
    !AGENT_CONTEXT_STATUSES.has(value.status) ||
    typeof value.consensusDirection !== 'string' ||
    !AGENT_CONTEXT_DIRECTIONS.has(value.consensusDirection) ||
    typeof value.sourceState !== 'string' ||
    !AGENT_CONTEXT_SOURCE_STATES.has(value.sourceState) ||
    value.advisoryOnly !== true ||
    value.executionAuthority !== false ||
    typeof value.weightedSupport !== 'number' ||
    !Number.isFinite(value.weightedSupport) ||
    value.weightedSupport < 0 ||
    typeof value.weightedOpposition !== 'number' ||
    !Number.isFinite(value.weightedOpposition) ||
    value.weightedOpposition < 0 ||
    typeof value.disagreementScore !== 'number' ||
    !Number.isFinite(value.disagreementScore) ||
    value.disagreementScore < 0 ||
    value.disagreementScore > 1 ||
    typeof value.evidenceCount !== 'number' ||
    !Number.isInteger(value.evidenceCount) ||
    value.evidenceCount < 0 ||
    value.evidenceCount > 100 ||
    typeof value.rejectedCount !== 'number' ||
    !Number.isInteger(value.rejectedCount) ||
    value.rejectedCount < 0 ||
    !isIsoString(value.evaluatedAt) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 10
  ) {
    return false;
  }

  const evidenceValid = value.evidence.every((item) => {
    if (!isRecord(item)) return false;
    return (
      hasExactKeys(item, [
        'source',
        'sourceId',
        'stance',
        'confidence',
        'credibility',
        'verifiedSources',
        'availableAt',
        'summary',
      ]) &&
      typeof item.source === 'string' &&
      AGENT_CONTEXT_SOURCES.has(item.source) &&
      typeof item.sourceId === 'string' &&
      item.sourceId.length > 0 &&
      item.sourceId.length <= 160 &&
      typeof item.stance === 'string' &&
      AGENT_CONTEXT_STANCES.has(item.stance) &&
      typeof item.confidence === 'number' &&
      Number.isFinite(item.confidence) &&
      item.confidence >= 0 &&
      item.confidence <= 1 &&
      typeof item.credibility === 'number' &&
      Number.isFinite(item.credibility) &&
      item.credibility >= 0 &&
      item.credibility <= 1 &&
      typeof item.verifiedSources === 'number' &&
      Number.isInteger(item.verifiedSources) &&
      item.verifiedSources >= 0 &&
      item.verifiedSources <= 100 &&
      isIsoString(item.availableAt) &&
      typeof item.summary === 'string' &&
      item.summary.length > 0 &&
      item.summary.length <= 500
    );
  });
  if (!evidenceValid) return false;

  return !(
    value.sourceState !== 'AVAILABLE' &&
    (value.status !== 'INSUFFICIENT' || value.evidenceCount !== 0 || value.evidence.length !== 0)
  );
}

function isTimelineEntry(value: unknown): value is AiDecisionTimelineEntryView {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['stage', 'status', 'code', 'message', 'at'])) return false;
  return (
    typeof value.stage === 'string' &&
    STAGES.has(value.stage as AiDecisionStage) &&
    typeof value.status === 'string' &&
    STAGE_STATUSES.has(value.status as AiDecisionStageStatus) &&
    isNullableString(value.code) &&
    typeof value.message === 'string' &&
    isIsoString(value.at)
  );
}

function isTrade(value: unknown): value is AiDecisionTradeView {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['tradeId', 'status', 'openedAt', 'closedAt', 'closeReason'])) {
    return false;
  }
  return (
    typeof value.tradeId === 'string' &&
    typeof value.status === 'string' &&
    TRADE_STATUSES.has(value.status) &&
    isNullableIsoString(value.openedAt) &&
    isNullableIsoString(value.closedAt) &&
    (value.closeReason === null ||
      (typeof value.closeReason === 'string' && CLOSE_REASONS.has(value.closeReason)))
  );
}

function isDecision(value: unknown): value is AiDecisionSummaryView {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'signalId',
      'outcome',
      'receivedAt',
      'evidence',
      'agentContext',
      'risk',
      'execution',
      'timeline',
    ])
  ) {
    return false;
  }

  if (
    typeof value.signalId !== 'string' ||
    typeof value.outcome !== 'string' ||
    !OUTCOMES.has(value.outcome as AiDecisionOutcome) ||
    !isIsoString(value.receivedAt)
  ) {
    return false;
  }

  const evidence = value.evidence;
  if (
    !isRecord(evidence) ||
    !hasExactKeys(evidence, [
      'instrument',
      'direction',
      'confidenceScore',
      'strategyCode',
      'modelVersion',
      'timeframe',
      'marketRegime',
      'volatilityScore',
      'generatedAt',
    ]) ||
    !isNullableString(evidence.instrument) ||
    !(evidence.direction === null || evidence.direction === 'BUY' || evidence.direction === 'SELL') ||
    !isNullableScore(evidence.confidenceScore) ||
    !isNullableString(evidence.strategyCode) ||
    !isNullableString(evidence.modelVersion) ||
    !isNullableString(evidence.timeframe) ||
    !isNullableString(evidence.marketRegime) ||
    !isNullableScore(evidence.volatilityScore) ||
    !isNullableIsoString(evidence.generatedAt)
  ) {
    return false;
  }

  const risk = value.risk;
  if (
    !isRecord(risk) ||
    !hasExactKeys(risk, ['decision', 'rejectionCode', 'rejectionReason']) ||
    !(risk.decision === 'APPROVED' || risk.decision === 'REJECTED' || risk.decision === 'UNKNOWN') ||
    !isNullableString(risk.rejectionCode) ||
    !isNullableString(risk.rejectionReason)
  ) {
    return false;
  }

  if (!(value.agentContext === null || isAgentContext(value.agentContext))) return false;
  if (!(value.execution === null || isTrade(value.execution))) return false;
  return Array.isArray(value.timeline) && value.timeline.every(isTimelineEntry);
}

export function isAiDecisionExplorerView(value: unknown): value is AiDecisionExplorerView {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['generatedAt', 'decisions'])) return false;
  return (
    isIsoString(value.generatedAt) &&
    Array.isArray(value.decisions) &&
    value.decisions.every(isDecision)
  );
}

/**
 * Load persisted decision evidence and reject the whole snapshot when the API
 * broadens or mutates its browser contract unexpectedly.
 */
export async function loadAiDecisionExplorer(): Promise<AiDecisionExplorerView> {
  const snapshot = await decisionExplorerApi.getRecentDecisions();
  if (!isAiDecisionExplorerView(snapshot)) {
    throw new Error('AI decision explorer contract mismatch');
  }
  return snapshot;
}
