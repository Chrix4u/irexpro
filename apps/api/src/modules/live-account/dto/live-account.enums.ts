/**
 * Live Account view enums (Sprint 50 PR-5 — Directive PHASE J).
 *
 * These mirror the FROZEN shared contract at
 * packages/types/src/live-account.ts. Existing API-side enums
 * (BrokerAuthorizationStatus, BrokerConnectionStatus, OrderStatus, …) are
 * reused directly wherever values match — only genuinely new view states are
 * declared here.
 */

/**
 * Directive §36 — DEMO / PAPER / LIVE must be visually unmistakable.
 *
 * UNKNOWN is the fail-closed truth value: an environment whose provenance
 * cannot be proven (no connections, or a connection with no explicit mode)
 * is reported as UNKNOWN — it is NEVER presented as the safe PAPER mode.
 */
export enum LiveAccountEnvironment {
  DEMO = 'DEMO',
  LIVE = 'LIVE',
  PAPER = 'PAPER',
  UNKNOWN = 'UNKNOWN',
}

/** Derived connection health roll-up (server-computed, fail-closed). */
export enum LiveConnectionHealth {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  UNHEALTHY = 'UNHEALTHY',
  UNKNOWN = 'UNKNOWN',
}

/** Trading-session-derived automation status for the Live Account dashboard. */
export enum LiveAutomationStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  SUSPENDED_RISK_LIMIT = 'SUSPENDED_RISK_LIMIT',
  SUSPENDED_BROKER = 'SUSPENDED_BROKER',
  ENDED = 'ENDED',
  IDLE = 'IDLE',
}

/**
 * Alert kinds are DERIVED server-side from authoritative state (Directive §38)
 * — there is no separate user alert store that could drift out of sync.
 */
export enum LiveAccountAlertKind {
  AUTHORIZATION_REQUIRED = 'AUTHORIZATION_REQUIRED',
  CREDENTIALS_EXPIRED = 'CREDENTIALS_EXPIRED',
  CREDENTIALS_INVALID = 'CREDENTIALS_INVALID',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  KILL_SWITCH_ACTIVE = 'KILL_SWITCH_ACTIVE',
  AUTOMATION_SUSPENDED = 'AUTOMATION_SUSPENDED',
  RECONCILIATION_DISCREPANCIES = 'RECONCILIATION_DISCREPANCIES',
  ACCOUNT_SYNC_STALE = 'ACCOUNT_SYNC_STALE',
}

export enum LiveAccountAlertSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

/** Query filter for GET /live-account/orders (invalid input falls back to ALL). */
export enum LiveOrderStatusFilter {
  WORKING = 'WORKING',
  HISTORY = 'HISTORY',
  ALL = 'ALL',
}

/** Position rows expose only market-exposure or reconciliation-held trades. */
export enum LivePositionStatus {
  OPEN = 'OPEN',
  RECONCILIATION_PENDING = 'RECONCILIATION_PENDING',
}

/** Activity timeline severity — same values as the audit-log severity column. */
export enum LiveActivitySeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}
