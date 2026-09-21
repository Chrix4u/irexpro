export type AiDecisionOutcome =
  | 'RECEIVED'
  | 'IGNORED'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'EXECUTION_SUCCEEDED'
  | 'EXECUTION_FAILED';

export type AiDecisionStage = 'SIGNAL' | 'ELIGIBILITY' | 'RISK' | 'EXECUTION';

export type AiDecisionStageStatus =
  | 'RECEIVED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUCCEEDED'
  | 'FAILED';

export interface AiDecisionAgentContextEvidenceView {
  source: 'QUANT' | 'MACRO_NEWS' | 'REGIME' | 'RISK' | 'REFLECTION';
  sourceId: string;
  stance: 'BUY' | 'SELL' | 'NEUTRAL' | 'BLOCK';
  confidence: number;
  credibility: number;
  verifiedSources: number;
  availableAt: string;
  summary: string;
}

export interface AiDecisionAgentContextView {
  version: 'agent-council-v1';
  status: 'ALIGNED' | 'CONFLICT' | 'INSUFFICIENT' | 'BLOCKED';
  consensusDirection: 'BUY' | 'SELL' | 'NEUTRAL';
  weightedSupport: number;
  weightedOpposition: number;
  disagreementScore: number;
  evidenceCount: number;
  rejectedCount: number;
  evidence: AiDecisionAgentContextEvidenceView[];
  sourceState: 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  evaluatedAt: string;
  advisoryOnly: true;
  executionAuthority: false;
}

export interface AiDecisionEvidenceView {
  instrument: string | null;
  direction: 'BUY' | 'SELL' | null;
  confidenceScore: number | null;
  strategyCode: string | null;
  modelVersion: string | null;
  timeframe: string | null;
  marketRegime: string | null;
  volatilityScore: number | null;
  generatedAt: string | null;
}

export interface AiDecisionTimelineEntryView {
  stage: AiDecisionStage;
  status: AiDecisionStageStatus;
  code: string | null;
  message: string;
  at: string;
}

export interface AiDecisionTradeView {
  tradeId: string;
  status: string;
  openedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
}

export interface AiDecisionSummaryView {
  signalId: string;
  outcome: AiDecisionOutcome;
  receivedAt: string;
  evidence: AiDecisionEvidenceView;
  agentContext: AiDecisionAgentContextView | null;
  risk: {
    decision: 'APPROVED' | 'REJECTED' | 'UNKNOWN';
    rejectionCode: string | null;
    rejectionReason: string | null;
  };
  execution: AiDecisionTradeView | null;
  timeline: AiDecisionTimelineEntryView[];
}

/**
 * Browser-safe AI decision evidence.
 *
 * This contract intentionally excludes opaque model metadata, raw riskContext,
 * chain-of-thought, provider metadata, credentials, idempotency keys, prices, P&L, and internal
 * error payloads. Missing historical evidence is represented explicitly by
 * null/UNKNOWN rather than inferred in the browser.
 */
export interface AiDecisionExplorerView {
  generatedAt: string;
  decisions: AiDecisionSummaryView[];
}
