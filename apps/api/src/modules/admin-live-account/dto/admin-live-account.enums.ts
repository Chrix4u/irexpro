/**
 * Admin Live Operations view enums (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * These mirror the FROZEN shared contract at
 * packages/types/src/admin-live-account.ts. Existing API-side enums
 * (AuditSeverity, ReconciliationDiscrepancySeverity/Status, …) are reused
 * directly wherever values match — only query-filter unions that have no
 * contract enum are declared here.
 */

/** Query filter for GET /admin/live-account/connections (invalid → ALL). */
export enum AdminConnectionFilter {
  ALL = 'ALL',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
  LIVE = 'LIVE',
  DEMO = 'DEMO',
}

/**
 * Query filter for GET /admin/live-account/reconciliation/discrepancies.
 * CRITICAL / WARNING imply OPEN rows of that severity (invalid → ALL).
 */
export enum AdminDiscrepancyFilter {
  ALL = 'ALL',
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  CRITICAL = 'CRITICAL',
  WARNING = 'WARNING',
}

/**
 * Query filter for GET /admin/audit/logs.
 * NOTE: the frozen contract declares the `filter=ALL|CRITICAL|WARNING` query
 * surface in its endpoint doc but ships no named type for it (only
 * AdminAuditSeverity) — this local enum fills that gap on the API side.
 */
export enum AdminAuditLogFilter {
  ALL = 'ALL',
  CRITICAL = 'CRITICAL',
  WARNING = 'WARNING',
}
