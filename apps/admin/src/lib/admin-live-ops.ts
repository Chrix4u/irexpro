import type {
  BrokerAuthorizationStatus,
  BrokerConnectionStatus,
  BrokerCredentialStatus,
  BrokerRegistryEntry,
} from '@irexpro/types';
import type {
  AdminAuditPage,
  AdminAuditRowView,
  AdminAuditSeverity,
  AdminCanaryBound,
  AdminConnectionFilter,
  AdminConnectionRowView,
  AdminConnectionsPage,
  AdminDiscrepanciesPage,
  AdminDiscrepancyFilter,
  AdminDiscrepancyRowView,
  AdminDispatchOutcomes,
  AdminEmergencyFlattenStatus,
  AdminExecutionControlView,
  AdminExpiredControlsView,
  AdminKillSwitchState,
  AdminLiveOpsOverviewView,
  AdminProviderRegistryEntry,
  AdminStaleSnapshotAlert,
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
  AdminCanaryBound,
  AdminConnectionFilter,
  AdminConnectionRowView,
  AdminConnectionsPage,
  AdminDiscrepanciesPage,
  AdminDiscrepancyFilter,
  AdminDiscrepancyRowView,
  AdminDispatchOutcomes,
  AdminEmergencyFlattenStatus,
  AdminExecutionControlView,
  AdminExpiredControlsView,
  AdminKillSwitchState,
  AdminLiveOpsOverviewView,
  AdminProviderRegistryEntry,
  AdminStaleSnapshotAlert,
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

function isBrokerAvailabilityStatus(value: unknown): value is BrokerRegistryEntry['status'] {
  return (
    value === 'SUPPORTED' ||
    value === 'BETA' ||
    value === 'NOT_STARTED' ||
    value === 'PARTNER_APPROVAL_REQUIRED' ||
    value === 'UNAVAILABLE'
  );
}

/** Guard for the shared registry entries consumed by the provider matrix. */
function isBrokerRegistryEntry(value: unknown): value is BrokerRegistryEntry {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.name) &&
    isString(value.description) &&
    isBrokerAvailabilityStatus(value.status) &&
    Array.isArray(value.connectionRoutes) &&
    value.connectionRoutes.every(isString) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isString) &&
    (value.authenticationType === 'API_TOKEN' ||
      value.authenticationType === 'OAUTH' ||
      value.authenticationType === 'SESSION_AUTH') &&
    Array.isArray(value.environments) &&
    value.environments.every((env) => env === 'DEMO' || env === 'LIVE') &&
    Array.isArray(value.regions) &&
    value.regions.every(isString) &&
    typeof value.adapterAvailable === 'boolean' &&
    (value.productionLiveVerification === undefined ||
      value.productionLiveVerification === null ||
      (isRecord(value.productionLiveVerification) &&
        (value.productionLiveVerification.status === 'UNVERIFIED' ||
          value.productionLiveVerification.status === 'VERIFIED') &&
        (value.productionLiveVerification.verifiedAt === null ||
          typeof value.productionLiveVerification.verifiedAt === 'string') &&
        (value.productionLiveVerification.evidenceRef === null ||
          typeof value.productionLiveVerification.evidenceRef === 'string') &&
        // Round 7.1 (P0-3): optional provenance + run reference.
        (value.productionLiveVerification.certifiedVia === undefined ||
          value.productionLiveVerification.certifiedVia === null ||
          value.productionLiveVerification.certifiedVia === 'LEGACY_ATTESTATION' ||
          value.productionLiveVerification.certifiedVia === 'HARNESS_CERTIFIED') &&
        (value.productionLiveVerification.certificationRunRef === undefined ||
          value.productionLiveVerification.certificationRunRef === null ||
          typeof value.productionLiveVerification.certificationRunRef === 'string'))) &&
    // Round 7.1 (P0-3): optional derived certification state.
    (value.certificationState === undefined ||
      value.certificationState === null ||
      value.certificationState === 'NOT_CERTIFIED' ||
      value.certificationState === 'LEGACY_VERIFIED' ||
      value.certificationState === 'CERTIFIED')
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
    isNonNegativeInteger(value.automation.suspendedSessions) &&
    // Phase 10 canary-operations blocks (wire compat): accepted absent or
    // null (degraded panel), validated whenever a payload is present.
    (value.adapterVersions === undefined ||
      value.adapterVersions === null ||
      isAdapterVersions(value.adapterVersions)) &&
    (value.dispatchOutcomes === undefined ||
      value.dispatchOutcomes === null ||
      isDispatchOutcomes(value.dispatchOutcomes)) &&
    (value.staleSnapshotAlerts === undefined ||
      value.staleSnapshotAlerts === null ||
      (Array.isArray(value.staleSnapshotAlerts) &&
        value.staleSnapshotAlerts.every(isStaleSnapshotAlert))) &&
    (value.emergencyFlattenStatus === undefined ||
      value.emergencyFlattenStatus === null ||
      isEmergencyFlattenStatus(value.emergencyFlattenStatus)) &&
    (value.killSwitchState === undefined ||
      value.killSwitchState === null ||
      isKillSwitchState(value.killSwitchState)) &&
    (value.canaryBounds === undefined ||
      value.canaryBounds === null ||
      (Array.isArray(value.canaryBounds) && value.canaryBounds.every(isCanaryBound)))
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
    // Sprint 56 round-5 identity fields: optional on the wire (older
    // payloads), but validated whenever present.
    (value.providerBrokerIdentity === undefined ||
      value.providerBrokerIdentity === null ||
      typeof value.providerBrokerIdentity === 'string') &&
    (value.logicalAccountKey === undefined ||
      value.logicalAccountKey === null ||
      typeof value.logicalAccountKey === 'string') &&
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

// ── Phase 10 canary-operations guards (fail-closed) ─────────────────────────

/** Adapter version map: every value is a string or null (never undefined/guessed). */
function isAdapterVersions(value: unknown): value is Record<string, string | null> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isNullableString);
}

function isDispatchOutcomes(value: unknown): value is AdminDispatchOutcomes {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.unknownResultOpenCount) &&
    isNonNegativeInteger(value.rejectedLast24h) &&
    (value.dispatchBlocksLast24h === undefined ||
      value.dispatchBlocksLast24h === null ||
      isNonNegativeInteger(value.dispatchBlocksLast24h))
  );
}

function isStaleSnapshotAlert(value: unknown): value is AdminStaleSnapshotAlert {
  if (!isRecord(value)) return false;
  return (
    isString(value.connectionId) &&
    isString(value.brokerId) &&
    isAccountType(value.accountType) &&
    isNullableString(value.lastAcceptedAt) &&
    (value.ageSeconds === null || isNonNegativeInteger(value.ageSeconds))
  );
}

function isEmergencyFlattenStatus(value: unknown): value is AdminEmergencyFlattenStatus {
  if (!isRecord(value)) return false;
  return (
    isNullableString(value.lastRequestedAt) &&
    (value.lastOutcome === null ||
      value.lastOutcome === 'COMPLETE' ||
      value.lastOutcome === 'PARTIAL' ||
      value.lastOutcome === 'UNVERIFIED') &&
    isNullableString(value.description)
  );
}

function isKillSwitchState(value: unknown): value is AdminKillSwitchState {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.activeUsersCount);
}

function isCanaryBound(value: unknown): value is AdminCanaryBound {
  if (!isRecord(value)) return false;
  return (
    isString(value.brokerId) &&
    typeof value.configured === 'boolean' &&
    (value.maxCanaryExposure === null || isString(value.maxCanaryExposure))
  );
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/**
 * GET /broker/registry — server-authoritative provider catalog, used to join
 * the Live Ops provider matrix with implementation/adapter/verification
 * facts (Sprint 56 correction round 5, issues #292/#293/#298). Callers catch
 * and degrade fail-closed (labels fall back to the taxonomy's unverified /
 * Ineligible values — never toward a "Live"-sounding claim).
 */
export async function loadAdminProviderRegistry(): Promise<BrokerRegistryEntry[]> {
  const payload = await api.listBrokerRegistry();
  if (!Array.isArray(payload?.brokers) || !payload.brokers.every(isBrokerRegistryEntry)) {
    throw new Error('Provider registry contract mismatch');
  }
  return payload.brokers;
}

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
 * Format a snapshot age in seconds for display (e.g. `3m 20s`); null renders
 * as an em dash (no snapshot exists). Formatting only — the staleness
 * threshold itself is derived server-side.
 */
export function formatAdminAgeSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
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
