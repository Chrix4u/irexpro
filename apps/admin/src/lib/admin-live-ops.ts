import type {
  BrokerAuthorizationStatus,
  BrokerConnectionStatus,
  BrokerCredentialStatus,
} from '@irexpro/types';
import type {
  AdminAuditPage,
  AdminAuditRowView,
  AdminAuditSeverity,
  AdminConnectionFilter,
  AdminConnectionRowView,
  AdminConnectionsPage,
  AdminDiscrepanciesPage,
  AdminDiscrepancyFilter,
  AdminDiscrepancyRowView,
  AdminExecutionControlView,
  AdminExpiredControlsView,
  AdminLiveOpsOverviewView,
  AdminProviderRegistryEntry,
} from '@irexpro/types/admin-live-account';
import { api } from '@/lib/api';

/**
 * Admin Live Operations loaders — Sprint 50 PR-6 (Directive §39).
 *
 * Mirrors apps/web/src/lib/trader-terminal-status.ts: every API response is
 * validated field-by-field against the frozen contract
 * (packages/types/src/admin-live-account.ts) BEFORE the page trusts it.
 * Any mismatch fails CLOSED by throwing — the pages render an error state
 * instead of partial/guessed data. Derivation stays server-side; these
 * loaders only transport contract-shaped payloads.
 */

// ── Re-exports (pages import views from here) ───────────────────────────────

export type {
  AdminAuditPage,
  AdminAuditRowView,
  AdminAuditSeverity,
  AdminConnectionFilter,
  AdminConnectionRowView,
  AdminConnectionsPage,
  AdminDiscrepanciesPage,
  AdminDiscrepancyFilter,
  AdminDiscrepancyRowView,
  AdminExecutionControlView,
  AdminExpiredControlsView,
  AdminLiveOpsOverviewView,
  AdminProviderRegistryEntry,
} from '@irexpro/types/admin-live-account';

/** GET /admin/audit/logs severity filter (ALL + the two elevated severities). */
export type AdminAuditLogFilter = 'ALL' | 'CRITICAL' | 'WARNING';

// ── Shared pagination defaults ──────────────────────────────────────────────

/** Page size used by the admin connections + audit tables. */
export const ADMIN_TABLE_PAGE_SIZE = 25;

/** Page size used by the live-ops discrepancy section. */
export const ADMIN_DISCREPANCY_PAGE_SIZE = 10;

const MAX_LIMIT = 100;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return ADMIN_TABLE_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

// ── Runtime guards (fail-closed) ────────────────────────────────────────────

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

function isAdminConnectionFilter(value: unknown): value is AdminConnectionFilter {
  return (
    value === 'ALL' ||
    value === 'CONNECTED' ||
    value === 'ERROR' ||
    value === 'LIVE' ||
    value === 'DEMO'
  );
}

function isAdminDiscrepancyFilter(value: unknown): value is AdminDiscrepancyFilter {
  return (
    value === 'ALL' ||
    value === 'OPEN' ||
    value === 'RESOLVED' ||
    value === 'CRITICAL' ||
    value === 'WARNING'
  );
}

function isAdminAuditLogFilter(value: unknown): value is AdminAuditLogFilter {
  return value === 'ALL' || value === 'CRITICAL' || value === 'WARNING';
}

function isAdminAuditSeverity(value: unknown): value is AdminAuditSeverity {
  return value === 'INFO' || value === 'WARNING' || value === 'CRITICAL';
}

function isAccountType(value: unknown): value is 'DEMO' | 'LIVE' {
  return value === 'DEMO' || value === 'LIVE';
}

function isControlScope(value: unknown): value is AdminExecutionControlView['scope'] {
  return (
    value === 'GLOBAL' ||
    value === 'PROVIDER' ||
    value === 'USER' ||
    value === 'BROKER_CONNECTION'
  );
}

function isControlStatus(value: unknown): value is AdminExecutionControlView['status'] {
  // Optional on the wire (older payloads) — but when present it must be a
  // known lifecycle value; anything else fails closed.
  return value === 'ACTIVE' || value === 'EXPIRED';
}

function isExecutionControlView(value: unknown): value is AdminExecutionControlView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isControlScope(value.scope) &&
    isNullableString(value.scopeTarget) &&
    isNullableString(value.reason) &&
    isNullableString(value.activatedBy) &&
    isString(value.activatedAt) &&
    isNullableString(value.expiresAt) &&
    (value.status === undefined || isControlStatus(value.status))
  );
}

function isExpiredControlsView(value: unknown): value is AdminExpiredControlsView {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.count) &&
    Array.isArray(value.controls) &&
    value.controls.every(isExecutionControlView)
  );
}

function isProviderRegistryEntry(value: unknown): value is AdminProviderRegistryEntry {
  if (!isRecord(value)) return false;
  return (
    isString(value.brokerId) &&
    isString(value.brokerName) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isString) &&
    typeof value.supportsDemo === 'boolean' &&
    typeof value.supportsLive === 'boolean'
  );
}

function isConnectionStateCounts(
  value: unknown,
): value is AdminLiveOpsOverviewView['connections'] {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.connected) &&
    isNonNegativeInteger(value.connecting) &&
    isNonNegativeInteger(value.error) &&
    isNonNegativeInteger(value.disconnected) &&
    isNonNegativeInteger(value.suspendedConnectionStatus) &&
    isNonNegativeInteger(value.authorized) &&
    isNonNegativeInteger(value.authorizationRequired) &&
    isNonNegativeInteger(value.revoked) &&
    isNonNegativeInteger(value.suspended) &&
    isNonNegativeInteger(value.demo) &&
    isNonNegativeInteger(value.live)
  );
}

function isDiscrepancyCounts(
  value: unknown,
): value is AdminLiveOpsOverviewView['discrepancies'] {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.open) &&
    isNonNegativeInteger(value.openCritical) &&
    isNonNegativeInteger(value.openWarning) &&
    isNonNegativeInteger(value.openInfo) &&
    isNonNegativeInteger(value.resolvedLast24h)
  );
}

function isLiveOpsOverviewView(value: unknown): value is AdminLiveOpsOverviewView {
  if (!isRecord(value)) return false;
  return (
    isString(value.generatedAt) &&
    isConnectionStateCounts(value.connections) &&
    isDiscrepancyCounts(value.discrepancies) &&
    Array.isArray(value.activeControls) &&
    value.activeControls.every(isExecutionControlView) &&
    // Optional field (wire compat): accepted absent, validated when present.
    (value.expiredControls === undefined || isExpiredControlsView(value.expiredControls)) &&
    Array.isArray(value.providers) &&
    value.providers.every(isProviderRegistryEntry) &&
    isRecord(value.automation) &&
    isNonNegativeInteger(value.automation.activeSessions) &&
    isNonNegativeInteger(value.automation.suspendedSessions)
  );
}

function isConnectionRowView(value: unknown): value is AdminConnectionRowView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.userId) &&
    isString(value.brokerId) &&
    isString(value.brokerName) &&
    isNullableString(value.displayName) &&
    isNullableString(value.maskedAccountId) &&
    isAccountType(value.accountType) &&
    isBrokerConnectionStatus(value.connectionStatus) &&
    isBrokerAuthorizationStatus(value.authorizationStatus) &&
    isBrokerCredentialStatus(value.credentialStatus) &&
    typeof value.executable === 'boolean' &&
    typeof value.liveTradingEnabled === 'boolean' &&
    isNullableString(value.lastSyncAt) &&
    isNullableString(value.lastHealthCheckAt) &&
    isNullableString(value.lastErrorMessage) &&
    isNonNegativeInteger(value.openDiscrepancies) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

function isDiscrepancyRowView(value: unknown): value is AdminDiscrepancyRowView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.userId) &&
    isString(value.brokerConnectionId) &&
    isString(value.brokerId) &&
    isString(value.type) &&
    (value.severity === 'INFO' || value.severity === 'WARNING' || value.severity === 'CRITICAL') &&
    (value.status === 'OPEN' || value.status === 'RESOLVED') &&
    isNullableString(value.internalRefId) &&
    isNullableString(value.providerRef) &&
    isString(value.description) &&
    isString(value.detectedAt) &&
    isNullableString(value.resolvedAt) &&
    isNullableString(value.resolutionNote)
  );
}

function isAuditRowView(value: unknown): value is AdminAuditRowView {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.action) &&
    isString(value.actorType) &&
    isNullableString(value.actorUserId) &&
    isNullableString(value.resourceType) &&
    isNullableString(value.resourceId) &&
    isNullableString(value.correlationId) &&
    isAdminAuditSeverity(value.severity) &&
    isString(value.createdAt)
  );
}

function isConnectionsPage(value: unknown): value is AdminConnectionsPage {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.connections) &&
    value.connections.every(isConnectionRowView) &&
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.limit) &&
    isNonNegativeInteger(value.offset)
  );
}

function isDiscrepanciesPage(value: unknown): value is AdminDiscrepanciesPage {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.discrepancies) &&
    value.discrepancies.every(isDiscrepancyRowView) &&
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.limit) &&
    isNonNegativeInteger(value.offset)
  );
}

function isAuditPage(value: unknown): value is AdminAuditPage {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.logs) &&
    value.logs.every(isAuditRowView) &&
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.limit) &&
    isNonNegativeInteger(value.offset)
  );
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/**
 * GET /admin/live-account/overview — §39 operational overview
 * (connection state, discrepancies, active emergency controls, retained
 * expired controls, provider registry, automation session counts).
 */
export async function loadAdminLiveOpsOverview(): Promise<AdminLiveOpsOverviewView> {
  const payload = await api.request<unknown>('/admin/live-account/overview');
  if (!isLiveOpsOverviewView(payload)) {
    throw new Error('Admin live ops overview contract mismatch');
  }
  return payload;
}

/**
 * GET /admin/live-account/connections — cross-user connection inventory with
 * state badges and the server-computed fail-closed executable gate.
 */
export async function loadAdminConnections(
  filter: AdminConnectionFilter = 'ALL',
  limit: number = ADMIN_TABLE_PAGE_SIZE,
  offset: number = 0,
): Promise<AdminConnectionsPage> {
  if (!isAdminConnectionFilter(filter)) {
    throw new Error('Admin connections filter is invalid');
  }
  const params = new URLSearchParams({
    filter,
    limit: String(clampLimit(limit)),
    offset: String(clampOffset(offset)),
  });
  const payload = await api.request<unknown>(
    `/admin/live-account/connections?${params.toString()}`,
  );
  if (!isConnectionsPage(payload)) {
    throw new Error('Admin connections contract mismatch');
  }
  return payload;
}

/**
 * GET /admin/live-account/reconciliation/discrepancies — persisted
 * reconciliation discrepancies (all 9 §25 categories) with severity/status
 * filters.
 */
export async function loadAdminDiscrepancies(
  filter: AdminDiscrepancyFilter = 'ALL',
  limit: number = ADMIN_DISCREPANCY_PAGE_SIZE,
  offset: number = 0,
): Promise<AdminDiscrepanciesPage> {
  if (!isAdminDiscrepancyFilter(filter)) {
    throw new Error('Admin discrepancies filter is invalid');
  }
  const params = new URLSearchParams({
    filter,
    limit: String(clampLimit(limit)),
    offset: String(clampOffset(offset)),
  });
  const payload = await api.request<unknown>(
    `/admin/live-account/reconciliation/discrepancies?${params.toString()}`,
  );
  if (!isDiscrepanciesPage(payload)) {
    throw new Error('Admin discrepancies contract mismatch');
  }
  return payload;
}

/**
 * GET /admin/audit/logs — audit investigation view. actorUserId and
 * resourceType are optional trimmed filters; empty values are omitted so the
 * backend applies the default (unfiltered) scope.
 */
export async function loadAdminAuditLogs(
  filter: AdminAuditLogFilter = 'ALL',
  actorUserId?: string,
  resourceType?: string,
  limit: number = ADMIN_TABLE_PAGE_SIZE,
  offset: number = 0,
): Promise<AdminAuditPage> {
  if (!isAdminAuditLogFilter(filter)) {
    throw new Error('Admin audit log filter is invalid');
  }
  const trimmedActor = actorUserId?.trim() ?? '';
  const trimmedResource = resourceType?.trim() ?? '';
  const params = new URLSearchParams({
    filter,
    limit: String(clampLimit(limit)),
    offset: String(clampOffset(offset)),
  });
  if (trimmedActor) params.set('actorUserId', trimmedActor);
  if (trimmedResource) params.set('resourceType', trimmedResource);
  const payload = await api.request<unknown>(`/admin/audit/logs?${params.toString()}`);
  if (!isAuditPage(payload)) {
    throw new Error('Admin audit logs contract mismatch');
  }
  return payload;
}

// ── Presentation helpers (formatting only — no derivation) ──────────────────

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:MM UTC` (falls back to the raw
 * string for invalid dates). Follows the users page's UTC formatting.
 */
export function formatAdminTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

/** Format an ISO timestamp as a short date (YYYY-MM-DD). */
export function formatAdminDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Mask a user id for display (e.g. `usr_0000…0002`). Admin visibility is
 * intentional, but long UUIDs are truncated to keep tables readable.
 */
export function maskActorUserId(userId: string | null): string {
  if (!userId) return '—';
  if (userId.length <= 14) return userId;
  return `${userId.slice(0, 9)}…${userId.slice(-4)}`;
}
