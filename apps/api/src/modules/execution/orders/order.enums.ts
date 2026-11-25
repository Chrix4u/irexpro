import { TradeDirection } from '../entities/trade.entity';

/**
 * OrderKind — normalized order classification (Directive PHASE C:
 * "normalized order model").
 *
 * The legacy `trading.trades` row conflates the ORDER (routing/submission
 * lifecycle) with the POSITION (market-exposure lifecycle). The order domain
 * separates them: `trading.orders` tracks intent → routing → fills, while
 * `trading.trades` remains the position aggregate.
 *
 * Price-argument rules (enforced fail-closed in OrderService AND as DB CHECK
 * constraints in migration 1753600000000):
 *
 *   MARKET      — no price arguments (fill at market)
 *   LIMIT       — requested_price required, stop_price NULL
 *   STOP        — stop_price required, requested_price NULL
 *   STOP_LIMIT  — both requested_price and stop_price required
 */
export enum OrderKind {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOP = 'STOP',
  STOP_LIMIT = 'STOP_LIMIT',
}

/**
 * OrderTimeInForce — how long the order remains working if not filled.
 *
 *   GTC — good-till-cancelled (explicit cancel required)
 *   DAY — expires at end of trading day (EXPIRED terminal state)
 *   IOC — immediate-or-cancel (unfilled remainder cancelled)
 *   FOK — fill-or-kill (full fill or cancel)
 */
export enum OrderTimeInForce {
  GTC = 'GTC',
  DAY = 'DAY',
  IOC = 'IOC',
  FOK = 'FOK',
}

/**
 * OrderStatus — explicit server-side order state machine (Directive PHASE C:
 * "state transitions").
 *
 * STATE SEMANTICS
 *
 *   CREATED               Order persisted (idempotency key reserved); not yet
 *                         sent to the provider.
 *   SUBMITTED             Sent to the provider; acknowledgement pending.
 *   DISPATCH_COMMITTED    Round 6 (issue #365): the provider-dispatch
 *                         COMMITMENT has been atomically recorded — the grant
 *                         (+ SEMI_AUTO confirmation) is consumed and the
 *                         order/dispatch intent is durably bound to the
 *                         state-changing provider call that follows
 *                         IMMEDIATELY (no awaited audit/event/DB work between
 *                         commitment and the adapter send). After this point
 *                         the request is considered IN-FLIGHT: authority
 *                         changes no longer yield zero provider calls but are
 *                         resolved through dispatch certainty and
 *                         reconciliation.
 *   ACKNOWLEDGED          Provider accepted the order; awaiting/partial fill.
 *   PARTIALLY_FILLED      Some (not all) of the requested quantity filled.
 *   FILLED                Terminal — requested quantity fully filled.
 *   REJECTED              Terminal — rejected (risk engine or provider).
 *   CANCELLED             Terminal — cancelled before full fill.
 *   EXPIRED               Terminal — working time elapsed (e.g. DAY TIF)
 *                         without full fill.
 *   RECONCILIATION_PENDING Provider state unknown (timeout/network partition);
 *                         synchronization in progress.
 *
 * SECURITY INVARIANTS
 * - Transitions are validated by OrderStateMachine — no arbitrary mutation is
 *   possible (mirrors Sprint 50's BrokerAuthorizationStateMachine pattern).
 * - `isTerminal()` is fail-closed: unknown/null state is never terminal and
 *   never working.
 * - Fill accounting invariants (filled_quantity ≤ requested_quantity,
 *   avg_fill_price present iff filled_quantity > 0) are enforced at DB level.
 */
export enum OrderStatus {
  CREATED = 'CREATED',
  SUBMITTED = 'SUBMITTED',
  DISPATCH_COMMITTED = 'DISPATCH_COMMITTED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  RECONCILIATION_PENDING = 'RECONCILIATION_PENDING',
}

/** All order statuses, in lifecycle (non-authoritative) order. */
export const ORDER_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus);

/**
 * OrderFillEvidenceClass — what kind of provider evidence authorized a
 * booked fill (accounting-integrity correction 2026-11-25).
 *
 * Classifies the EVIDENCE GRADE of each per-fill ledger row in
 * trading.order_fill_evidence. The class is derived strictly from the
 * identifiers the provider evidence actually carried at fill time — it is
 * a classification of supplied facts, never a fabricated identifier:
 *
 *   PROVIDER_DEAL      — the broker's native DEAL id proved the fill
 *                        (deal-grade evidence; replay-detectable).
 *   POSITION_FACTS     — position-level facts (e.g. a MARKET fill's
 *                        positionId / trade-position volume and price)
 *                        without a native deal id.
 *   PROVIDER_RESPONSE  — fill quantity/price taken directly from the
 *                        provider's order-response mapping (live dispatch
 *                        acknowledgement), no deal/position identifier.
 *   PROVIDER_ORDER_STATE — delta converged from provider-observed ORDER
 *                        state (reconciliation), no identifiers at all.
 *   LEGACY_BASELINE    — pre-ledger cumulative accounting state transcribed
 *                        from the order row at the FIRST ledger-era fill of
 *                        a mixed-era order (independent-review finding 1).
 *                        A BASELINE SUMMARY — the retained legacy
 *                        latest-deal pointer (when the legacy row carried
 *                        one), the cumulative pre-ledger quantity and the
 *                        cumulative average price — NOT a reconstructed
 *                        per-fill deal. Historical per-fill identifiers
 *                        destroyed by the old pointer overwrite are NOT
 *                        recoverable and are NOT invented here; only the
 *                        one identifier the order row still retained is
 *                        preserved (as what it is: the retained pointer).
 *
 * Rows with anything weaker than PROVIDER_DEAL carry a NULL provider_deal_id
 * — except LEGACY_BASELINE, which MAY carry the retained legacy pointer:
 * incomplete evidence is recorded honestly, never completed by inference.
 */
export enum OrderFillEvidenceClass {
  PROVIDER_DEAL = 'PROVIDER_DEAL',
  POSITION_FACTS = 'POSITION_FACTS',
  PROVIDER_RESPONSE = 'PROVIDER_RESPONSE',
  PROVIDER_ORDER_STATE = 'PROVIDER_ORDER_STATE',
  LEGACY_BASELINE = 'LEGACY_BASELINE',
}

/** All fill-evidence classes (DB CHECK parity — see migration 1795564800000). */
export const ORDER_FILL_EVIDENCE_CLASSES: readonly OrderFillEvidenceClass[] =
  Object.values(OrderFillEvidenceClass);

/** Direction re-export so order consumers need a single import surface. */
export type OrderDirection = TradeDirection;

export const ORDER_KINDS: readonly OrderKind[] = Object.values(OrderKind);
export const ORDER_TIME_IN_FORCES: readonly OrderTimeInForce[] = Object.values(OrderTimeInForce);
