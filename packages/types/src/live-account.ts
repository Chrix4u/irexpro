/**
 * Shared frontend-safe types for the USER LIVE ACCOUNT surface
 * (Sprint 50 PR-5 — Directive PHASE J "User API" + PHASE K "User UI").
 *
 * These types mirror apps/api/src/modules/live-account DTOs. Read-only
 * projections by construction:
 * - no credential material (never returned from any endpoint);
 * - no provider account identifiers beyond the masked connection view;
 * - monetary values are decimal strings (never floats);
 * - backend state stays authoritative — the frontend derives nothing
 *   security-relevant from these payloads.
 */

import type {
  BrokerAuthorizationStatus,
  BrokerConnectionStatus,
  BrokerCredentialStatus,
} from './index';

// ─── Environment / mode ─────────────────────────────────────────────────────

/**
 * Directive §36 — DEMO / PAPER / LIVE must be visually unmistakable.
 *
 * UNKNOWN is the fail-closed truth value: environment provenance that cannot
 * be established (no connections, or no explicit connection mode) reports
 * UNKNOWN — it is never presented as the safe PAPER mode.
 */
export type LiveAccountEnvironment = 'DEMO' | 'LIVE' | 'PAPER' | 'UNKNOWN';

/** Derived connection health roll-up (server-computed, fail-closed). */
export type LiveConnectionHealth =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'UNHEALTHY'
  | 'UNKNOWN';

// ─── Account summary (per connection) ───────────────────────────────────────

/**
 * Broker financial snapshot for a connection. `null` when no synchronized
 * broker account exists (never fabricate balances client-side).
 */
export interface LiveAccountFinancialSummary {
  currency: string | null;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  marginLevel: string | null;
  openPositionsCount: number;
  syncedAt: string | null;
}

// ─── Reconciliation summary (per connection) ────────────────────────────────

export type LiveReconciliationRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED';

export interface LiveReconciliationSummary {
  /** null when no run has ever executed for this connection. */
  lastRunAt: string | null;
  lastRunStatus: LiveReconciliationRunStatus | null;
  /** OPEN discrepancies right now (across runs — honest history is kept). */
  openDiscrepancies: number;
  openCritical: number;
  openWarning: number;
  /** Derived: true when openCritical + openWarning === 0. */
  inSync: boolean;
}

// ─── Alerts (server-derived from authoritative state) ───────────────────────

/**
 * Alert kinds are derived server-side from real state — there is no separate
 * user alert store to drift out of sync (Directive §38: backend state
 * remains authoritative).
 */
export type LiveAccountAlertKind =
  | 'AUTHORIZATION_REQUIRED'
  | 'CREDENTIALS_EXPIRED'
  | 'CREDENTIALS_INVALID'
  | 'CONNECTION_ERROR'
  | 'KILL_SWITCH_ACTIVE'
  | 'AUTOMATION_SUSPENDED'
  | 'RECONCILIATION_DISCREPANCIES'
  | 'ACCOUNT_SYNC_STALE';

export type LiveAccountAlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface LiveAccountAlertView {
  kind: LiveAccountAlertKind;
  severity: LiveAccountAlertSeverity;
  /** Stable key for list rendering (kind + scope). */
  key: string;
  /** null when the alert is account-wide rather than connection-scoped. */
  connectionId: string | null;
  brokerName: string | null;
  message: string;
  /** Human-readable remediation hint (never a raw backend error dump). */
  action: string | null;
}

// ─── Connections card (overview) ────────────────────────────────────────────

/**
 * Per-connection view for the overview. Phase F accountId minimization:
 * NO full provider account identifier ships in this contract — only
 * `maskedAccountId` (last 4 characters). The unmasked accountId remains
 * server-side state (rotation UX reads it from /broker/connections).
 */
export interface LiveAccountConnectionView {
  id: string;
  brokerName: string;
  displayName: string | null;
  /** Masked account identifier safe for display (e.g. "•••4123"). */
  maskedAccountId: string | null;
  accountType: 'DEMO' | 'LIVE';
  accountCurrency: string | null;
  accountLeverage: number | null;
  connectionStatus: BrokerConnectionStatus;
  authorizationStatus: BrokerAuthorizationStatus;
  credentialStatus: BrokerCredentialStatus;
  /** Fail-closed execution gate (Directive §14: only true may execute). */
  executable: boolean;
  liveTradingEnabled: boolean;
  health: LiveConnectionHealth;
  lastSyncAt: string | null;
  lastHealthCheckAt: string | null;
  lastErrorMessage: string | null;
  financial: LiveAccountFinancialSummary | null;
  reconciliation: LiveReconciliationSummary;
  createdAt: string;
  updatedAt: string;
}

// ─── Automation ─────────────────────────────────────────────────────────────

export type LiveAutomationStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'SUSPENDED_RISK_LIMIT'
  | 'SUSPENDED_BROKER'
  | 'ENDED'
  | 'IDLE';

export interface LiveAutomationSummary {
  status: LiveAutomationStatus;
  /** null when no trading session exists / none active. */
  sessionId: string | null;
  sessionConnectionId: string | null;
  /** True when the account/user-level kill switch is engaged. */
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

// ─── Execution health (overview) ────────────────────────────────────────────

export interface LiveExecutionHealthSummary {
  openPositions: number;
  workingOrders: number;
  /** Orders stuck in RECONCILIATION_PENDING right now. */
  reconciliationPending: number;
  /** Terminal rejections over the last 24h. */
  rejectedLast24h: number;
  /** Terminal fills over the last 24h. */
  filledLast24h: number;
}

// ─── The overview payload ───────────────────────────────────────────────────

/**
 * GET /live-account/overview — one aggregated, tenant-scoped payload powering
 * the whole Live Account dashboard (Directive §38).
 */
export interface LiveAccountOverviewView {
  generatedAt: string;
  connections: LiveAccountConnectionView[];
  automation: LiveAutomationSummary;
  executionHealth: LiveExecutionHealthSummary;
  alerts: LiveAccountAlertView[];
  /** Overall environment for the banner (§36): worst-case across connections. */
  environment: LiveAccountEnvironment;
  /** True when at least one DEMO/LIVE connection exists. */
  hasConnections: boolean;
  /**
   * Phase F partial-failure tri-state. true (or absent, for older payloads)
   * = the reconciliation state (latest runs + open discrepancy counts) was
   * actually read from the store. false = the lookup itself failed — the
   * zero-valued counts must NEVER be rendered as "zero discrepancies".
   */
  reconciliationLoaded?: boolean;
}

// ─── Orders (GET /live-account/orders) ──────────────────────────────────────

export type LiveOrderStatusFilter = 'WORKING' | 'HISTORY' | 'ALL';

/** Frontend-safe order row (mirrors OrderView in orders.ts, trimmed). */
export interface LiveOrderRowView {
  id: string;
  brokerConnectionId: string;
  brokerName: string | null;
  clientOrderId: string;
  providerOrderId: string | null;
  tradeId: string | null;
  orderKind: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  timeInForce: 'GTC' | 'DAY' | 'IOC' | 'FOK';
  instrument: string;
  direction: 'BUY' | 'SELL';
  requestedQuantity: string;
  requestedPrice: string | null;
  stopPrice: string | null;
  filledQuantity: string;
  avgFillPrice: string | null;
  status:
    | 'CREATED'
    | 'SUBMITTED'
    | 'ACKNOWLEDGED'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'REJECTED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'RECONCILIATION_PENDING';
  rejectReason: string | null;
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
}

export interface LiveAccountOrdersPage {
  orders: LiveOrderRowView[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Positions (GET /live-account/positions) ────────────────────────────────

/** Open position row (OPEN trades only, enriched with connection context). */
export interface LivePositionRowView {
  id: string;
  brokerConnectionId: string;
  brokerName: string | null;
  environment: LiveAccountEnvironment;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
  requestedEntryPrice: string;
  fillPrice: string | null;
  stopLoss: string;
  takeProfit: string;
  trailingStopPips: string | null;
  status: 'OPEN' | 'RECONCILIATION_PENDING';
  openedAt: string | null;
  createdAt: string;
}

export interface LiveAccountPositionsView {
  positions: LivePositionRowView[];
  total: number;
}

// ─── Activity timeline (GET /live-account/activity) ─────────────────────────

export interface LiveActivityRowView {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  createdAt: string;
}

export interface LiveAccountActivityPage {
  activity: LiveActivityRowView[];
  total: number;
  limit: number;
  offset: number;
}
