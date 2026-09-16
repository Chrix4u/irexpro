'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/auth-context';
import { Alert, Badge, Button, Card, EmptyState } from '@/components/ui';
import { formatEnumLabel } from '@irexpro/types';
import type { BrokerRegistryEntry } from '@irexpro/types';
import { assessProviderVerification } from '@irexpro/types/provider-verification';
import type { ProviderVerificationLabel } from '@irexpro/types/provider-verification';
import {
  ADMIN_DISCREPANCY_PAGE_SIZE,
  ADMIN_TABLE_PAGE_SIZE,
  formatAdminTimestamp,
  loadAdminConnections,
  loadAdminDiscrepancies,
  loadAdminLiveOpsOverview,
  loadAdminProviderRegistry,
  type AdminConnectionRowView,
  type AdminDiscrepancyFilter,
  type AdminDiscrepancyRowView,
  type AdminExecutionControlView,
  type AdminLiveOpsOverviewView,
} from '@/lib/admin-live-ops';

/**
 * Admin Live Operations overview — Sprint 50 PR-6 (Directive §39).
 *
 * Operational visibility ONLY (read-only): connection state buckets,
 * reconciliation discrepancy counts, the active emergency execution-control
 * inventory, the provider registry, and automation session counts. All
 * derivation (executable gates, masks, counts) stays server-side — this page
 * renders contract data only. The §39 emergency actions (control activation /
 * clearing) live in the execution-control APIs used elsewhere, not here.
 *
 * Data-loading follows the users page conventions: useEffect + cancelled flag,
 * `api.request` via validated loaders (fail-closed runtime guards), plain CSS
 * classes from globals.css. The discrepancy table is a partial-failure panel —
 * an overview error does not take it down, and vice versa.
 */

/** Max capability chips rendered per provider row; the rest collapse to "+N more". */
const CAPABILITY_CHIP_CAP = 6;

const DISCREPANCY_FILTERS: AdminDiscrepancyFilter[] = [
  'ALL',
  'OPEN',
  'RESOLVED',
  'CRITICAL',
  'WARNING',
];

/**
 * Badge semantics for the fixed six-label verification taxonomy
 * (Sprint 56 correction round 5 — risk-ascending accents).
 */
function verificationBadgeVariant(label: ProviderVerificationLabel): 'success' | 'warning' | 'error' | 'info' {
  if (label === 'Production LIVE Verified') return 'success';
  if (label === 'Production LIVE Unverified' || label === 'execution disabled') return 'error';
  if (label === 'DEMO only' || label === 'Ineligible') return 'warning';
  return 'info';
}

function severityBadgeVariant(severity: 'INFO' | 'WARNING' | 'CRITICAL') {
  if (severity === 'CRITICAL') return 'error' as const;
  if (severity === 'WARNING') return 'warning' as const;
  return 'info' as const;
}

function discrepancyStatusBadgeVariant(status: 'OPEN' | 'RESOLVED') {
  return status === 'OPEN' ? ('warning' as const) : ('success' as const);
}

function controlScopeBadgeVariant(scope: AdminExecutionControlView['scope']) {
  // GLOBAL blocks every execution on the platform — error accent.
  // Scoped controls (PROVIDER / USER / BROKER_CONNECTION) — warning accent.
  return scope === 'GLOBAL' ? ('error' as const) : ('warning' as const);
}

function StatTile({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant?: 'success' | 'warning' | 'error';
}) {
  return (
    <div className={`stat-card${variant ? ` stat-card--${variant}` : ''}`}>
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
    </div>
  );
}

function ControlCard({ control }: { control: AdminExecutionControlView }) {
  const isGlobal = control.scope === 'GLOBAL';
  return (
    <div className={`admin-control-card${isGlobal ? '' : ' admin-control-card--scoped'}`}>
      <div className="admin-control-card__header">
        <Badge variant={controlScopeBadgeVariant(control.scope)}>
          {formatEnumLabel(control.scope)}
        </Badge>
        <span className="admin-control-card__target break-long">
          {control.scopeTarget ?? 'Entire platform'}
        </span>
      </div>
      {control.reason && <p className="admin-control-card__reason">{control.reason}</p>}
      <div className="admin-control-card__meta">
        <span className="admin-control-card__meta-item">
          <span className="admin-control-card__meta-label">Activated by</span>
          {control.activatedBy ?? 'system'}
        </span>
        <span className="admin-control-card__meta-item">
          <span className="admin-control-card__meta-label">Activated at</span>
          <time dateTime={control.activatedAt}>
            {formatAdminTimestamp(control.activatedAt)}
          </time>
        </span>
        <span className="admin-control-card__meta-item">
          <span className="admin-control-card__meta-label">Expires</span>
          {control.expiresAt ? (
            <time dateTime={control.expiresAt}>{formatAdminTimestamp(control.expiresAt)}</time>
          ) : (
            'Until cleared'
          )}
        </span>
      </div>
    </div>
  );
}

function ProviderCapabilities({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) {
    return <span className="admin-table__cell-muted">No capabilities</span>;
  }
  const shown = capabilities.slice(0, CAPABILITY_CHIP_CAP);
  const hidden = capabilities.length - shown.length;
  return (
    <span className="admin-chip-row">
      {shown.map((capability) => (
        <span key={capability} className="admin-chip">
          {formatEnumLabel(capability)}
        </span>
      ))}
      {hidden > 0 && <span className="admin-chip admin-chip--more">+{hidden} more</span>}
    </span>
  );
}

/**
 * Provider capability-matrix row (Sprint 56 correction round 5, issues
 * #292/#293): the six distinguished facts stay SEPARATE columns —
 * (a) protocol/environment capability, (b) implementation availability,
 * (c) adapter availability, (d) verification status — each rendered from
 * the fixed taxonomy so an UNVERIFIED BETA provider is never "Live".
 * Identity eligibility (e) and current executability (f) are per-connection
 * facts and live in the connection authority table below.
 */
function ProviderMatrixRow({
  provider,
  registryEntry,
}: {
  provider: NonNullable<AdminLiveOpsOverviewView['providers'][number]>;
  registryEntry: BrokerRegistryEntry | null;
}) {
  const assessment = assessProviderVerification({
    // The overview's own environment facts stay usable when the registry join
    // failed; implementation/adapter/verification then degrade fail-closed.
    environments:
      registryEntry?.environments ??
      (provider.supportsLive
        ? (['DEMO', 'LIVE'] as const)
        : provider.supportsDemo
          ? (['DEMO'] as const)
          : null),
    implementationStatus: registryEntry?.status ?? null,
    adapterAvailable: registryEntry?.adapterAvailable ?? null,
    productionLiveVerification: registryEntry?.productionLiveVerification ?? null,
  });

  return (
    <tr>
      <td className="admin-table__cell-strong">{provider.brokerName}</td>
      <td>
        <Badge variant={verificationBadgeVariant(assessment.environmentCapability)}>
          {assessment.environmentCapability}
        </Badge>
      </td>
      <td>
        <Badge variant={verificationBadgeVariant(assessment.implementationAvailability)}>
          {assessment.implementationAvailability}
        </Badge>
        <div className="admin-table__cell-muted text-sm">
          {registryEntry ? formatEnumLabel(registryEntry.status) : 'Registry unavailable'}
        </div>
      </td>
      <td>
        <Badge variant={verificationBadgeVariant(assessment.adapterAvailability)}>
          {assessment.adapterAvailability}
        </Badge>
      </td>
      <td>
        <Badge variant={verificationBadgeVariant(assessment.verificationStatus)}>
          {assessment.verificationStatus}
        </Badge>
        {registryEntry?.productionLiveVerification?.status === 'VERIFIED' && (
          <div className="admin-table__cell-muted text-sm">
            {registryEntry.productionLiveVerification.evidenceRef ?? 'Operator attested'} ·{' '}
            {formatAdminTimestamp(registryEntry.productionLiveVerification.verifiedAt)}
          </div>
        )}
      </td>
      <td>
        <ProviderCapabilities capabilities={provider.capabilities} />
      </td>
    </tr>
  );
}

/**
 * Connection authority row: (e) identity-specific production-LIVE eligibility
 * and (f) current BrokerConnection executability — separate columns from the
 * fixed taxonomy, plus the server-reported identity facts.
 */
function ConnectionAuthorityRow({
  row,
  registryEntry,
}: {
  row: AdminConnectionRowView;
  registryEntry: BrokerRegistryEntry | null;
}) {
  const assessment = assessProviderVerification({
    environments: registryEntry?.environments ?? null,
    implementationStatus: registryEntry?.status ?? null,
    adapterAvailable: registryEntry?.adapterAvailable ?? null,
    productionLiveVerification: registryEntry?.productionLiveVerification ?? null,
    accountType: row.accountType,
    logicalAccountKey: row.logicalAccountKey ?? null,
    authorizationStatus: row.authorizationStatus,
    executable: row.executable,
  });

  return (
    <tr>
      <td>
        <div className="admin-table__cell-strong">{row.brokerName}</div>
        <div className="admin-table__cell-muted break-long">
          {row.displayName ?? formatEnumLabel(row.brokerId)} · {row.maskedAccountId ?? '—'} ·{' '}
          {row.accountType}
        </div>
      </td>
      <td>
        <div className="admin-table__cell-mono text-sm">{row.providerBrokerIdentity ?? '—'}</div>
        <div className="admin-table__cell-mono admin-table__cell-muted text-sm break-long">
          {row.logicalAccountKey ?? 'Not derived'}
        </div>
      </td>
      <td>
        <Badge variant={verificationBadgeVariant(assessment.identityProductionLiveEligibility)}>
          {assessment.identityProductionLiveEligibility}
        </Badge>
      </td>
      <td>
        <Badge variant={verificationBadgeVariant(assessment.connectionExecutability)}>
          {assessment.connectionExecutability}
        </Badge>
        <div className="admin-table__cell-muted text-sm">
          Authorization {formatEnumLabel(row.authorizationStatus)}
        </div>
      </td>
      <td>
        <Badge variant={verificationBadgeVariant(assessment.label)}>{assessment.label}</Badge>
        <div className="admin-table__cell-muted text-sm">
          Live-trading flag (compatibility mirror): {row.liveTradingEnabled ? 'enabled' : 'not enabled'}
        </div>
      </td>
    </tr>
  );
}

function DiscrepancyRow({ row }: { row: AdminDiscrepancyRowView }) {
  return (
    <tr>
      <td className="admin-table__cell-mono">{row.type}</td>
      <td>
        <Badge variant={severityBadgeVariant(row.severity)}>{row.severity}</Badge>
      </td>
      <td>
        <Badge variant={discrepancyStatusBadgeVariant(row.status)}>{row.status}</Badge>
      </td>
      <td className="admin-table__cell-mono">{row.brokerId}</td>
      <td className="break-long">{row.description}</td>
      <td>
        <time dateTime={row.detectedAt}>{formatAdminTimestamp(row.detectedAt)}</time>
      </td>
    </tr>
  );
}

export default function AdminLiveOpsPage() {
  const { hasAdminRole } = useAuth();

  const [overview, setOverview] = useState<AdminLiveOpsOverviewView | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  /** Shared provider registry joined into the capability matrix (null = unavailable → fail-closed labels). */
  const [providerRegistry, setProviderRegistry] = useState<BrokerRegistryEntry[] | null>(null);

  const [authorityRows, setAuthorityRows] = useState<AdminConnectionRowView[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [authorityRowsError, setAuthorityRowsError] = useState<string | null>(null);

  const [discFilter, setDiscFilter] = useState<AdminDiscrepancyFilter>('ALL');
  const [discRows, setDiscRows] = useState<AdminDiscrepancyRowView[]>([]);
  const [discTotal, setDiscTotal] = useState(0);
  const [discOffset, setDiscOffset] = useState(0);
  const [loadingDisc, setLoadingDisc] = useState(true);
  const [discError, setDiscError] = useState<string | null>(null);

  /** Monotonic request id so stale discrepancy responses never overwrite newer pages. */
  const discRequestSeq = useRef(0);
  /** Separate monotonic id for the connection authority rows. */
  const connectionsRequestSeq = useRef(0);

  const refreshOverview = useCallback(async () => {
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      const [overviewPayload, registry] = await Promise.all([
        loadAdminLiveOpsOverview(),
        // Registry join powers the implementation/adapter/verification
        // columns; failure degrades fail-closed (never toward "Live").
        loadAdminProviderRegistry().catch(() => null),
      ]);
      setOverview(overviewPayload);
      setProviderRegistry(registry);
    } catch (err) {
      setOverview(null);
      setProviderRegistry(null);
      setOverviewError(
        err instanceof Error ? err.message : 'Failed to load live operations overview.',
      );
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const refreshAuthorityRows = useCallback(async () => {
    const seq = ++connectionsRequestSeq.current;
    setLoadingConnections(true);
    setAuthorityRowsError(null);
    try {
      const page = await loadAdminConnections('ALL', ADMIN_TABLE_PAGE_SIZE, 0);
      if (seq !== connectionsRequestSeq.current) return;
      setAuthorityRows(page.connections);
    } catch (err) {
      if (seq !== connectionsRequestSeq.current) return;
      setAuthorityRows([]);
      setAuthorityRowsError(
        err instanceof Error ? err.message : 'Failed to load connection authority rows.',
      );
    } finally {
      if (seq === connectionsRequestSeq.current) {
        setLoadingConnections(false);
      }
    }
  }, []);

  const loadDiscrepancyPage = useCallback(
    async (filter: AdminDiscrepancyFilter, offset: number) => {
      const seq = ++discRequestSeq.current;
      setLoadingDisc(true);
      setDiscError(null);
      try {
        const page = await loadAdminDiscrepancies(filter, ADMIN_DISCREPANCY_PAGE_SIZE, offset);
        if (seq !== discRequestSeq.current) return;
        setDiscRows(page.discrepancies);
        setDiscTotal(page.total);
        setDiscOffset(page.offset);
      } catch (err) {
        if (seq !== discRequestSeq.current) return;
        setDiscRows([]);
        setDiscTotal(0);
        setDiscError(err instanceof Error ? err.message : 'Failed to load discrepancies.');
      } finally {
        if (seq === discRequestSeq.current) {
          setLoadingDisc(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!hasAdminRole) return;
    void refreshOverview();
    void refreshAuthorityRows();
    void loadDiscrepancyPage('ALL', 0);
  }, [hasAdminRole, refreshOverview, refreshAuthorityRows, loadDiscrepancyPage]);

  const handleRefresh = useCallback(() => {
    void refreshOverview();
    void refreshAuthorityRows();
    void loadDiscrepancyPage(discFilter, 0);
  }, [refreshOverview, refreshAuthorityRows, loadDiscrepancyPage, discFilter]);

  const handleDiscFilterChange = useCallback(
    (filter: AdminDiscrepancyFilter) => {
      if (filter === discFilter) return;
      setDiscFilter(filter);
      void loadDiscrepancyPage(filter, 0);
    },
    [discFilter, loadDiscrepancyPage],
  );

  const handleDiscPrev = useCallback(() => {
    const nextOffset = Math.max(0, discOffset - ADMIN_DISCREPANCY_PAGE_SIZE);
    void loadDiscrepancyPage(discFilter, nextOffset);
  }, [discFilter, discOffset, loadDiscrepancyPage]);

  const handleDiscNext = useCallback(() => {
    const nextOffset = discOffset + ADMIN_DISCREPANCY_PAGE_SIZE;
    if (nextOffset < discTotal) {
      void loadDiscrepancyPage(discFilter, nextOffset);
    }
  }, [discFilter, discOffset, discTotal, loadDiscrepancyPage]);

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

  const connections = overview?.connections ?? null;
  const discrepancies = overview?.discrepancies ?? null;
  const activeControls = overview?.activeControls ?? [];
  const expiredControls = overview?.expiredControls ?? null;
  const providers = overview?.providers ?? [];
  const automation = overview?.automation ?? null;

  const discStart = discTotal === 0 ? 0 : discOffset + 1;
  const discEnd = Math.min(discOffset + discRows.length, discTotal);
  const discHasPrev = discOffset > 0;
  const discHasNext = discOffset + ADMIN_DISCREPANCY_PAGE_SIZE < discTotal;

  return (
    <>
      <h1>Live Ops</h1>
      <p className="muted" style={{ marginBottom: '1.5rem' }}>
        Operational overview of live broker connectivity, reconciliation health, and emergency
        execution controls. Read-only visibility — credentials are never exposed.
      </p>

      {overviewError && <Alert variant="error">{overviewError}</Alert>}

      <div className="admin-liveops-header">
        <p className="admin-liveops-header__meta">
          {loadingOverview
            ? 'Loading overview…'
            : overview
              ? `Generated ${formatAdminTimestamp(overview.generatedAt)}`
              : 'Overview unavailable'}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          disabled={loadingOverview || loadingDisc}
          aria-label="Refresh live operations overview"
        >
          Refresh
        </Button>
      </div>

      {/* §39 — connection state buckets */}
      <Card title="Connection state">
        {loadingOverview ? (
          <p className="muted">Loading connection state…</p>
        ) : connections ? (
          <div className="stat-grid">
            <StatTile label="Total connections" value={connections.total} />
            <StatTile
              label="Connected"
              value={connections.connected}
              variant={connections.connected > 0 ? 'success' : undefined}
            />
            <StatTile label="Connecting" value={connections.connecting} />
            <StatTile label="Disconnected" value={connections.disconnected} />
            <StatTile
              label="Error"
              value={connections.error}
              variant={connections.error > 0 ? 'error' : undefined}
            />
            <StatTile
              label="Suspended (conn.)"
              value={connections.suspendedConnectionStatus}
              variant={connections.suspendedConnectionStatus > 0 ? 'warning' : undefined}
            />
            <StatTile
              label="Authorization required"
              value={connections.authorizationRequired}
              variant={connections.authorizationRequired > 0 ? 'warning' : undefined}
            />
            <StatTile
              label="Suspended"
              value={connections.suspended}
              variant={connections.suspended > 0 ? 'warning' : undefined}
            />
            <StatTile
              label="Revoked"
              value={connections.revoked}
              variant={connections.revoked > 0 ? 'warning' : undefined}
            />
            <StatTile label="Demo accounts" value={connections.demo} />
            <StatTile
              label="Live accounts"
              value={connections.live}
              variant={connections.live > 0 ? 'warning' : undefined}
            />
          </div>
        ) : (
          <p className="muted">Connection state unavailable.</p>
        )}
      </Card>

      {/* §39 — reconciliation discrepancy counts */}
      <Card title="Reconciliation discrepancies">
        {loadingOverview ? (
          <p className="muted">Loading discrepancy counts…</p>
        ) : discrepancies ? (
          <div className="stat-grid">
            <StatTile
              label="Open"
              value={discrepancies.open}
              variant={discrepancies.open > 0 ? 'warning' : undefined}
            />
            <StatTile
              label="Critical (open)"
              value={discrepancies.openCritical}
              variant={discrepancies.openCritical > 0 ? 'error' : undefined}
            />
            <StatTile
              label="Warning (open)"
              value={discrepancies.openWarning}
              variant={discrepancies.openWarning > 0 ? 'warning' : undefined}
            />
            <StatTile
              label="Resolved last 24h"
              value={discrepancies.resolvedLast24h}
              variant={discrepancies.resolvedLast24h > 0 ? 'success' : undefined}
            />
          </div>
        ) : (
          <p className="muted">Discrepancy counts unavailable.</p>
        )}
      </Card>

      {/* §39 — active emergency execution controls */}
      <Card title={`Active execution controls (${activeControls.length})`}>
        {loadingOverview ? (
          <p className="muted">Loading execution controls…</p>
        ) : activeControls.length === 0 ? (
          <EmptyState
            icon="✓"
            title="No active emergency controls"
            description="No system suspensions are active. Automation gates are clear."
          />
        ) : (
          <div className="admin-control-list">
            {activeControls.map((control) => (
              <ControlCard key={control.id} control={control} />
            ))}
          </div>
        )}
      </Card>

      {/* §39 — expired execution controls (retained records, never blocking) */}
      {expiredControls && expiredControls.controls.length > 0 && (
        <Card
          title={`Expired controls (retained as records) — ${expiredControls.count}`}
        >
          <p className="muted text-sm" style={{ marginBottom: '1rem' }}>
            Expired controls are retained as records — never blocking, reactivation replaces them.
            Showing the {expiredControls.controls.length} most recent of {expiredControls.count}{' '}
            retained records.
          </p>
          <div className="admin-control-list">
            {expiredControls.controls.map((control) => (
              <ControlCard key={control.id} control={control} />
            ))}
          </div>
        </Card>
      )}

      {/* §39 — provider capability matrix (Sprint 56 round 5: (a)–(d) separated) */}
      <Card title={`Provider capability matrix (${providers.length})`}>
        <p className="muted text-sm" style={{ marginTop: 0 }}>
          Capability is NOT approval: environment capability, implementation, adapter availability,
          and production-LIVE verification are separate facts rendered from the fixed label taxonomy.
          An unverified provider is never listed as live.
          {providerRegistry === null && ' Shared registry unavailable — implementation/adapter/verification degraded fail-closed.'}
        </p>
        {loadingOverview ? (
          <p className="muted">Loading provider matrix…</p>
        ) : providers.length === 0 ? (
          <EmptyState
            icon="🔌"
            title="No providers registered"
            description="Broker providers will appear here once registered."
          />
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table" aria-label="Provider capability matrix">
              <thead>
                <tr>
                  <th scope="col">Broker</th>
                  <th scope="col">Environment capability</th>
                  <th scope="col">Implementation</th>
                  <th scope="col">Adapter</th>
                  <th scope="col">Production-LIVE verification</th>
                  <th scope="col">Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => (
                  <ProviderMatrixRow
                    key={provider.brokerId}
                    provider={provider}
                    registryEntry={
                      providerRegistry?.find((entry) => entry.id === provider.brokerId) ?? null
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Sprint 56 round 5 — connection execution authority: (e) + (f) per connection */}
      <Card title="Connection execution authority">
        <p className="muted text-sm" style={{ marginTop: 0 }}>
          Per BrokerConnection: identity-specific production-LIVE eligibility and current
          executability are separate from provider capability. The live-trading flag is shown only as
          a compatibility mirror — it is not the authoritative trading state.
        </p>
        {authorityRowsError && <Alert variant="error">{authorityRowsError}</Alert>}
        {loadingConnections ? (
          <p className="muted">Loading connection authority…</p>
        ) : authorityRows.length === 0 && !authorityRowsError ? (
          <EmptyState
            icon="🔌"
            title="No broker connections"
            description="No user connections exist yet."
          />
        ) : (
          <div className="admin-table-scroll">
            <table className="admin-table" aria-label="Connection execution authority">
              <thead>
                <tr>
                  <th scope="col">Connection</th>
                  <th scope="col">Provider identity · logical account</th>
                  <th scope="col">Identity production-LIVE eligibility</th>
                  <th scope="col">Current executability</th>
                  <th scope="col">Verification label</th>
                </tr>
              </thead>
              <tbody>
                {authorityRows.map((row) => (
                  <ConnectionAuthorityRow
                    key={row.id}
                    row={row}
                    registryEntry={
                      providerRegistry?.find((entry) => entry.id === row.brokerId) ?? null
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted text-sm">
          Showing the first {authorityRows.length} connections — the full inventory with per-state
          filters lives in Brokers.
        </p>
      </Card>

      {/* §39 — automation session counts */}
      <Card title="Automation">
        {loadingOverview ? (
          <p className="muted">Loading automation status…</p>
        ) : automation ? (
          <div className="stat-grid">
            <StatTile
              label="Active sessions"
              value={automation.activeSessions}
              variant={automation.activeSessions > 0 ? 'success' : undefined}
            />
            <StatTile
              label="Suspended sessions"
              value={automation.suspendedSessions}
              variant={automation.suspendedSessions > 0 ? 'warning' : undefined}
            />
          </div>
        ) : (
          <p className="muted">Automation status unavailable.</p>
        )}
      </Card>

      {/* §39 — discrepancy detail (own section; connection detail in /admin/brokers) */}
      <Card title="Reconciliation discrepancy log">
        <div className="filter-group" role="group" aria-label="Discrepancy filter">
          {DISCREPANCY_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className="filter-group__btn"
              aria-pressed={discFilter === filter}
              disabled={loadingDisc}
              onClick={() => handleDiscFilterChange(filter)}
            >
              {filter}
            </button>
          ))}
        </div>

        {discError && <Alert variant="error">{discError}</Alert>}

        {loadingDisc ? (
          <p className="muted">Loading discrepancies…</p>
        ) : discRows.length === 0 && !discError ? (
          <EmptyState
            icon="✓"
            title="No discrepancies"
            description="No reconciliation discrepancies match this filter."
          />
        ) : (
          <>
            <div className="admin-table-scroll">
              <table className="admin-table" aria-label="Reconciliation discrepancies">
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Status</th>
                    <th scope="col">Broker</th>
                    <th scope="col">Description</th>
                    <th scope="col">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {discRows.map((row) => (
                    <DiscrepancyRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-table-footer">
              <p className="admin-table-footer__count" aria-live="polite">
                Showing {discStart}–{discEnd} of {discTotal}
              </p>
              <div className="admin-pagination">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDiscPrev}
                  disabled={!discHasPrev || loadingDisc}
                  aria-label="Previous discrepancy page"
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDiscNext}
                  disabled={!discHasNext || loadingDisc}
                  aria-label="Next discrepancy page"
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card title="Investigate further">
        <div className="admin-liveops-links">
          <Link
            href="/admin/brokers"
            className="btn btn--secondary btn--sm"
            aria-label="View broker connections"
          >
            View broker connections
          </Link>
          <Link href="/admin/audit" className="btn btn--secondary btn--sm" aria-label="Open audit log">
            Open audit log
          </Link>
        </div>
        <p className="muted text-sm mt-4">
          Discrepancy remediation flows through the reconciliation resolution APIs; emergency
          control activation and clearing remain in the execution-control workspace.
        </p>
      </Card>
    </>
  );
}
