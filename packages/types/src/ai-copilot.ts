import type { AiDecisionOutcome } from './ai-decision-explorer';

export const AI_COPILOT_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
export type AiCopilotTimeframe = (typeof AI_COPILOT_TIMEFRAMES)[number];
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

export interface AiCopilotRequest {
  instrument: string;
  timeframe: AiCopilotTimeframe;
}

export interface AiCopilotMarketView {
  freshness: 'FRESH' | 'STALE';
  bid: string;
  ask: string;
  spread: string;
  quoteAt: string;
  retrievedAt: string;
}

export interface AiCopilotRiskView {
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

export interface AiCopilotDecisionView {
  signalId: string;
  outcome: AiDecisionOutcome;
  direction: 'BUY' | 'SELL' | null;
  confidenceScore: number | null;
  strategyCode: string | null;
  modelVersion: string | null;
  marketRegime: string | null;
  receivedAt: string;
  riskDecision: 'APPROVED' | 'REJECTED' | 'UNKNOWN';
  executionStatus: string | null;
}

export interface AiCopilotStrategyResearchView {
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

export interface AiCopilotEvidenceView {
  source: AiCopilotEvidenceSource;
  state: AiCopilotEvidenceState;
  summary: string;
}

export interface AiCopilotPolicyView {
  explanationOnly: true;
  noTradeInstruction: true;
  hiddenReasoningExposed: false;
  strategyResearchAdvisoryOnly: true;
}

/**
 * Frontend-safe evidence composition. No trade mutation, credential, provider
 * account identifier, hidden model reasoning, or browser-derived risk/financial
 * truth is part of this contract.
 */
export interface AiCopilotView {
  generatedAt: string;
  instrument: string;
  timeframe: AiCopilotTimeframe;
  status: AiCopilotStatus;
  posture: AiCopilotPosture;
  headline: string;
  explanation: string;
  market: AiCopilotMarketView | null;
  risk: AiCopilotRiskView | null;
  decision: AiCopilotDecisionView | null;
  strategyResearch: AiCopilotStrategyResearchView | null;
  evidence: AiCopilotEvidenceView[];
  nextChecks: string[];
  policy: AiCopilotPolicyView;
}
