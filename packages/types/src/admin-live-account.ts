/**
 * Shared frontend-safe types for the ADMIN LIVE OPERATIONS surface
 * (Sprint 50 PR-6 — Directive PHASE L "Admin operations" §39 + audit
 * investigation).
 *
 * Admin app only. Cross-user visibility is intentional (ADMIN/SUPER_ADMIN
 * RBAC enforced server-side), but these types still carry NO credential
 * material, NO provider secrets, and NO audit metadata blobs. Monetary and
 * numeric broker values are decimal strings.
 */

import type {
  BrokerAuthorizationStatus,
  BrokerConnectionStatus,
  BrokerCredentialStatus,
} from './index';

// ─── Operational overview (GET /admin/live-account/overview) ────────────────

export interface AdminConnectionStateCounts {
  total: number;
  /** connectionStatus buckets */
  connected: number;
  connecting: number;
  error: number;
  disconnected: number;
  /** connectionStatus = SUSPENDED bucket (distinct from the authorizationStatus `suspended` bucket). */
  suspendedConnectionStatus: number;
  /** authorizationStatus buckets */
  authorized: number;
  authorizationRequired: number;
  revoked: number;
  /** authorizationStatus = SUSPENDED bucket (distinct from `suspendedConnectionStatus`). */
  suspended: number;
  /** environment buckets */
  demo: number;
  live: number;
}

export interface AdminDiscrepancyCounts {
  open: number;
  openCritical: number;
  openWarning: number;
  openInfo: number;
  resolvedLast24h: number;
}

export interface AdminExecutionControlView {
  id: string;
  scope: 'GLOBAL' | 'PROVIDER' | 'USER' | 'BROKER_CONNECTION';
  /** Normalized display target for the scope (broker id / masked user / null). */
  scopeTarget: string | null;
  reason: string | null;
  activatedBy: string | null;
  activatedAt: string;
  expiresAt: string | null;
  /**
   * Lifecycle status: ACTIVE = currently blocking; EXPIRED = retained record
   * (never blocking; reactivation replaces it). Optional for wire
   * compatibility with payloads emitted before this field existed.
   */
  status?: 'ACTIVE' | 'EXPIRED';
}

/**
 * Retained EXPIRED execution-control records (admin inventory). Expired rows
 * never block execution; reactivation at the same scope replaces them.
 */
export interface AdminExpiredControlsView {
  /** Total retained expired records (may exceed the bounded list below). */
  count: number;
  /** Most recent expired records by activatedAt desc (bounded payload). */
  controls: AdminExecutionControlView[];
}

export interface AdminProviderRegistryEntry {
  brokerId: string;
  brokerName: string;
  capabilities: string[];
  supportsDemo: boolean;
  supportsLive: boolean;
}

export interface AdminLiveOpsOverviewView {
  generatedAt: string;
  connections: AdminConnectionStateCounts;
  discrepancies: AdminDiscrepancyCounts;
  /** Active emergency execution controls (kill-switch inventory). */
  activeControls: AdminExecutionControlView[];
  /**
   * Retained expired execution-control records (never blocking). Optional for
   * wire compatibility with payloads emitted before this field existed.
   */
  expiredControls?: AdminExpiredControlsView;
  providers: AdminProviderRegistryEntry[];
  automation: {
    activeSessions: number;
    suspendedSessions: number;
  };
}

// ─── Admin connections (GET /admin/live-account/connections) ────────────────

export type AdminConnectionFilter = 'ALL' | 'CONNECTED' | 'ERROR' | 'LIVE' | 'DEMO';

export interface AdminConnectionRowView {
  id: string;
  userId: string;
  /** Masked owner identifier (email never returned; id is enough for lookup). */
  brokerId: string;
  brokerName: string;
  displayName: string | null;
  maskedAccountId: string | null;
  accountType: 'DEMO' | 'LIVE';
  connectionStatus: BrokerConnectionStatus;
  authorizationStatus: BrokerAuthorizationStatus;
  credentialStatus: BrokerCredentialStatus;
  /** Fail-closed execution gate (server-computed). */
  executable: boolean;
  liveTradingEnabled: boolean;
  lastSyncAt: string | null;
  lastHealthCheckAt: string | null;
  /** Sanitized, truncated (never raw provider internals). */
  lastErrorMessage: string | null;
  openDiscrepancies: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminConnectionsPage {
  connections: AdminConnectionRowView[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Admin discrepancies (GET /admin/live-account/reconciliation/discrepancies) ──

export type AdminDiscrepancyFilter = 'ALL' | 'OPEN' | 'RESOLVED' | 'CRITICAL' | 'WARNING';

export interface AdminDiscrepancyRowView {
  id: string;
  userId: string;
  brokerConnectionId: string;
  brokerId: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  status: 'OPEN' | 'RESOLVED';
  internalRefId: string | null;
  providerRef: string | null;
  description: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface AdminDiscrepanciesPage {
  discrepancies: AdminDiscrepancyRowView[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Admin audit investigation (GET /admin/audit/logs) ──────────────────────

export type AdminAuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AdminAuditRowView {
  id: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  correlationId: string | null;
  severity: AdminAuditSeverity;
  createdAt: string;
}

export interface AdminAuditPage {
  logs: AdminAuditRowView[];
  total: number;
  limit: number;
  offset: number;
}
