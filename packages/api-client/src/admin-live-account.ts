import type {
  AdminAuditPage,
  AdminAuditSeverity,
  AdminConnectionFilter,
  AdminConnectionsPage,
  AdminDiscrepanciesPage,
  AdminDiscrepancyFilter,
  AdminLiveOpsOverviewView,
} from '@irexpro/types/admin-live-account';
import type { ApiClient } from './index';

/** Query filter for the admin audit feed (contract ships no named type — local union). */
export type AdminAuditLogFilter = 'ALL' | AdminAuditSeverity;

export interface AdminLiveAccountApi {
  getOverview(): Promise<AdminLiveOpsOverviewView>;
  getConnections(
    filter?: AdminConnectionFilter,
    limit?: number,
    offset?: number,
  ): Promise<AdminConnectionsPage>;
  getDiscrepancies(
    filter?: AdminDiscrepancyFilter,
    limit?: number,
    offset?: number,
  ): Promise<AdminDiscrepanciesPage>;
  getAuditLogs(
    filter?: AdminAuditLogFilter,
    actorUserId?: string,
    resourceType?: string,
    limit?: number,
    offset?: number,
  ): Promise<AdminAuditPage>;
}

const CONNECTION_FILTERS = ['CONNECTED', 'ERROR', 'LIVE', 'DEMO'] as const;
const DISCREPANCY_FILTERS = ['OPEN', 'RESOLVED', 'CRITICAL', 'WARNING'] as const;
const AUDIT_FILTERS = ['CRITICAL', 'WARNING'] as const;

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function clampOffset(offset: number): number {
  return Math.max(Math.trunc(offset), 0);
}

/**
 * Typed read-only ADMIN Live Operations client layered on the shared
 * ApiClient transport (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * Cross-user visibility is intentional and enforced server-side by
 * ADMIN/SUPER_ADMIN RBAC. This client is read-only by design: connection
 * health, executable flags, discrepancy descriptions, and audit severities
 * are all server-derived (Directive §38/§40) and never re-computed here.
 * Query pagination is clamped client-side (limit 1..100, offset ≥ 0) as
 * defense in depth — the backend re-clamps fail-closed, and invalid filter
 * values fall back to ALL.
 */
export function createAdminLiveAccountApi(
  client: Pick<ApiClient, 'request'>,
): AdminLiveAccountApi {
  return {
    getOverview: () => client.request<AdminLiveOpsOverviewView>('/admin/live-account/overview'),

    getConnections: (filter = 'ALL', limit = 50, offset = 0) => {
      const safeFilter =
        filter && (CONNECTION_FILTERS as readonly string[]).includes(filter) ? filter : 'ALL';
      const safeLimit = clampLimit(limit);
      const safeOffset = clampOffset(offset);
      return client.request<AdminConnectionsPage>(
        `/admin/live-account/connections?filter=${safeFilter}&limit=${safeLimit}&offset=${safeOffset}`,
      );
    },

    getDiscrepancies: (filter = 'ALL', limit = 50, offset = 0) => {
      const safeFilter =
        filter && (DISCREPANCY_FILTERS as readonly string[]).includes(filter) ? filter : 'ALL';
      const safeLimit = clampLimit(limit);
      const safeOffset = clampOffset(offset);
      return client.request<AdminDiscrepanciesPage>(
        `/admin/live-account/reconciliation/discrepancies?filter=${safeFilter}&limit=${safeLimit}&offset=${safeOffset}`,
      );
    },

    getAuditLogs: (filter = 'ALL', actorUserId, resourceType, limit = 50, offset = 0) => {
      const safeFilter =
        filter && (AUDIT_FILTERS as readonly string[]).includes(filter) ? filter : 'ALL';
      const safeLimit = clampLimit(limit);
      const safeOffset = clampOffset(offset);
      let path = `/admin/audit/logs?filter=${safeFilter}&limit=${safeLimit}&offset=${safeOffset}`;
      if (actorUserId && actorUserId.trim().length > 0) {
        path += `&actorUserId=${encodeURIComponent(actorUserId.trim())}`;
      }
      if (resourceType && resourceType.trim().length > 0) {
        path += `&resourceType=${encodeURIComponent(resourceType.trim())}`;
      }
      return client.request<AdminAuditPage>(path);
    },
  };
}
