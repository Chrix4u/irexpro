/**
 * Shared frontend-safe types for the normalized ORDER domain
 * (Sprint 50 PR-2 — Directive PHASE C "normalized order model").
 *
 * Mirrors apps/api/src/modules/execution/orders/* enums and the Order entity.
 * NEVER include backend-only fields (idempotency keys are internal; no
 * credentials ever appear here by construction).
 */

export type OrderKind = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

export type OrderTimeInForce = 'GTC' | 'DAY' | 'IOC' | 'FOK';

export type OrderStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'RECONCILIATION_PENDING';

export type OrderDirection = 'BUY' | 'SELL';

/** Terminal order states — lifecycle is over. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
];

/**
 * OrderView — frontend projection of trading.orders.
 * Monetary values are decimal strings (never floats).
 */
export interface OrderView {
  id: string;
  userId: string;
  brokerConnectionId: string;
  /** Position (trade) produced by this order once execution lands. */
  tradeId: string | null;
  /** AI signal lineage (null for manual orders). */
  signalId: string | null;
  /** Caller-supplied stable identifier. */
  clientOrderId: string;
  /** Broker-side order identifier (null until acknowledged). */
  providerOrderId: string | null;
  orderKind: OrderKind;
  timeInForce: OrderTimeInForce;
  instrument: string;
  direction: OrderDirection;
  requestedQuantity: string;
  requestedPrice: string | null;
  stopPrice: string | null;
  filledQuantity: string;
  avgFillPrice: string | null;
  status: OrderStatus;
  rejectReason: string | null;
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
