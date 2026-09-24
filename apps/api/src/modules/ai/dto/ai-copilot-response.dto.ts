export type AiCopilotStatus = 'READY' | 'PARTIAL';
export type AiCopilotPosture = 'NORMAL' | 'CAUTION' | 'BLOCKED';
export type AiCopilotEvidenceState =
  | 'FRESH'
  | 'STALE'
  | 'AVAILABLE'
  | 'NONE'
  | 'UNAVAILABLE'
  | 'BLOCKED';
export type AiCopilotEvidenceSource = 'MARKET' | 'RISK' | 'AI_DECISION' | 'STRATEGY_RESEARCH';

export interface AiCopilotMarketContextDto {
  freshness: 'FRESH' | 'STALE';
  bid: string;
  ask: string;
  spread: string;
  quoteAt: string;
  retrievedAt: string;
}

export interface AiCopilotRiskContextDto {
  killSwitchActive: boolean;
  brokerConnected: boolean;
  riskAcknowledgementAccepted: boolean;
  openPositionSlotsRemaining: number;
  todayTrades: number;
  dailyTradeCountPolicy: 'UNBOUNDED';
  stalePortfolioSnapshots: number;
  unavailablePortfolioSnapshots: number;
  recentViolationCount: number;
}

export interface AiCopilotDecisionContextDto {
  signalId: string;
  outcome: string;
  direction: 'BUY' | 'SELL' | null;
  confidenceScore: number | null;
  strategyCode: string | null;
  modelVersion: string | null;
  marketRegime: string | null;
  receivedAt: string;
  riskDecision: 'APPROVED' | 'REJECTED' | 'UNKNOWN';
  executionStatus: string | null;
}

export interface AiCopilotStrategyResearchContextDto {
  datasetId: string;
  datasetVersion: string;
  asOf: string;
  scenarioId: string;
  marketRegime: string;
  strategyCode: string;
  eligible: boolean;
  score: number;
  advisoryOnly: true;
}

export interface AiCopilotEvidenceDto {
  source: AiCopilotEvidenceSource;
  state: AiCopilotEvidenceState;
  summary: string;
}

export interface AiCopilotPolicyDto {
  explanationOnly: true;
  noTradeInstruction: true;
  hiddenReasoningExposed: false;
  strategyResearchAdvisoryOnly: true;
}

/**
 * Browser-safe contextual explanation assembled from existing authoritative
 * read models. It is not a trading mutation surface and never exposes hidden
 * model reasoning, broker credentials, provider account identifiers, raw risk
 * context, order controls, or browser-derived financial calculations.
 */
export interface AiCopilotResponseDto {
  generatedAt: string;
  instrument: string;
  timeframe: string;
  status: AiCopilotStatus;
  posture: AiCopilotPosture;
  headline: string;
  explanation: string;
  market: AiCopilotMarketContextDto | null;
  risk: AiCopilotRiskContextDto | null;
  decision: AiCopilotDecisionContextDto | null;
  strategyResearch: AiCopilotStrategyResearchContextDto | null;
  evidence: AiCopilotEvidenceDto[];
  nextChecks: string[];
  policy: AiCopilotPolicyDto;
}
