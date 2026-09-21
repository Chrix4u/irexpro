/**
 * Frontend-safe execution contracts for web, admin, mobile, and desktop.
 *
 * These mirror the explicit backend execution DTOs and intentionally exclude
 * ownership, signal lineage, idempotency keys, broker identifiers, rejection
 * internals, and monetary P&L values that lack an authoritative currency.
 */
export type TradeExecutionStatus =
  | 'PENDING'
  | 'OPEN'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'RECONCILIATION_PENDING';

export type TradeExecutionDirection = 'BUY' | 'SELL';

export type TradeExecutionCloseReason =
  | 'STOP_LOSS_HIT'
  | 'TAKE_PROFIT_HIT'
  | 'MANUAL_CLOSE'
  | 'AI_CLOSE_SIGNAL'
  | 'KILL_SWITCH_FORCE_CLOSE'
  | 'BROKER_CLOSE'
  | 'RECONCILIATION';

export interface UserCapitalAllocationView {
  brokerConnectionId: string;
  logicalAccountKey: string;
  accountCurrency: string;
  brokerEquity: string;
  hasAllocation: boolean;
  allocatedCapital: string | null;
  committedCapital: string;
  availableCapital: string | null;
}

export interface SetUserCapitalAllocationRequest {
  brokerConnectionId: string;
  amount: string;
}

export interface TradeExecutionView {
  id: string;
  instrument: string;
  direction: TradeExecutionDirection;
  /** Risk-engine validated lot size as a decimal string. */
  lotSize: string;
  /** Requested entry price as a decimal string. */
  requestedEntryPrice: string;
  /** Authoritative broker fill price when available. */
  fillPrice: string | null;
  stopLoss: string;
  takeProfit: string;
  trailingStopPips: string | null;
  status: TradeExecutionStatus;
  exitPrice: string | null;
  /** Account currency for monetary execution economics, when proven. */
  accountCurrency: string | null;
  /** Server/provider-recorded realized P&L in account currency. */
  realisedPnl: string | null;
  commission: string | null;
  swap: string | null;
  closeReason: TradeExecutionCloseReason | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Execution authority: trading session (Sprint 56 correction round 5) ─────
//
// Issues #295/#298: the TradingSession is THE authoritative execution target.
// The executionMode is durable session state — it is NEVER inferred from
// connection.accountType, and `liveTradingEnabled` on a connection is only a
// compatibility mirror that must never be presented as the current trading
// state. Mode changes are audited server-side and bump `authorityGeneration`,
// invalidating outstanding RiskGrants and SEMI_AUTO confirmations.

/**
 * Durable execution modes for a trading session (issue #298).
 *
 * - PAPER_ONLY: new exposure routes exclusively to the paper/simulator path.
 * - SEMI_AUTO: every new exposure requires an explicit server-verifiable,
 *   one-time user confirmation bound to the exact order payload.
 * - FULL_AUTO: automatic new exposure permitted only while ALL current
 *   authority conditions hold at the final dispatch boundary.
 */
export type ExecutionMode = 'PAPER_ONLY' | 'SEMI_AUTO' | 'FULL_AUTO';

/** Trading session lifecycle (mirrors the backend enum). */
export type TradingSessionStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'SUSPENDED_RISK_LIMIT'
  | 'SUSPENDED_BROKER'
  | 'ENDED';

/** All execution-mode selector values, in risk-ascending order. */
export const EXECUTION_MODES: readonly ExecutionMode[] = [
  'PAPER_ONLY',
  'SEMI_AUTO',
  'FULL_AUTO',
];

/** Minimal broker identity needed to choose the requested session mode. */
export interface BrokerExecutionEnvironment {
  brokerId: string;
  accountType: 'DEMO' | 'LIVE';
}

/**
 * Choose automatic execution mode from broker identity, not DEMO/LIVE alone.
 * `paper-broker` is the internal simulator and stays PAPER_ONLY. Real-provider
 * DEMO accounts use FULL_AUTO against the provider's demo environment; LIVE
 * accounts still remain subject to every server-side production-LIVE gate.
 */
export function startExecutionModeForBroker(
  connection: BrokerExecutionEnvironment,
): ExecutionMode {
  return connection.brokerId === 'paper-broker' ? 'PAPER_ONLY' : 'FULL_AUTO';
}

/**
 * Frontend-safe view of the authoritative trading session.
 *
 * NOTE: the active-session read uses an explicit `{ session }` envelope so
 * the stopped state is always valid JSON. TradingSessionResponseDto deliberately
 * excludes internal financial session fields (openingBalance/peakEquity)
 * from browser-facing responses; those live in account/performance
 * endpoints. The frontend renders authority fields only and never derives
 * authority from monetary display values.
 */
export interface TradingSessionView {
  id: string;
  /** The exact broker connection bound at session start (issue #295). */
  brokerConnectionId: string;
  /** Durable execution mode — authoritative, never inferred (issue #298). */
  executionMode: ExecutionMode;
  /**
   * Monotonic authority generation. Advanced on every audited mode change /
   * connection switch / suspension; outstanding confirmations bind the
   * generation at issuance, so a mismatch invalidates them.
   */
  authorityGeneration: number;
  status: TradingSessionStatus;
  startedAt: string;
}

/** GET /trading/sessions/active → 200 `{ session }`; session is null when stopped. */
export interface ActiveTradingSessionResponse {
  session: TradingSessionView | null;
}

/** POST /trading/sessions/start request body. */
export interface StartTradingSessionRequest {
  /** Exact connection to bind as the execution target (server-validated). */
  brokerConnectionId: string;
  executionMode: ExecutionMode;
}

/** POST /trading/sessions/start → 201 bare session. */
export type StartTradingSessionResponse = TradingSessionView;

export type AiStopPositionCloseState = 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';

/**
 * POST /trading/sessions/:id/stop response.
 *
 * The session is stopped before risk-reducing close requests are sent. The
 * server never fabricates closure: PARTIAL means at least one AI-opened
 * position was not yet proved CLOSED; UNKNOWN means the flatten itself could
 * not be verified and the user must inspect Positions & Activity.
 */
export interface StopTradingSessionResponse {
  message: string;
  sessionId: string;
  positionCloseSummary: {
    state: AiStopPositionCloseState;
    targetCount: number | null;
    closedCount: number;
    unresolvedCount: number | null;
  };
}

/** POST /trading/sessions/:id/mode request body (audited; bumps generation). */
export interface ChangeTradingSessionModeRequest {
  executionMode: ExecutionMode;
}

/** POST /trading/sessions/:id/mode → 200 bare session. */
export type ChangeTradingSessionModeResponse = TradingSessionView;

// ─── SEMI_AUTO execution confirmations (issue #298) ─────────────────────────
//
// In SEMI_AUTO mode the SERVER queues a one-time confirmation bound to the
// exact order payload digest. The frontend may ONLY list pending
// confirmations and relay an explicit confirm — it NEVER fabricates approval
// state; only the server-consumed `CONSUMED` result (or the typed 409-style
// failure) is truth.

/**
 * A pending SEMI_AUTO confirmation. `orderPayloadDigest` is the server's
 * canonical SHA-256 digest of the exact order payload — displayed so the
 * user can see the confirmation is bound to THIS order, not a lookalike.
 */
export interface ExecutionConfirmationView {
  id: string;
  /** Originating AI signal identity (immutable server-side). */
  signalId: string;
  instrument: string;
  direction: TradeExecutionDirection;
  /** Quantity as a decimal string (never parsed to a float). */
  quantity: string;
  stopLoss: string | null;
  takeProfit: string | null;
  /** Expiry timestamp — after this the server rejects the confirmation. */
  expiresAt: string;
  /** Canonical SHA-256 digest of the exact bound order payload. */
  orderPayloadDigest: string;
}

/** GET /execution/confirmations/pending → `{ confirmations }`. */
export interface PendingExecutionConfirmationsResponse {
  confirmations: ExecutionConfirmationView[];
}

/**
 * POST /execution/confirmations/:id/confirm → 200 server-consumed authority
 * result. `CONSUMED` is the ONLY success value — the frontend never marks a
 * confirmation approved on its own.
 */
export type ExecutionConfirmationOutcome = 'CONSUMED';

/** POST /execution/confirmations/:id/confirm success body. */
export interface ConfirmExecutionConfirmationResponse {
  status: ExecutionConfirmationOutcome;
}

/**
 * Typed failure classification for a confirm attempt (server 409-style
 * responses). Kind values mirror the server-side one-time-use semantics:
 * expired, already consumed, revoked, or bound to a superseded session
 * authority generation.
 */
export type ExecutionConfirmationFailureKind =
  | 'expired'
  | 'consumed'
  | 'revoked'
  | 'mismatched-generation'
  | 'unknown';

/**
 * Structured server failure surface for a rejected confirm attempt.
 * Presentation only — it maps a sanitized server error onto the typed
 * failure kinds so the UI never shows a fabricated approval state.
 */
export interface ExecutionConfirmationFailure {
  kind: ExecutionConfirmationFailureKind;
  /** Human-readable copy derived from the SERVER message (never invented). */
  message: string;
}

/**
 * Classify a confirm failure from a sanitized server error surface.
 *
 * Accepts the shared ApiClientError shape (`statusCode`, `message`, and an
 * optional machine `code`) and maps it onto the typed failure kinds by
 * inspecting the server-provided message/code — keywords are matched
 * case-insensitively. Unknown shapes fail closed to `'unknown'` with the
 * server message (or a neutral fallback) so the failure is still shown as
 * the server's, never as a local success.
 */
export function describeExecutionConfirmationFailure(failure: {
  statusCode?: number;
  message?: string;
  code?: string;
}): ExecutionConfirmationFailure {
  const message = typeof failure.message === 'string' ? failure.message : '';
  const haystack = `${failure.code ?? ''} ${message}`.toLowerCase();
  if (
    haystack.includes('expired') ||
    failure.code === 'CONFIRMATION_EXPIRED'
  ) {
    return {
      kind: 'expired',
      message: message || 'The confirmation expired before it reached the server.',
    };
  }
  if (
    haystack.includes('consumed') ||
    haystack.includes('already used') ||
    failure.code === 'CONFIRMATION_ALREADY_CONSUMED'
  ) {
    return {
      kind: 'consumed',
      message: message || 'The confirmation was already used exactly once.',
    };
  }
  if (haystack.includes('revoked') || failure.code === 'CONFIRMATION_REVOKED') {
    return {
      kind: 'revoked',
      message: message || 'The confirmation was revoked server-side.',
    };
  }
  if (
    haystack.includes('generation') ||
    haystack.includes('mismatch') ||
    failure.code === 'AUTHORITY_GENERATION_MISMATCH'
  ) {
    return {
      kind: 'mismatched-generation',
      message:
        message ||
        'The session authority changed — this confirmation is no longer bound to the current generation.',
    };
  }
  return {
    kind: 'unknown',
    message: message || 'The server rejected this confirmation.',
  };
}
