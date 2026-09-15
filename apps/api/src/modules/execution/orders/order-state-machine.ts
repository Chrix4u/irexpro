import { OrderStatus, ORDER_STATUSES } from './order.enums';

/**
 * Centralized, exhaustive order transition table.
 * Keys: from-state. Values: set of allowed to-states.
 * Any transition not present here is INVALID and must be rejected server-side.
 *
 * Round 6 (issue #365): DISPATCH_COMMITTED is the explicit provider-dispatch
 * commitment point. It is reachable from CREATED (the round-6 commitment
 * replaces the legacy pre-send "mark SUBMITTED" hop) AND from SUBMITTED
 * (pipelines that already marked SUBMITTED before the commitment section —
 * phased rollout / legacy sequencing). Its outgoing edges are exactly
 * SUBMITTED's: once committed the request is IN-FLIGHT and every outcome
 * (ack / partial / full fill / rejection / cancel / expiry / uncertainty)
 * is resolved through provider responses, dispatch certainty and
 * reconciliation.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.CREATED]: [
    OrderStatus.SUBMITTED,
    // Risk-engine rejection can happen after persistence but before provider
    // submission (fail-closed pipeline ordering).
    OrderStatus.REJECTED,
    // Manual cancel before submission.
    OrderStatus.CANCELLED,
    // Round 6 (#365): the provider-dispatch commitment recorded directly
    // from the reserved state — consume grant/confirmation, commit, then
    // invoke the provider IMMEDIATELY.
    OrderStatus.DISPATCH_COMMITTED,
  ],
  [OrderStatus.SUBMITTED]: [
    OrderStatus.ACKNOWLEDGED,
    // Provider may fill without a distinct ack (e.g. fast market orders).
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    // IOC/FOK orders that receive no fill expire immediately.
    OrderStatus.EXPIRED,
    // Provider timeout / network partition — outcome unknown.
    OrderStatus.RECONCILIATION_PENDING,
    // Round 6 (#365): commitment recorded after a legacy pre-send SUBMITTED
    // mark (phased rollout sequencing).
    OrderStatus.DISPATCH_COMMITTED,
  ],
  [OrderStatus.DISPATCH_COMMITTED]: [
    // In-flight post-commitment outcomes (same set as SUBMITTED):
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
    // Ambiguous outcome — resolved via dispatch certainty + reconciliation.
    OrderStatus.RECONCILIATION_PENDING,
  ],
  [OrderStatus.ACKNOWLEDGED]: [
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    // Rare post-ack provider rejection (e.g. margin re-check failure).
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
    OrderStatus.RECONCILIATION_PENDING,
  ],
  [OrderStatus.PARTIALLY_FILLED]: [
    OrderStatus.FILLED,
    // Cancel the unfilled remainder.
    OrderStatus.CANCELLED,
    OrderStatus.REJECTED,
    OrderStatus.EXPIRED,
    OrderStatus.RECONCILIATION_PENDING,
  ],
  [OrderStatus.RECONCILIATION_PENDING]: [
    // Reconciliation resolves to the provider-observed state.
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FILLED,
    OrderStatus.REJECTED,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
  ],
  // Terminal states — no outgoing transitions.
  [OrderStatus.FILLED]: [],
  [OrderStatus.REJECTED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.EXPIRED]: [],
};

/** Terminal order states: the lifecycle is over, no further mutation. */
const TERMINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.FILLED,
  OrderStatus.REJECTED,
  OrderStatus.CANCELLED,
  OrderStatus.EXPIRED,
];

/** Working states: still eligible for fills / cancels / provider actions. */
const WORKING_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CREATED,
  OrderStatus.SUBMITTED,
  // Round 6 (#365): the dispatch is committed and in flight — fills and
  // provider-side actions legitimately arrive in this state.
  OrderStatus.DISPATCH_COMMITTED,
  OrderStatus.ACKNOWLEDGED,
  OrderStatus.PARTIALLY_FILLED,
];

/**
 * OrderStateMachine — pure, dependency-free validator for order-state
 * transitions (Directive PHASE C "state transitions").
 *
 * Rules:
 * - `assertTransition` throws on any transition not explicitly allowed above.
 * - `isTerminal` is fail-closed: unknown/null states are NEVER terminal
 *   (they are treated as "still mutable but untrusted" by callers that guard
 *   on `!isTerminal`, which conservatively blocks unsafe mutations only when
 *   combined with `canTransition` checks).
 * - Terminal states have NO outgoing transitions — enforced by the table.
 */
export class OrderStateMachine {
  /** Returns true when the from → to transition is explicitly allowed. */
  static canTransition(from: OrderStatus | null | undefined, to: OrderStatus): boolean {
    if (!from || !ORDER_STATUSES.includes(from)) return false;
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  /** Throws when the transition is invalid — callers map to HTTP 409/422. */
  static assertTransition(from: OrderStatus | null | undefined, to: OrderStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid order transition: ${from ?? 'UNKNOWN'} → ${to}`);
    }
  }

  /**
   * FAIL-CLOSED terminal check.
   * Unknown/null states return false — callers must additionally validate
   * transitions (assertTransition) before mutating, so an unknown state can
   * never be silently treated as a legitimate non-terminal working state.
   */
  static isTerminal(status: OrderStatus | null | undefined): boolean {
    return status != null && TERMINAL_STATUSES.includes(status);
  }

  /** True only for the five explicitly-working states (incl. DISPATCH_COMMITTED). */
  static isWorking(status: OrderStatus | null | undefined): boolean {
    return status != null && WORKING_STATUSES.includes(status);
  }

  /**
   * States from which a fill may be applied. Fills bypass a generic
   * transition helper (they use exact-decimal atomic SQL), so the SQL WHERE
   * clause must match exactly this set. Round 6 (#365): DISPATCH_COMMITTED
   * accepts fills — a fill arriving after the commitment is the normal
   * post-commitment outcome.
   */
  static isFillable(status: OrderStatus | null | undefined): boolean {
    return (
      status === OrderStatus.SUBMITTED ||
      status === OrderStatus.DISPATCH_COMMITTED ||
      status === OrderStatus.ACKNOWLEDGED ||
      status === OrderStatus.PARTIALLY_FILLED ||
      status === OrderStatus.RECONCILIATION_PENDING
    );
  }
}
