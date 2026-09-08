import { TradeStatus } from '../entities/trade.entity';

/**
 * TradeStateMachine — explicit server-side position/trade lifecycle validator.
 *
 * PRIOR STATE (Sprint 49 and earlier): status updates on trading.trades were
 * scattered raw `repo.update()` calls with no centralized validation. This
 * machine makes every legal transition explicit and every illegal transition
 * a thrown error (Directive PHASE C "state transitions"; same pattern as
 * Sprint 50's BrokerAuthorizationStateMachine).
 *
 *   PENDING → OPEN                    (broker confirms fill)
 *   PENDING → REJECTED                (broker rejects)
 *   PENDING → CANCELLED               (cancelled before fill — manual order
 *                                       path, arrives with PR-5 user APIs)
 *   PENDING → RECONCILIATION_PENDING  (submission outcome unknown)
 *   OPEN    → CLOSED                  (position closed: SL/TP/manual/AI/kill
 *                                       switch/broker/reconciliation)
 *   OPEN    → RECONCILIATION_PENDING  (broker unresponsive)
 *   RECONCILIATION_PENDING → OPEN     (recovery: position exists at broker)
 *   RECONCILIATION_PENDING → CLOSED   (recovery: position closed at broker)
 *
 * Terminal: CLOSED, REJECTED, CANCELLED — no outgoing transitions.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TradeStatus, readonly TradeStatus[]>> = {
  [TradeStatus.PENDING]: [
    TradeStatus.OPEN,
    TradeStatus.REJECTED,
    TradeStatus.CANCELLED,
    TradeStatus.RECONCILIATION_PENDING,
  ],
  [TradeStatus.OPEN]: [TradeStatus.CLOSED, TradeStatus.RECONCILIATION_PENDING],
  [TradeStatus.RECONCILIATION_PENDING]: [TradeStatus.OPEN, TradeStatus.CLOSED],
  // Terminal states — no outgoing transitions.
  [TradeStatus.CLOSED]: [],
  [TradeStatus.REJECTED]: [],
  [TradeStatus.CANCELLED]: [],
};

/** Terminal trade states. */
const TERMINAL_STATUSES: readonly TradeStatus[] = [
  TradeStatus.CLOSED,
  TradeStatus.REJECTED,
  TradeStatus.CANCELLED,
];

export class TradeStateMachine {
  /** Returns true when the from → to transition is explicitly allowed. */
  static canTransition(from: TradeStatus | null | undefined, to: TradeStatus): boolean {
    if (!from || !Object.values(TradeStatus).includes(from)) return false;
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  /** Throws when the transition is invalid — callers map to HTTP 409/422. */
  static assertTransition(from: TradeStatus | null | undefined, to: TradeStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid trade transition: ${from ?? 'UNKNOWN'} → ${to}`);
    }
  }

  /**
   * FAIL-CLOSED terminal check. Unknown/null is never terminal.
   */
  static isTerminal(status: TradeStatus | null | undefined): boolean {
    return status != null && TERMINAL_STATUSES.includes(status);
  }

  /**
   * FAIL-CLOSED open-position gate: only OPEN counts as live market exposure.
   * PENDING is reserved, RECONCILIATION_PENDING is uncertain — neither may be
   * treated as an open position (conservative risk accounting).
   */
  static isPositionOpen(status: TradeStatus | null | undefined): boolean {
    return status === TradeStatus.OPEN;
  }
}
