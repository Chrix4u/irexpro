/**
 * Risk Engine interfaces for iRexPro.
 *
 * These types define the complete contract between the AI Signal pipeline
 * and the Risk Engine. No trade may proceed without passing through these types.
 *
 * CORE INVARIANT: The Risk Engine is FAIL CLOSED.
 *   - APPROVED: trade may proceed to ExecutionService
 *   - REJECTED: trade is blocked; reason recorded in RiskViolation
 *   - SUSPENDED: trading session has been suspended pending manual review
 *   - Any unexpected error → REJECTED with code RISK_ENGINE_ERROR
 *
 * See: docs/architecture/11-risk-engine-architecture.md
 */

// ─── Decision types ───────────────────────────────────────────────────────────

export type RiskDecisionStatus = 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface RiskApprovalResult {
  decision: 'APPROVED';
  signalId: string;
  validatedOrder: ValidatedOrder;
  appliedRules: string[];
  riskScore: number;
  evaluatedAt: Date;
  /** Sprint 32 Gate 2: passed to ExecutionService for the final atomic
   * advisory-lock daily-trade-slot reservation. */
  maxDailyTrades: number;
}

export interface RiskRejectionResult {
  decision: 'REJECTED' | 'SUSPENDED';
  signalId: string;
  rejectionCode: RiskRejectionCode;
  rejectionReason: string;
  evaluatedAt: Date;
}

export type RiskDecision = RiskApprovalResult | RiskRejectionResult;

// ─── Validated order (output of approved risk decision) ───────────────────────

export interface ValidatedOrder {
  instrument: string;
  direction: 'BUY' | 'SELL';
  /** May be reduced from original signal to respect maxPositionSizeLot */
  lotSize: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  trailingStopPips?: string;
  idempotencyKey: string;
}

// ─── Proposed trade (input to Risk Engine) ───────────────────────────────────

/**
 * ProposedTrade — Input signal from the Strategy Orchestrator.
 * The Risk Engine validates this and returns a RiskDecision.
 */
export interface ProposedTrade {
  signalId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  requestedLotSize: string;
  entryPrice: string;
  stopLoss?: string;
  takeProfit?: string;
  trailingStopPips?: string;
  idempotencyKey: string;
  /** Volatility score 0.0–1.0 from AI Signal Engine. Higher = more volatile. */
  volatilityScore?: number;
  /** Market regime classification from AI. */
  regime?: 'TRENDING' | 'RANGING' | 'LOW_LIQUIDITY' | 'HIGH_VOLATILITY';
}

// ─── Rejection codes ──────────────────────────────────────────────────────────

export enum RiskRejectionCode {
  // Session/connection preconditions
  KILL_SWITCH_ACTIVE = 'KILL_SWITCH_ACTIVE',
  SESSION_NOT_ACTIVE = 'SESSION_NOT_ACTIVE',
  BROKER_DISCONNECTED = 'BROKER_DISCONNECTED',

  // Sprint 50 — emergency control plane + authorization state machine
  EXECUTION_CONTROL_ACTIVE = 'EXECUTION_CONTROL_ACTIVE',
  LIVE_AUTHORIZATION_REQUIRED = 'LIVE_AUTHORIZATION_REQUIRED',

  // Account-level limits
  DAILY_LOSS_LIMIT_REACHED = 'DAILY_LOSS_LIMIT_REACHED',
  MAX_DRAWDOWN_REACHED = 'MAX_DRAWDOWN_REACHED',
  INSUFFICIENT_MARGIN = 'INSUFFICIENT_MARGIN',

  // Position-level limits
  MAX_CONCURRENT_TRADES = 'MAX_CONCURRENT_TRADES',
  MAX_DAILY_TRADES = 'MAX_DAILY_TRADES',
  POSITION_SIZE_EXCEEDED = 'POSITION_SIZE_EXCEEDED',

  // Order integrity
  MISSING_STOP_LOSS = 'MISSING_STOP_LOSS',
  MISSING_TAKE_PROFIT = 'MISSING_TAKE_PROFIT',
  INVALID_SL_DISTANCE = 'INVALID_SL_DISTANCE',
  INVALID_TP_DIRECTION = 'INVALID_TP_DIRECTION',
  LEVERAGE_EXCEEDED = 'LEVERAGE_EXCEEDED',
  INSTRUMENT_NOT_ALLOWED = 'INSTRUMENT_NOT_ALLOWED',

  // Volatility / regime
  HIGH_VOLATILITY = 'HIGH_VOLATILITY',
  LOW_LIQUIDITY_REGIME = 'LOW_LIQUIDITY_REGIME',

  // Dedup
  DUPLICATE_SIGNAL = 'DUPLICATE_SIGNAL',

  /**
   * Fail-closed: any unexpected error in the Risk Engine results in this code.
   * Trade is always REJECTED on system error — never approved.
   */
  RISK_ENGINE_ERROR = 'RISK_ENGINE_ERROR',
}

// ─── Risk context snapshot ────────────────────────────────────────────────────

/** Snapshot of risk state at the time of evaluation — stored in risk_violations */
export interface RiskContextSnapshot {
  userId: string;
  signalId: string;
  killSwitchActive: boolean;
  brokerConnected: boolean;
  brokerBalance?: string;
  brokerEquity?: string;
  openTradesCount?: number;
  dailyTradesCount?: number;
  dailyRealisedPnl?: string;
  proposedLotSize: string;
  proposedInstrument: string;
  checkedAt: Date;
}
