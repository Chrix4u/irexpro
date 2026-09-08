import { api } from '@/lib/api';

/**
 * Sprint 50 PR-5 — Live Account data loaders (Directive PHASE J contracts +
 * PHASE K user dashboard).
 *
 * Every payload is fetched via the shared API client and validated with
 * hand-written runtime type guards BEFORE the page trusts it (fail-closed:
 * a contract mismatch throws and the dashboard renders its per-section error
 * state instead of unvalidated backend data).
 *
 * Security posture mirrors trader-terminal-status.ts / trader-execution.ts:
 * - the browser derives NOTHING security-relevant from these payloads;
 *   `environment`, `executable`, `inSync` and alert state are backend-computed;
 * - monetary values arrive as decimal strings and are rendered verbatim;
 * - no credential material exists in the contract, and no URL is ever
 *   constructed from response fields.
 */

export type {
  LiveAccountActivityPage,
  LiveAccountAlertView,
  LiveAccountConnectionView,
  LiveAccountEnvironment,
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LiveActivityRowView,
  LiveAutomationSummary,
  LiveConnectionHealth,
  LiveExecutionHealthSummary,
  LiveOrderRowView,
  LiveOrderStatusFilter,
  LivePositionRowView,
  LiveReconciliationSummary,
} from '@irexpro/types/live-account';

import type {
  LiveAccountActivityPage,
  LiveAccountAlertView,
  LiveAccountConnectionView,
  LiveAccountEnvironment,
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LiveActivityRowView,
  LiveAutomationSummary,
  LiveConnectionHealth,
  LiveExecutionHealthSummary,
  LiveOrderRowView,
  LiveOrderStatusFilter,
  LivePositionRowView,
  LiveReconciliationSummary,
} from '@irexpro/types/live-account';

import type {
  BrokerAuthorizationStatus,
  BrokerConnectionStatus,
  BrokerCredentialStatus,
} from '@irexpro/types';

// ── Runtime guard helpers ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function isNullableIsoDateString(value: unknown): value is string | null {
  return value === null || isIsoDateString(value);
}

// ── Enum union guards (explicit, per the shared contract) ───────────────────

function isLiveAccountEnvironment(value: unknown): value is LiveAccountEnvironment {
  return value === 'DEMO' || value === 'LIVE' || value === 'PAPER' || value === 'UNKNOWN';
}

function isLiveConnectionHealth(value: unknown): value is LiveConnectionHealth {
  return (
    value === 'HEALTHY' ||
    value === 'DEGRADED' ||
    value === 'UNHEALTHY' ||
    value === 'UNKNOWN'
  );
}

function isBrokerConnectionStatus(value: unknown): value is BrokerConnectionStatus {
  return (
    value === 'CONNECTING' ||
    value === 'CONNECTED' ||
    value === 'DISCONNECTED' ||
    value === 'ERROR' ||
    value === 'SUSPENDED'
  );
}

function isBrokerAuthorizationStatus(value: unknown): value is BrokerAuthorizationStatus {
  return (
    value === 'NOT_CONNECTED' ||
    value === 'CONNECTING' ||
    value === 'CONNECTED' ||
    value === 'VERIFYING' ||
    value === 'AUTHORIZATION_REQUIRED' ||
    value === 'AUTHORIZED' ||
    value === 'READY' ||
    value === 'ACTIVE' ||
    value === 'SUSPENDED' ||
    value === 'REVOKED' ||
    value === 'ERROR' ||
    value === 'DISCONNECTED'
  );
}

function isBrokerCredentialStatus(value: unknown): value is BrokerCredentialStatus {
  return (
    value === 'CREATED' ||
    value === 'VERIFIED' ||
    value === 'ROTATED' ||
    value === 'REVOKED' ||
    value === 'EXPIRED' ||
    value === 'INVALID'
  );
}

function isLiveReconciliationRunStatus(
  value: unknown,
): value is LiveReconciliationSummary['lastRunStatus'] {
  return (
    value === null ||
    value === 'PENDING' ||
    value === 'RUNNING' ||
    value === 'COMPLETED' ||
    value === 'COMPLETED_WITH_WARNINGS' ||
    value === 'FAILED'
  );
}

function isLiveAccountAlertKind(value: unknown): value is LiveAccountAlertView['kind'] {
  return (
    value === 'AUTHORIZATION_REQUIRED' ||
    value === 'CREDENTIALS_EXPIRED' ||
    value === 'CREDENTIALS_INVALID' ||
    value === 'CONNECTION_ERROR' ||
    value === 'KILL_SWITCH_ACTIVE' ||
    value === 'AUTOMATION_SUSPENDED' ||
    value === 'RECONCILIATION_DISCREPANCIES' ||
    value === 'ACCOUNT_SYNC_STALE'
  );
}

function isLiveAccountAlertSeverity(
  value: unknown,
): value is LiveAccountAlertView['severity'] {
  return value === 'INFO' || value === 'WARNING' || value === 'CRITICAL';
}

function isLiveAutomationStatus(value: unknown): value is LiveAutomationSummary['status'] {
  return (
    value === 'ACTIVE' ||
    value === 'PAUSED' ||
    value === 'SUSPENDED_RISK_LIMIT' ||
    value === 'SUSPENDED_BROKER' ||
    value === 'ENDED' ||
    value === 'IDLE'
  );
}

function isOrderKind(value: unknown): value is LiveOrderRowView['orderKind'] {
  return value === 'MARKET' || value === 'LIMIT' || value === 'STOP' || value === 'STOP_LIMIT';
}

function isTimeInForce(value: unknown): value is LiveOrderRowView['timeInForce'] {
  return value === 'GTC' || value === 'DAY' || value === 'IOC' || value === 'FOK';
}

function isDirection(value: unknown): value is LiveOrderRowView['direction'] {
  return value === 'BUY' || value === 'SELL';
}

function isOrderStatus(value: unknown): value is LiveOrderRowView['status'] {
  return (
    value === 'CREATED' ||
    value === 'SUBMITTED' ||
    value === 'ACKNOWLEDGED' ||
    value === 'PARTIALLY_FILLED' ||
    value === 'FILLED' ||
    value === 'REJECTED' ||
    value === 'CANCELLED' ||
    value === 'EXPIRED' ||
    value === 'RECONCILIATION_PENDING'
  );
}

function isPositionStatus(value: unknown): value is LivePositionRowView['status'] {
  return value === 'OPEN' || value === 'RECONCILIATION_PENDING';
}

function isActivitySeverity(value: unknown): value is LiveActivityRowView['severity'] {
  return value === 'INFO' || value === 'WARNING' || value === 'CRITICAL';
}

// ── View guards (every field per the contract) ──────────────────────────────

function isLiveAccountFinancialSummary(
  value: unknown,
): value is LiveAccountConnectionView['financial'] {
  if (!isRecord(value)) return false;
  return (
    isNullableString(value.currency) &&
    isString(value.balance) &&
    isString(value.equity) &&
    isString(value.margin) &&
    isString(value.freeMargin) &&
    isNullableString(value.marginLevel) &&
    isNonNegativeInteger(value.openPositionsCount) &&
    isNullableIsoDateString(value.syncedAt)
  );
}

function isLiveReconciliationSummary(value: unknown): value is LiveReconciliationSummary {
  if (!isRecord(value)) return false;
  return (
    isNullableIsoDateString(value.lastRunAt) &&
    isLiveReconciliationRunStatus(value.lastRunStatus) &&
    isNonNegativeInteger(value.openDiscrepancies) &&
    isNonNegativeInteger(value.openCritical) &&
    isNonNegativeInteger(value.openWarning) &&
    typeof value.inSync === 'boolean'
  );
}

function isLiveAccountAlertView(value: unknown): value is LiveAccountAlertView {
  if (!isRecord(value)) return false;
  return (
    isLiveAccountAlertKind(value.kind) &&
    isLiveAccountAlertSeverity(value.severity) &&
    isString(value.key) &&
    isNullableString(value.connectionId) &&
    isNullableString(value.brokerName) &&
    isString(value.message) &&
    isNullableString(value.action)
  );
}

function isLiveAccountConnectionView(value: unknown): value is LiveAccountConnectionView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.brokerName) &&
    isNullableString(value.displayName) &&
    // Phase F accountId minimization: the contract ships maskedAccountId only;
    // a full accountId is not part of the user-facing view.
    isNullableString(value.maskedAccountId) &&
    (value.accountType === 'DEMO' || value.accountType === 'LIVE') &&
    isNullableString(value.accountCurrency) &&
    isNullableNonNegativeInteger(value.accountLeverage) &&
    isBrokerConnectionStatus(value.connectionStatus) &&
    isBrokerAuthorizationStatus(value.authorizationStatus) &&
    isBrokerCredentialStatus(value.credentialStatus) &&
    typeof value.executable === 'boolean' &&
    typeof value.liveTradingEnabled === 'boolean' &&
    isLiveConnectionHealth(value.health) &&
    isNullableIsoDateString(value.lastSyncAt) &&
    isNullableIsoDateString(value.lastHealthCheckAt) &&
    isNullableString(value.lastErrorMessage) &&
    (value.financial === null || isLiveAccountFinancialSummary(value.financial)) &&
    isLiveReconciliationSummary(value.reconciliation) &&
    isIsoDateString(value.createdAt) &&
    isIsoDateString(value.updatedAt)
  );
}

function isLiveAutomationSummary(value: unknown): value is LiveAutomationSummary {
  if (!isRecord(value)) return false;
  return (
    isLiveAutomationStatus(value.status) &&
    isNullableString(value.sessionId) &&
    isNullableString(value.sessionConnectionId) &&
    typeof value.killSwitchActive === 'boolean' &&
    isNullableString(value.killSwitchReason) &&
    isNullableIsoDateString(value.startedAt) &&
    isNullableIsoDateString(value.endedAt)
  );
}

function isLiveExecutionHealthSummary(value: unknown): value is LiveExecutionHealthSummary {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.openPositions) &&
    isNonNegativeInteger(value.workingOrders) &&
    isNonNegativeInteger(value.reconciliationPending) &&
    isNonNegativeInteger(value.rejectedLast24h) &&
    isNonNegativeInteger(value.filledLast24h)
  );
}

function isLiveAccountOverviewView(value: unknown): value is LiveAccountOverviewView {
  if (!isRecord(value)) return false;
  return (
    isIsoDateString(value.generatedAt) &&
    Array.isArray(value.connections) &&
    value.connections.every(isLiveAccountConnectionView) &&
    isLiveAutomationSummary(value.automation) &&
    isLiveExecutionHealthSummary(value.executionHealth) &&
    Array.isArray(value.alerts) &&
    value.alerts.every(isLiveAccountAlertView) &&
    isLiveAccountEnvironment(value.environment) &&
    typeof value.hasConnections === 'boolean' &&
    // Phase F partial-failure tri-state: optional (absent on older payloads),
    // but must be a boolean when present.
    (value.reconciliationLoaded === undefined ||
      typeof value.reconciliationLoaded === 'boolean')
  );
}

function isLiveOrderRowView(value: unknown): value is LiveOrderRowView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.brokerConnectionId) &&
    isNullableString(value.brokerName) &&
    isString(value.clientOrderId) &&
    isNullableString(value.providerOrderId) &&
    isNullableString(value.tradeId) &&
    isOrderKind(value.orderKind) &&
    isTimeInForce(value.timeInForce) &&
    isString(value.instrument) &&
    isDirection(value.direction) &&
    isString(value.requestedQuantity) &&
    isNullableString(value.requestedPrice) &&
    isNullableString(value.stopPrice) &&
    isString(value.filledQuantity) &&
    isNullableString(value.avgFillPrice) &&
    isOrderStatus(value.status) &&
    isNullableString(value.rejectReason) &&
    isNullableIsoDateString(value.submittedAt) &&
    isNullableIsoDateString(value.finalizedAt) &&
    isIsoDateString(value.createdAt)
  );
}

function isLiveAccountOrdersPage(value: unknown): value is LiveAccountOrdersPage {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.orders) &&
    value.orders.every(isLiveOrderRowView) &&
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.limit) &&
    isNonNegativeInteger(value.offset) &&
    value.orders.length <= value.limit
  );
}

function isLivePositionRowView(value: unknown): value is LivePositionRowView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.brokerConnectionId) &&
    isNullableString(value.brokerName) &&
    isLiveAccountEnvironment(value.environment) &&
    isString(value.instrument) &&
    isDirection(value.direction) &&
    isString(value.lotSize) &&
    isString(value.requestedEntryPrice) &&
    isNullableString(value.fillPrice) &&
    isString(value.stopLoss) &&
    isString(value.takeProfit) &&
    isNullableString(value.trailingStopPips) &&
    isPositionStatus(value.status) &&
    isNullableIsoDateString(value.openedAt) &&
    isIsoDateString(value.createdAt)
  );
}

function isLiveAccountPositionsView(value: unknown): value is LiveAccountPositionsView {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.positions) &&
    value.positions.every(isLivePositionRowView) &&
    isNonNegativeInteger(value.total)
  );
}

function isLiveActivityRowView(value: unknown): value is LiveActivityRowView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.action) &&
    isNullableString(value.resourceType) &&
    isNullableString(value.resourceId) &&
    isActivitySeverity(value.severity) &&
    isIsoDateString(value.createdAt)
  );
}

function isLiveAccountActivityPage(value: unknown): value is LiveAccountActivityPage {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.activity) &&
    value.activity.every(isLiveActivityRowView) &&
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.limit) &&
    isNonNegativeInteger(value.offset) &&
    value.activity.length <= value.limit
  );
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/** Build a query string from defined entries only (never from response data). */
function buildQuery(entries: Array<[string, string | number]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    params.set(key, String(value));
  }
  return params.toString();
}

/**
 * GET /live-account/overview — the single aggregated, tenant-scoped payload
 * powering the Live Account dashboard (Directive §38).
 */
export async function loadLiveAccountOverview(): Promise<LiveAccountOverviewView> {
  const payload = await api.request<unknown>('/live-account/overview');
  if (!isLiveAccountOverviewView(payload)) {
    throw new Error('Live account overview contract mismatch');
  }
  return payload;
}

/** GET /live-account/orders?status=&limit=&offset= — paginated order rows. */
export async function loadLiveAccountOrders(
  status: LiveOrderStatusFilter = 'WORKING',
  limit = 20,
  offset = 0,
): Promise<LiveAccountOrdersPage> {
  const query = buildQuery([
    ['status', status],
    ['limit', limit],
    ['offset', offset],
  ]);
  const payload = await api.request<unknown>(`/live-account/orders?${query}`);
  if (!isLiveAccountOrdersPage(payload)) {
    throw new Error('Live account orders contract mismatch');
  }
  return payload;
}

/** GET /live-account/positions — open positions with connection context. */
export async function loadLiveAccountPositions(): Promise<LiveAccountPositionsView> {
  const payload = await api.request<unknown>('/live-account/positions');
  if (!isLiveAccountPositionsView(payload)) {
    throw new Error('Live account positions contract mismatch');
  }
  return payload;
}

/** GET /live-account/activity?limit=&offset= — audit activity timeline page. */
export async function loadLiveAccountActivity(
  limit = 20,
  offset = 0,
): Promise<LiveAccountActivityPage> {
  const query = buildQuery([
    ['limit', limit],
    ['offset', offset],
  ]);
  const payload = await api.request<unknown>(`/live-account/activity?${query}`);
  if (!isLiveAccountActivityPage(payload)) {
    throw new Error('Live account activity contract mismatch');
  }
  return payload;
}
