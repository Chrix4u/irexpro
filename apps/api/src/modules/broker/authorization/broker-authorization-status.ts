/**
 * BrokerAuthorizationStatus — explicit server-side authorization state machine
 * for live-account automation (Directive §15: "Live account activation should
 * not be represented by one poorly controlled boolean").
 *
 * Replaces the implicit `demoValidated` / `liveTradingEnabled` boolean pair as
 * the authoritative automation gate. The legacy booleans are kept in sync
 * (dual-write) during the transition so existing consumers keep working.
 *
 * STATE SEMANTICS
 *
 *   NOT_CONNECTED        Connection record exists; credentials stored; broker
 *                        link never established (or explicitly reset).
 *   CONNECTING           A connect attempt is in flight (transient).
 *   CONNECTED            Broker link established and verified (handshake OK).
 *   VERIFYING            Connection re-verification in flight (health check).
 *   AUTHORIZATION_REQUIRED User must explicitly grant automation authorization.
 *   AUTHORIZED           User authorization granted (demo path: validated demo
 *                        connection; live path: enable-live-trading approved).
 *   READY                Authorized + healthy + environment verified.
 *   ACTIVE               Automation (AI trading) may execute against this
 *                        connection right now. The ONLY state where execution
 *                        is permitted.
 *   SUSPENDED            Server-side suspension (health failures, risk, admin).
 *   REVOKED              Authorization revoked — re-authorization required.
 *   ERROR                Last operation failed (connection/credential error).
 *   DISCONNECTED         Broker link torn down (user or system initiated).
 *
 * SECURITY INVARIANTS
 * - Transitions are validated by BrokerAuthorizationStateMachine — no arbitrary
 *   mutation is possible, and frontend state can NEVER enable execution.
 * - `isExecutable()` is fail-closed: only ACTIVE returns true.
 * - Unknown/null state is never executable (fail closed, Directive §16/§48).
 */

export enum BrokerAuthorizationStatus {
  NOT_CONNECTED = 'NOT_CONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  VERIFYING = 'VERIFYING',
  AUTHORIZATION_REQUIRED = 'AUTHORIZATION_REQUIRED',
  AUTHORIZED = 'AUTHORIZED',
  READY = 'READY',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  REVOKED = 'REVOKED',
  ERROR = 'ERROR',
  DISCONNECTED = 'DISCONNECTED',
}

/** All statuses, in presentation (non-authoritative) order. */
export const BROKER_AUTHORIZATION_STATUSES: readonly BrokerAuthorizationStatus[] =
  Object.values(BrokerAuthorizationStatus);

/**
 * Centralized, exhaustive transition table.
 * Keys: from-state. Values: set of allowed to-states.
 * Any transition not present here is INVALID and must be rejected server-side.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<BrokerAuthorizationStatus, readonly BrokerAuthorizationStatus[]>
> = {
  [BrokerAuthorizationStatus.NOT_CONNECTED]: [
    BrokerAuthorizationStatus.CONNECTING,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.ERROR,
  ],
  [BrokerAuthorizationStatus.CONNECTING]: [
    BrokerAuthorizationStatus.CONNECTED,
    // DEMO validation completes within the handshake: the adapter confirms the
    // account is a DEMO account, which is exactly the demo-validation gate.
    BrokerAuthorizationStatus.AUTHORIZED,
    BrokerAuthorizationStatus.ERROR,
    BrokerAuthorizationStatus.NOT_CONNECTED,
    BrokerAuthorizationStatus.DISCONNECTED,
  ],
  [BrokerAuthorizationStatus.CONNECTED]: [
    BrokerAuthorizationStatus.VERIFYING,
    BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED,
    BrokerAuthorizationStatus.AUTHORIZED,
    // CONNECTED → ACTIVE is granted ONLY through the explicit
    // enable-live-trading endpoint (LIVE accounts), which additionally
    // requires registry LIVE support + prior DEMO validation.
    BrokerAuthorizationStatus.ACTIVE,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.ERROR,
    BrokerAuthorizationStatus.SUSPENDED,
  ],
  [BrokerAuthorizationStatus.VERIFYING]: [
    BrokerAuthorizationStatus.CONNECTED,
    BrokerAuthorizationStatus.ERROR,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.SUSPENDED,
    BrokerAuthorizationStatus.NOT_CONNECTED,
  ],
  [BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED]: [
    BrokerAuthorizationStatus.AUTHORIZED,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.ERROR,
    BrokerAuthorizationStatus.SUSPENDED,
    BrokerAuthorizationStatus.REVOKED,
  ],
  [BrokerAuthorizationStatus.AUTHORIZED]: [
    BrokerAuthorizationStatus.READY,
    BrokerAuthorizationStatus.ACTIVE,
    BrokerAuthorizationStatus.REVOKED,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.ERROR,
    BrokerAuthorizationStatus.SUSPENDED,
  ],
  [BrokerAuthorizationStatus.READY]: [
    BrokerAuthorizationStatus.ACTIVE,
    BrokerAuthorizationStatus.AUTHORIZED,
    BrokerAuthorizationStatus.REVOKED,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.ERROR,
    BrokerAuthorizationStatus.SUSPENDED,
    BrokerAuthorizationStatus.VERIFYING,
  ],
  [BrokerAuthorizationStatus.ACTIVE]: [
    BrokerAuthorizationStatus.SUSPENDED,
    BrokerAuthorizationStatus.REVOKED,
    BrokerAuthorizationStatus.AUTHORIZED,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.ERROR,
    BrokerAuthorizationStatus.VERIFYING,
  ],
  [BrokerAuthorizationStatus.SUSPENDED]: [
    BrokerAuthorizationStatus.VERIFYING,
    BrokerAuthorizationStatus.CONNECTED,
    BrokerAuthorizationStatus.AUTHORIZED,
    BrokerAuthorizationStatus.READY,
    BrokerAuthorizationStatus.ACTIVE,
    BrokerAuthorizationStatus.REVOKED,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.ERROR,
  ],
  [BrokerAuthorizationStatus.REVOKED]: [
    BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED,
    BrokerAuthorizationStatus.NOT_CONNECTED,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.CONNECTING,
  ],
  [BrokerAuthorizationStatus.ERROR]: [
    BrokerAuthorizationStatus.CONNECTING,
    BrokerAuthorizationStatus.VERIFYING,
    BrokerAuthorizationStatus.NOT_CONNECTED,
    BrokerAuthorizationStatus.DISCONNECTED,
    BrokerAuthorizationStatus.SUSPENDED,
    BrokerAuthorizationStatus.REVOKED,
  ],
  [BrokerAuthorizationStatus.DISCONNECTED]: [
    BrokerAuthorizationStatus.CONNECTING,
    BrokerAuthorizationStatus.NOT_CONNECTED,
    BrokerAuthorizationStatus.REVOKED,
    BrokerAuthorizationStatus.ERROR,
  ],
};

/**
 * BrokerAuthorizationStateMachine — pure, dependency-free validator for
 * authorization-state transitions.
 *
 * Rules:
 * - `assertTransition` throws on any transition not explicitly allowed above.
 * - `isExecutable` is fail-closed (only ACTIVE).
 * - Unknown states are never executable and have no outgoing transitions.
 */
export class BrokerAuthorizationStateMachine {
  /** Returns true when the from → to transition is explicitly allowed. */
  static canTransition(
    from: BrokerAuthorizationStatus | null | undefined,
    to: BrokerAuthorizationStatus,
  ): boolean {
    if (!from || !BROKER_AUTHORIZATION_STATUSES.includes(from)) return false;
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  /** Throws when the transition is invalid — callers map to HTTP 409/403. */
  static assertTransition(
    from: BrokerAuthorizationStatus | null | undefined,
    to: BrokerAuthorizationStatus,
  ): void {
    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid broker authorization transition: ${from ?? 'UNKNOWN'} → ${to}`);
    }
  }

  /**
   * FAIL-CLOSED execution gate.
   * Only ACTIVE may execute automation. null/undefined/unknown never execute.
   */
  static isExecutable(status: BrokerAuthorizationStatus | null | undefined): boolean {
    return status === BrokerAuthorizationStatus.ACTIVE;
  }

  /** Human-readable state group for UI badges (never authoritative). */
  static describeGroup(status: BrokerAuthorizationStatus | null | undefined): string {
    switch (status) {
      case BrokerAuthorizationStatus.ACTIVE:
        return 'EXECUTING';
      case BrokerAuthorizationStatus.READY:
      case BrokerAuthorizationStatus.AUTHORIZED:
        return 'AUTHORIZED';
      case BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED:
      case BrokerAuthorizationStatus.REVOKED:
        return 'PENDING_AUTHORIZATION';
      case BrokerAuthorizationStatus.CONNECTED:
      case BrokerAuthorizationStatus.CONNECTING:
      case BrokerAuthorizationStatus.VERIFYING:
        return 'CONNECTED';
      case BrokerAuthorizationStatus.SUSPENDED:
      case BrokerAuthorizationStatus.ERROR:
        return 'DEGRADED';
      case BrokerAuthorizationStatus.NOT_CONNECTED:
      case BrokerAuthorizationStatus.DISCONNECTED:
      default:
        return 'NOT_CONNECTED';
    }
  }
}
