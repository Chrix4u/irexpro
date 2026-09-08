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

/** Direction re-export so order consumers need a single import surface. */
export type OrderDirection = TradeDirection;

export const ORDER_KINDS: readonly OrderKind[] = Object.values(OrderKind);
export const ORDER_TIME_IN_FORCES: readonly OrderTimeInForce[] = Object.values(OrderTimeInForce);
