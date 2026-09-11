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

export interface StrategyResult {
  outcome: StrategyOutcome;
  signalId: string;
  tradeId?: string;
  reason?: string;
}
