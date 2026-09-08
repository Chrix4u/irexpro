'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@/context/auth-context';
import { Alert, Badge, Button, Card, EmptyState } from '@/components/ui';
import {
  ADMIN_TABLE_PAGE_SIZE,
  formatAdminTimestamp,
  loadAdminAuditLogs,
  maskActorUserId,
  type AdminAuditLogFilter,
  type AdminAuditRowView,
} from '@/lib/admin-live-ops';

/**
 * Admin audit investigation view — Sprint 50 PR-6 (Directive §39).
 *
 * Cross-user audit trail with severity filtering and actor/resource scoping.
 * The contract (AdminAuditRowView) carries NO metadata blobs, IPs, or user
 * agents — this page renders exactly the contract fields and nothing more.
 * Text filters (actorUserId, resourceType) apply on submit/Enter, trimmed;
 * the inputs are maxLength-bounded to the server-side filter bounds
 * (64 actorUserId / 100 resourceType — server truncates defensively too).
 */

const AUDIT_SEVERITY_FILTERS: AdminAuditLogFilter[] = ['ALL', 'CRITICAL', 'WARNING'];

function severityBadgeVariant(severity: AdminAuditRowView['severity']) {
  if (severity === 'CRITICAL') return 'error' as const;
  if (severity === 'WARNING') return 'warning' as const;
  return 'info' as const;
}

function AuditRow({ row }: { row: AdminAuditRowView }) {
  return (
    <tr>
      <td className="admin-table__cell-mono">{row.action}</td>
      <td>
        <div>{row.actorType}</div>
        <div className="admin-table__cell-mono admin-table__cell-muted break-long">
          {maskActorUserId(row.actorUserId)}
        </div>
      </td>
      <td>
        {row.resourceType ? (
          <>
            <div>{row.resourceType}</div>
            {row.resourceId && (
              <div className="admin-table__cell-mono admin-table__cell-muted break-long">
                {row.resourceId}
              </div>
            )}
          </>
        ) : (
          <span className="admin-table__cell-muted">—</span>
        )}
      </td>
      <td className="admin-table__cell-mono admin-table__cell-muted break-long">
        {row.correlationId ?? '—'}
      </td>
      <td>
        <Badge variant={severityBadgeVariant(row.severity)}>{row.severity}</Badge>
      </td>
      <td>
        <time dateTime={row.createdAt}>{formatAdminTimestamp(row.createdAt)}</time>
      </td>
    </tr>
  );
}

export default function AdminAuditPage() {
  const { hasAdminRole } = useAuth();

  const [severityFilter, setSeverityFilter] = useState<AdminAuditLogFilter>('ALL');
  const [actorInput, setActorInput] = useState('');
  const [resourceInput, setResourceInput] = useState('');
  /** Applied (submitted) filter values — inputs only refetch on submit/Enter. */
  const [appliedActor, setAppliedActor] = useState('');
  const [appliedResource, setAppliedResource] = useState('');

  const [rows, setRows] = useState<AdminAuditRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Monotonic request id so stale pages never overwrite a newer filter page. */
  const requestSeq = useRef(0);

  const loadPage = useCallback(
    async (severity: AdminAuditLogFilter, actor: string, resource: string, nextOffset: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const page = await loadAdminAuditLogs(
          severity,
          actor,
          resource,
          ADMIN_TABLE_PAGE_SIZE,
          nextOffset,
        );
        if (seq !== requestSeq.current) return;
        setRows(page.logs);
        setTotal(page.total);
        setOffset(page.offset);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setRows([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : 'Failed to load audit logs.');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!hasAdminRole) return;
    void loadPage('ALL', '', '', 0);
  }, [hasAdminRole, loadPage]);

  const handleSeverityChange = useCallback(
    (nextSeverity: AdminAuditLogFilter) => {
      if (nextSeverity === severityFilter) return;
      setSeverityFilter(nextSeverity);
      // Severity switch always resets to the first page with the applied
      // text filters kept.
      void loadPage(nextSeverity, appliedActor, appliedResource, 0);
    },
    [severityFilter, appliedActor, appliedResource, loadPage],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // Trim before applying — empty values fall back to the unfiltered scope.
      const nextActor = actorInput.trim();
      const nextResource = resourceInput.trim();
      setAppliedActor(nextActor);
      setAppliedResource(nextResource);
      void loadPage(severityFilter, nextActor, nextResource, 0);
    },
    [actorInput, resourceInput, severityFilter, loadPage],
  );

  const handlePrev = useCallback(() => {
    const nextOffset = Math.max(0, offset - ADMIN_TABLE_PAGE_SIZE);
    if (nextOffset !== offset) {
      void loadPage(severityFilter, appliedActor, appliedResource, nextOffset);
    }
  }, [severityFilter, appliedActor, appliedResource, offset, loadPage]);

  const handleNext = useCallback(() => {
    const nextOffset = offset + ADMIN_TABLE_PAGE_SIZE;
    if (nextOffset < total) {
      void loadPage(severityFilter, appliedActor, appliedResource, nextOffset);
    }
  }, [severityFilter, appliedActor, appliedResource, offset, total, loadPage]);

  if (!hasAdminRole) {
    return (
      <>
        <h1>Access denied</h1>
        <Card title="Insufficient permissions">
          <Alert variant="error">Your account does not have admin access.</Alert>
        </Card>
      </>
    );
  }

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + rows.length, total);
  const hasPrev = offset > 0;
  const hasNext = offset + ADMIN_TABLE_PAGE_SIZE < total;

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted" style={{ marginBottom: '1.5rem' }}>
        Immutable audit records for live-account operations, execution controls, reconciliation,
        payments, and admin actions. Records carry no metadata blobs, IP addresses, or user agents.
      </p>

      <div className="filter-group" role="group" aria-label="Audit severity filter">
        {AUDIT_SEVERITY_FILTERS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="filter-group__btn"
            aria-pressed={severityFilter === candidate}
            disabled={loading}
            onClick={() => handleSeverityChange(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>

      <Card title="Audit investigation">
        <form onSubmit={handleSubmit} className="admin-audit-filter-form" aria-label="Audit text filters">
          <div className="admin-audit-filter-form__fields">
            <div className="input-group">
              <label className="input-label" htmlFor="audit-actor-user-id">
                Actor user ID
              </label>
              <input
                id="audit-actor-user-id"
                className="input"
                type="text"
                value={actorInput}
                placeholder="Exact user id"
                autoComplete="off"
                disabled={loading}
                maxLength={64}
                onChange={(event) => setActorInput(event.target.value)}
              />
            </div>
            <div className="input-group">
              <label className="input-label" htmlFor="audit-resource-type">
                Resource type
              </label>
              <input
                id="audit-resource-type"
                className="input"
                type="text"
                value={resourceInput}
                placeholder="e.g. BrokerConnection"
                autoComplete="off"
                disabled={loading}
                maxLength={100}
                onChange={(event) => setResourceInput(event.target.value)}
              />
            </div>
          </div>
          <div className="admin-audit-filter-form__actions">
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={loading}
              aria-label="Apply audit filters"
            >
              Apply filters
            </Button>
          </div>
        </form>

        {error && <Alert variant="error">{error}</Alert>}

        {loading ? (
          <p className="muted">Loading audit logs…</p>
        ) : rows.length === 0 && !error ? (
          <EmptyState
            icon="📜"
            title="No audit records"
            description="No audit records match the current filters."
          />
        ) : (
          <>
            <div className="admin-table-scroll">
              <table className="admin-table" aria-label="Audit records">
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Resource</th>
                    <th scope="col">Correlation</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <AuditRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-table-footer">
              <p className="admin-table-footer__count" aria-live="polite">
                Showing {start}–{end} of {total}
              </p>
              <div className="admin-pagination">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePrev}
                  disabled={!hasPrev || loading}
                  aria-label="Previous audit page"
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleNext}
                  disabled={!hasNext || loading}
                  aria-label="Next audit page"
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card title="Live operations">
        <p className="muted text-sm">
          Connection-state totals, active emergency execution controls, and reconciliation health
          live in the Live Ops overview.
        </p>
        <div className="admin-liveops-links mt-4">
          <Link
            href="/admin/live-ops"
            className="btn btn--secondary btn--sm"
            aria-label="Open live operations overview"
          >
            Open Live Ops overview
          </Link>
          <Link
            href="/admin/brokers"
            className="btn btn--secondary btn--sm"
            aria-label="View broker connections"
          >
            View broker connections
          </Link>
        </div>
      </Card>
    </>
  );
}
