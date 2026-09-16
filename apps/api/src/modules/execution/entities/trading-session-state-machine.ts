import { TradingSessionStatus } from './trading-session.entity';

/**
 * TradingSessionStateMachine (Round 6 live-execution completion §16) — the
 * AUTONOMOUS session lifecycle transition table.
 *
 * Before Round 6 the statuses PAUSED / SUSPENDED_RISK_LIMIT /
 * SUSPENDED_BROKER existed in the enum and were DISPLAYED by read models
 * but were never SET by any production path — the session lifecycle had a
 * single live edge (ACTIVE → ENDED). This machine declares the FULL legal
 * graph and is enforced at every transition writer:
 *
 *   ACTIVE → PAUSED                   (user pause)
 *   ACTIVE → SUSPENDED_RISK_LIMIT     (daily-loss / drawdown breach — the
 *                                      risk engine autonomously degrades the
 *                                      session; grants for the session are
 *                                      invalidated, authorityGeneration
 *                                      advances so in-flight authorizations
 *                                      fail closed at the boundary)
 *   ACTIVE → SUSPENDED_BROKER         (broker health suspension / authority
 *                                      revocation)
 *   ACTIVE → ENDED                    (user stop / natural end)
 *   PAUSED → ACTIVE                   (user resume)
 *   PAUSED → ENDED
 *   SUSPENDED_RISK_LIMIT → ACTIVE     (next risk period / manual resume
 *                                      after review)
 *   SUSPENDED_RISK_LIMIT → ENDED
 *   SUSPENDED_BROKER → ACTIVE         (broker recovered + revalidated)
 *   SUSPENDED_BROKER → ENDED
 *
 * Terminal: ENDED — no outgoing transitions.
 *
 * Every transition MUST advance authorityGeneration (the write sites do the
 * guarded CAS bump) — a resumed session can never resurrect pre-suspension
 * grants or confirmations.
 */
export class SessionStateMachineError extends Error {
  constructor(from: TradingSessionStatus, to: TradingSessionStatus) {
    super(`Illegal trading-session transition ${from} → ${to} (§16 state machine)`);
    this.name = 'SessionStateMachineError';
  }
}

const ALLOWED_SESSION_TRANSITIONS: Readonly<
  Record<TradingSessionStatus, readonly TradingSessionStatus[]>
> = {
  [TradingSessionStatus.ACTIVE]: [
    TradingSessionStatus.PAUSED,
    TradingSessionStatus.SUSPENDED_RISK_LIMIT,
    TradingSessionStatus.SUSPENDED_BROKER,
    TradingSessionStatus.ENDED,
  ],
  [TradingSessionStatus.PAUSED]: [TradingSessionStatus.ACTIVE, TradingSessionStatus.ENDED],
  [TradingSessionStatus.SUSPENDED_RISK_LIMIT]: [
    TradingSessionStatus.ACTIVE,
    TradingSessionStatus.ENDED,
  ],
  [TradingSessionStatus.SUSPENDED_BROKER]: [
    TradingSessionStatus.ACTIVE,
    TradingSessionStatus.ENDED,
  ],
  [TradingSessionStatus.ENDED]: [],
};

export const TradingSessionStateMachine = {
  /** Legal-transition predicate. */
  canTransition(from: TradingSessionStatus, to: TradingSessionStatus): boolean {
    return ALLOWED_SESSION_TRANSITIONS[from]?.includes(to) ?? false;
  },

  /** Assert a transition is legal — throws SessionStateMachineError otherwise. */
  assertTransition(from: TradingSessionStatus, to: TradingSessionStatus): void {
    if (!this.canTransition(from, to)) {
      throw new SessionStateMachineError(from, to);
    }
  },

  /** The full table (read models + specs). */
  transitions(): Readonly<Record<TradingSessionStatus, readonly TradingSessionStatus[]>> {
    return ALLOWED_SESSION_TRANSITIONS;
  },
};
