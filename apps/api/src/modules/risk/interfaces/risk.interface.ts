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
  /** Round 5 (#301): opaque handle to the durable server-authoritative
   * RiskGrant issued with this approval. ExecutionService must verify +
   * atomically consume the grant at the final dispatch boundary — a
   * caller-constructed approval object is never sufficient. */
  grantId?: string;
  /** Round 5 (#295/#298): the exact authority the grant is bound to. */
  sessionId?: string;
  sessionGeneration?: number;
  executionMode?: string;
  brokerConnectionId?: string;
  /** Round 6 (#362): immutable per-trade provenance carried from the risk
   * decision into the durable Trade row — the daily-risk-period key inputs.
   * Absent (undefined) on paths without provable account provenance (e.g.
   * PAPER_ONLY projections without a bound snapshot) — ExecutionService
   * persists null then, and the daily-loss aggregation marks such history
   * incomplete rather than guessing. */
  logicalAccountKey?: string;
  accountCurrency?: string;
  riskPeriodId?: string;
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
  /** Round 5 authority binding (#295/#298): the EXACT execution target.
   * Supplied by the pipeline from the ACTIVE TradingSession; RiskService
   * uses session.brokerConnectionId — never findActiveConnectionForUser().
   * Missing binding for NEW exposure fails closed (typed rejection). */
  sessionId?: string;
  sessionGeneration?: number;
  executionMode?: string;
  brokerConnectionId?: string;
  /** Round 5 (#302): producer-assigned signal generation timestamp for
   * freshness + future-skew enforcement. */
  generatedAt?: Date;
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
  /** Historical compatibility only. New decisions no longer enforce a daily trade-count cap. */
  MAX_DAILY_TRADES = 'MAX_DAILY_TRADES',
  POSITION_SIZE_EXCEEDED = 'POSITION_SIZE_EXCEEDED',

  // Order integrity
  MISSING_STOP_LOSS = 'MISSING_STOP_LOSS',
  MISSING_TAKE_PROFIT = 'MISSING_TAKE_PROFIT',
  INVALID_SL_DISTANCE = 'INVALID_SL_DISTANCE',
  INVALID_TP_DIRECTION = 'INVALID_TP_DIRECTION',
  LEVERAGE_EXCEEDED = 'LEVERAGE_EXCEEDED',
  INSTRUMENT_NOT_ALLOWED = 'INSTRUMENT_NOT_ALLOWED',

  // Round 5 (#295/#298) — session authority binding
  AUTHORITY_BINDING_REQUIRED = 'AUTHORITY_BINDING_REQUIRED',
  SESSION_AUTHORITY_MISMATCH = 'SESSION_AUTHORITY_MISMATCH',

  // Round 5 (#317) — session baselines unavailable (fail-closed, never skipped)
  SESSION_BASELINE_UNAVAILABLE = 'SESSION_BASELINE_UNAVAILABLE',
  ACCOUNT_STATE_UNAVAILABLE = 'ACCOUNT_STATE_UNAVAILABLE',

  // Round 5 (#316) — enforced per-trade controls
  MAX_TRADE_RISK_EXCEEDED = 'MAX_TRADE_RISK_EXCEEDED',
  RISK_QUOTE_UNAVAILABLE = 'RISK_QUOTE_UNAVAILABLE',
  CONTRACT_SIZE_UNAVAILABLE = 'CONTRACT_SIZE_UNAVAILABLE',

  // Round 5 (#330) — regime policy
  UNKNOWN_MARKET_REGIME = 'UNKNOWN_MARKET_REGIME',

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

  /**
   * Round 5 (#296): a SAFETY-CRITICAL STATE QUERY failed (trade counts, daily
   * P&L, account state read). Sanitized — never carries the raw driver error.
   * The affected rule is REJECTED, never substituted with a default value and
   * continued toward APPROVED.
   */
  RISK_ENGINE_QUERY_FAILED = 'RISK_ENGINE_QUERY_FAILED',
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
  /** Round 5 (#295/#298/#317): the session authority this evaluation bound to. */
  sessionId?: string;
  sessionGeneration?: number;
  executionMode?: string;
  brokerConnectionId?: string;
  /** Round 5 (#317): the session-opening/day baseline used for daily-loss %. */
  sessionOpeningBalance?: string;
  /** Round 5 (#317): the monotonic peak equity used for drawdown. */
  sessionPeakEquity?: string;
}
