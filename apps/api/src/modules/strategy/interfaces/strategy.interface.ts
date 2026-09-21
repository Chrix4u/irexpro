/**
 * AiSignalCandidate — Input type received from the AI Signal Engine.
 *
 * IMPORTANT: This is a safe signal intake structure, NOT a real AI model.
 * The AI Signal Engine (Python FastAPI microservice) generates these candidates.
 * This NestJS service validates and routes them — it does NOT generate signals.
 *
 * Pipeline:
 *   AiSignalCandidate → StrategyOrchestrator → BrokerConnectionGate → RiskEngine
 *   → ExecutionEngine → Broker
 *   (never: AiSignalCandidate → Broker directly)
 *
 * Subscription/payment state is not part of the trading-access pipeline.
 *
 * See: docs/architecture/10-ai-trading-architecture.md
 */
export type AiAgentContextStatus = 'ALIGNED' | 'CONFLICT' | 'INSUFFICIENT' | 'BLOCKED';
export type AiAgentContextSourceState = 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_APPLICABLE';

export interface AiAgentContextEvidence {
  source: 'QUANT' | 'MACRO_NEWS' | 'REGIME' | 'RISK' | 'REFLECTION';
  sourceId: string;
  stance: 'BUY' | 'SELL' | 'NEUTRAL' | 'BLOCK';
  confidence: number;
  credibility: number;
  verifiedSources: number;
  availableAt: string;
  summary: string;
}

/**
 * Browser-safe advisory context captured by the AI engine.
 *
 * This object is evidence only. It cannot carry broker credentials, raw
 * provider metadata, position sizing, execution commands, or model reasoning.
 */
export interface AiAgentContextSnapshot {
  version: 'agent-council-v1';
  status: AiAgentContextStatus;
  consensusDirection: 'BUY' | 'SELL' | 'NEUTRAL';
  weightedSupport: number;
  weightedOpposition: number;
  disagreementScore: number;
  evidenceCount: number;
  rejectedCount: number;
  evidence: AiAgentContextEvidence[];
  sourceState: AiAgentContextSourceState;
  evaluatedAt: string;
  advisoryOnly: true;
  executionAuthority: false;
}

export interface AiSignalCandidate {
  /** Unique signal ID (UUID, provided by AI service) */
  signalId: string;

  /** Target user */
  userId: string;

  /** The trading session this signal is intended for */
  tradingSessionId: string;

  /** The broker connection to use for execution */
  brokerConnectionId: string;

  /** Forex pair (e.g. EURUSD, GBPJPY) */
  instrument: string;

  /** Trade direction */
  direction: 'BUY' | 'SELL';

  /**
   * Model confidence score (0–1).
   * Signals below CONFIDENCE_THRESHOLD are ignored by the orchestrator.
   */
  confidenceScore: number;

  /** Optional suggested entry price (null = market order) */
  suggestedEntryPrice?: number;

  /** Mandatory stop-loss price — Risk Engine validates SL distance */
  suggestedStopLoss: number;

  /** Mandatory take-profit price — Risk Engine validates TP direction */
  suggestedTakeProfit: number;

  /** Requested lot size — Risk Engine may reduce or reject */
  suggestedVolume: number;

  /** Chart timeframe (e.g. M15, H1, H4, D1) */
  timeframe: string;

  /** Internal strategy code identifier */
  strategyCode: string;

  /** Market regime label (e.g. trending, ranging, volatile) */
  marketRegime?: string;

  /** Volatility score (0–1) */
  volatilityScore?: number;

  /** When this signal was generated (ISO timestamp) */
  generatedAt: Date;

  /** AI model version that generated the signal */
  modelVersion: string;

  /** Advisory Agent Council snapshot; never execution authority. */
  agentContext?: AiAgentContextSnapshot | null;

  /** Optional opaque metadata for audit/debugging */
  metadata?: Record<string, unknown>;
}

/** StrategyResult — outcome of processing an AiSignalCandidate. */
export type StrategyOutcome =
  | 'SIGNAL_INVALID'
  | 'LOW_CONFIDENCE'
  | 'SESSION_INACTIVE'
  | 'NO_BROKER_CONNECTION'
  | 'RISK_REJECTED'
  | 'RISK_SUSPENDED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_SUCCEEDED'
  /** Round 5 (#298): SEMI_AUTO approval awaiting the user one-time confirmation. */
  | 'EXECUTION_PENDING_CONFIRMATION';

/**
 * Round 6 (#302): durable duplicate-recovery descriptor — what the FIRST
 * delivery's persisted outcome was, when a duplicate re-delivery was
 * recovered from it instead of re-entering risk evaluation/dispatch.
 */
export interface StrategyDuplicateOfTrade {
  /** Existing trade id — null when the original evaluation produced NO trade. */
  tradeId: string | null;
  /** Existing trade status; 'REJECTED_PREVIOUSLY' when no trade exists. */
  tradeStatus: string;
  /** Strategy outcome the duplicate delivery was recovered as. */
  recoveredAs: StrategyOutcome;
}

export interface StrategyResult {
  outcome: StrategyOutcome;
  signalId: string;
  tradeId?: string;
  reason?: string;
  /**
   * Round 6 (#302): set when a duplicate signal delivery was recovered from
   * the first delivery's durable outcome (deterministic duplicates — never a
   * fresh risk evaluation or provider dispatch for the same signalId).
   */
  duplicateOfTrade?: StrategyDuplicateOfTrade;
}
