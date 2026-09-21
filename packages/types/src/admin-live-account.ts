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
} from "./index";
import type {
  BrokerProductionLiveVerification,
  ProviderCertificationState,
} from "./broker-registry";

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
  scope: "GLOBAL" | "PROVIDER" | "USER" | "BROKER_CONNECTION";
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
  status?: "ACTIVE" | "EXPIRED";
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
  /**
   * Production-LIVE verification evidence (R7-audit-D #12) — the exact type
   * the broker registry response carries (BrokerProductionLiveVerification),
   * so Admin Live Ops can render verification state straight from the
   * overview without a second /broker/registry call. BETA ≠ production-LIVE:
   * absent/UNVERIFIED fails closed. Optional for wire compatibility with
   * payloads emitted before this field existed (the API always emits it).
   */
  productionLiveVerification?: BrokerProductionLiveVerification;
  /**
   * Round 7.1 (P0-3): truthful derived certification state — NOT_CERTIFIED /
   * LEGACY_VERIFIED / CERTIFIED (legacy attestation is never presented as a
   * current protocol certification). Optional for wire compatibility.
   */
  certificationState?: ProviderCertificationState;
}

// ─── Phase 10 canary-operations blocks (read-only, DB-derived) ──────────────

/**
 * Order-dispatch outcome counts (Phase 10 canary operations — admin
 * observability of the dispatch pipeline's honest failure modes).
 */
export interface AdminDispatchOutcomes {
  /** Orders currently in status RECONCILIATION_PENDING (provider outcome unknown). */
  unknownResultOpenCount: number;
  /** Orders that reached terminal REJECTED in the last 24h (risk engine or provider). */
  rejectedLast24h: number;
  /**
   * Risk-engine rejections recorded in the last 24h — every RiskViolation row
   * is a pre-dispatch block (the risk engine runs before the dispatch
   * boundary). Optional/nullable: omitted (null) when the risk-violation
   * count is not derivable at query time.
   */
  dispatchBlocksLast24h?: number | null;
}

/**
 * A CONNECTED broker connection whose last accepted account snapshot is older
 * than the admin staleness threshold (or missing entirely on a CONNECTED LIVE
 * connection).
 */
export interface AdminStaleSnapshotAlert {
  connectionId: string;
  brokerId: string;
  accountType: "DEMO" | "LIVE";
  /** Server accept time of the latest accepted snapshot (null = none accepted). */
  lastAcceptedAt: string | null;
  /**
   * Age of the observation instant (providerObservedAt ?? acceptedAt — the
   * same semantics as the pre-trade snapshot freshness gate), in seconds.
   * Null when no snapshot exists.
   */
  ageSeconds: number | null;
}

/**
 * Most recent emergency flatten (kill-switch force-close of all open
 * positions), derived from the audit log tail.
 */
export interface AdminEmergencyFlattenStatus {
  /** When the most recent flatten summary audit was written (null = never recorded). */
  lastRequestedAt: string | null;
  /**
   * Derived from the audit record's closed/target counts: COMPLETE = every
   * position closed; PARTIAL = some not closed (failed or unknown outcome —
   * the distinction is not separable in the summary audit); UNVERIFIED = the
   * audit record's metadata does not carry usable counts. Null = never recorded.
   */
  lastOutcome: "COMPLETE" | "PARTIAL" | "UNVERIFIED" | null;
  /** Honest human-readable summary (sanitized; null = never recorded). */
  description: string | null;
}

/** Per-user kill-switch adoption snapshot. */
export interface AdminKillSwitchState {
  /** Risk profiles with killSwitchActive = true (all users — admin scope). */
  activeUsersCount: number;
}

/**
 * Operator-configured certification canary exposure cap for a certifiable
 * provider (the *_LIVE_CERT_MAX_CANARY_EXPOSURE env contract consumed by the
 * operator certification CLI). Numeric exposure cap — NOT a secret.
 */
export interface AdminCanaryBound {
  brokerId: string;
  /** False when the env var is absent (the certification CLI then refuses the run). */
  configured: boolean;
  /** The configured cap as a decimal string (null when not configured). */
  maxCanaryExposure: string | null;
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
  /**
   * Phase 10 canary operations — each block below is DB-derived/read-only and
   * OPTIONAL + NULLABLE on the wire: older payloads omit them, and a query
   * failure degrades the whole block to null (never fails the overview).
   */
  /** Adapter implementation version per brokerId (null value = adapter carries no version annotation). */
  adapterVersions?: Record<string, string | null> | null;
  dispatchOutcomes?: AdminDispatchOutcomes | null;
  staleSnapshotAlerts?: AdminStaleSnapshotAlert[] | null;
  emergencyFlattenStatus?: AdminEmergencyFlattenStatus | null;
  killSwitchState?: AdminKillSwitchState | null;
  canaryBounds?: AdminCanaryBound[] | null;
}

// ─── Admin connections (GET /admin/live-account/connections) ────────────────

export type AdminConnectionFilter =
  | "ALL"
  | "CONNECTED"
  | "ERROR"
  | "LIVE"
  | "DEMO";

export interface AdminConnectionRowView {
  id: string;
  userId: string;
  /** Masked owner identifier (email never returned; id is enough for lookup). */
  brokerId: string;
  brokerName: string;
  displayName: string | null;
  maskedAccountId: string | null;
  accountType: "DEMO" | "LIVE";
  connectionStatus: BrokerConnectionStatus;
  authorizationStatus: BrokerAuthorizationStatus;
  credentialStatus: BrokerCredentialStatus;
  /** Fail-closed execution gate (server-computed). */
  executable: boolean;
  /**
   * COMPATIBILITY MIRROR ONLY (Sprint 56 correction round 5, #292/#298):
   * never rendered as the authoritative current trading state — see the
   * provider verification taxonomy (identity eligibility + executability).
   */
  liveTradingEnabled: boolean;
  /**
   * Provider-side broker identity (server-reported; null when not reported).
   * Optional for wire compatibility with older payloads.
   */
  providerBrokerIdentity?: string | null;
  /**
   * Server-derived canonical logical-account key (null until derived).
   * Optional for wire compatibility with older payloads.
   */
  logicalAccountKey?: string | null;
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

export type AdminDiscrepancyFilter =
  | "ALL"
  | "OPEN"
  | "RESOLVED"
  | "CRITICAL"
  | "WARNING";

export interface AdminDiscrepancyRowView {
  id: string;
  userId: string;
  brokerConnectionId: string;
  brokerId: string;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  status: "OPEN" | "RESOLVED";
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

export type AdminAuditSeverity = "INFO" | "WARNING" | "CRITICAL";

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
