'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/auth-context';
import { Alert, Badge, Button, Card, EmptyState } from '@/components/ui';
import { formatEnumLabel } from '@irexpro/types';
import {
  ADMIN_TABLE_PAGE_SIZE,
  formatAdminDate,
  formatAdminTimestamp,
  loadAdminConnections,
  type AdminConnectionFilter,
  type AdminConnectionRowView,
} from '@/lib/admin-live-ops';

/**
 * Admin broker connections — Sprint 50 PR-6 (Directive §39).
 *
 * Cross-user connection inventory with state badges (connection /
 * authorization / credential), the server-computed fail-closed executable
 * gate, reconciliation discrepancy counts, and sanitized last-error display.
 * Read-only by design: this PR adds NO admin connection mutations — §39
 * emergency actions already live in the execution-control APIs.
 *
 * Filters (ALL | CONNECTED | ERROR | LIVE | DEMO) refetch from offset 0.
 * Pagination follows limit 25 + prev/next with a windowed total.
 */

const CONNECTION_FILTERS: AdminConnectionFilter[] = ['ALL', 'CONNECTED', 'ERROR', 'LIVE', 'DEMO'];

function connectionStatusBadgeVariant(status: AdminConnectionRowView['connectionStatus']) {
  switch (status) {
    case 'CONNECTED':
      return 'success' as const;
    case 'ERROR':
      return 'error' as const;
    case 'CONNECTING':
    case 'SUSPENDED':
      return 'warning' as const;
    default:
      return 'info' as const;
  }
}

function authorizationStatusBadgeVariant(status: AdminConnectionRowView['authorizationStatus']) {
  switch (status) {
    case 'ACTIVE':
      return 'success' as const;
    case 'AUTHORIZATION_REQUIRED':
    case 'SUSPENDED':
      return 'warning' as const;
    case 'REVOKED':
    case 'ERROR':
      return 'error' as const;
    default:
      return 'info' as const;
  }
}

function credentialStatusBadgeVariant(status: AdminConnectionRowView['credentialStatus']) {
  switch (status) {
    case 'VERIFIED':
    case 'ROTATED':
      return 'success' as const;
    case 'EXPIRED':
    case 'INVALID':
      return 'warning' as const;
    case 'REVOKED':
      return 'error' as const;
    default:
      return 'info' as const;
  }
}

function ConnectionRow({ row }: { row: AdminConnectionRowView }) {
  return (
    <tr>
      <td>
        <div className="admin-table__cell-strong">{row.brokerName}</div>
        <div className="admin-table__cell-muted break-long">
          {row.displayName ?? formatEnumLabel(row.brokerId)}
        </div>
      </td>
      <td>
        <Badge variant={row.accountType === 'LIVE' ? 'warning' : 'info'}>{row.accountType}</Badge>
        <div className="admin-table__cell-mono admin-table__cell-muted">
          {row.maskedAccountId ?? '—'}
        </div>
      </td>
      <td>
        <span className="admin-table__badges">
          <Badge variant={connectionStatusBadgeVariant(row.connectionStatus)}>
            {formatEnumLabel(row.connectionStatus)}
          </Badge>
          <Badge variant={authorizationStatusBadgeVariant(row.authorizationStatus)}>
            {formatEnumLabel(row.authorizationStatus)}
          </Badge>
          <Badge variant={credentialStatusBadgeVariant(row.credentialStatus)}>
            {formatEnumLabel(row.credentialStatus)}
          </Badge>
        </span>
      </td>
      <td>
        {/* Fail-closed gate: the server computes `executable`; the UI only
            renders the boolean. Anything not explicitly enabled is disabled. */}
        <Badge variant={row.executable ? 'success' : 'error'}>
          {row.executable ? 'Execution enabled' : 'Execution disabled'}
        </Badge>
      </td>
      <td>
        <time dateTime={row.lastSyncAt ?? undefined}>{formatAdminTimestamp(row.lastSyncAt)}</time>
      </td>
      <td>
        {row.openDiscrepancies > 0 ? (
          <Badge variant="warning">{row.openDiscrepancies} open</Badge>
        ) : (
          <span className="admin-table__cell-muted">0</span>
        )}
      </td>
      <td>
        {row.lastErrorMessage ? (
          <span className="admin-table__error-cell truncate-long" title={row.lastErrorMessage}>
            {row.lastErrorMessage}
          </span>
        ) : (
          <span className="admin-table__cell-muted">—</span>
        )}
      </td>
      <td>
        <time dateTime={row.createdAt}>{formatAdminDate(row.createdAt)}</time>
      </td>
    </tr>
  );
}

export default function AdminBrokersPage() {
  const { hasAdminRole } = useAuth();

  const [filter, setFilter] = useState<AdminConnectionFilter>('ALL');
  const [rows, setRows] = useState<AdminConnectionRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Monotonic request id so stale pages never overwrite a newer filter page. */
  const requestSeq = useRef(0);

  const loadPage = useCallback(async (nextFilter: AdminConnectionFilter, nextOffset: number) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await loadAdminConnections(nextFilter, ADMIN_TABLE_PAGE_SIZE, nextOffset);
      if (seq !== requestSeq.current) return;
      setRows(page.connections);
      setTotal(page.total);
      setOffset(page.offset);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setRows([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : 'Failed to load broker connections.');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!hasAdminRole) return;
    void loadPage('ALL', 0);
  }, [hasAdminRole, loadPage]);

  const handleFilterChange = useCallback(
    (nextFilter: AdminConnectionFilter) => {
      if (nextFilter === filter) return;
      setFilter(nextFilter);
      // Filter switch always resets to the first page.
      void loadPage(nextFilter, 0);
    },
    [filter, loadPage],
  );

  const handlePrev = useCallback(() => {
    const nextOffset = Math.max(0, offset - ADMIN_TABLE_PAGE_SIZE);
    if (nextOffset !== offset) {
      void loadPage(filter, nextOffset);
    }
  }, [filter, offset, loadPage]);

  const handleNext = useCallback(() => {
    const nextOffset = offset + ADMIN_TABLE_PAGE_SIZE;
    if (nextOffset < total) {
      void loadPage(filter, nextOffset);
    }
  }, [filter, offset, total, loadPage]);

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
      <h1>Brokers</h1>
      <p className="muted" style={{ marginBottom: '1.5rem' }}>
        User broker connections across every state, with the fail-closed execution gate and open
        reconciliation discrepancies per connection. Read-only visibility — broker credentials are
        AES-256-GCM encrypted and never exposed in admin views, logs, or audit metadata.
      </p>

      <div className="filter-group" role="group" aria-label="Connection filter">
        {CONNECTION_FILTERS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="filter-group__btn"
            aria-pressed={filter === candidate}
            disabled={loading}
            onClick={() => handleFilterChange(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Card title="Broker connections">
        {loading ? (
          <p className="muted">Loading broker connections…</p>
        ) : rows.length === 0 && !error ? (
          <EmptyState
            icon="🔌"
            title="No broker connections"
            description={`No connections match the ${filter} filter.`}
          />
        ) : (
          <>
            <div className="admin-table-scroll">
              <table className="admin-table" aria-label="Broker connections">
                <thead>
                  <tr>
                    <th scope="col">Broker</th>
                    <th scope="col">Account</th>
                    <th scope="col">State</th>
                    <th scope="col">Execution</th>
                    <th scope="col">Last sync</th>
                    <th scope="col">Open discrepancies</th>
                    <th scope="col">Last error</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <ConnectionRow key={row.id} row={row} />
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
                  aria-label="Previous connections page"
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleNext}
                  disabled={!hasNext || loading}
                  aria-label="Next connections page"
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
          Connection-state totals, active emergency execution controls, and the provider registry
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
          <Link href="/admin/audit" className="btn btn--secondary btn--sm" aria-label="Open audit log">
            Open audit log
          </Link>
        </div>
      </Card>
    </>
  );
}
