'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatEnumLabel } from '@irexpro/types';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { mapApiError } from '@/lib/error-mapping';
import {
  loadLiveAccountActivity,
  loadLiveAccountOrders,
  loadLiveAccountOverview,
  loadLiveAccountPositions,
  type LiveAccountAlertView,
  type LiveAccountConnectionView,
  type LiveAccountEnvironment,
  type LiveAccountOverviewView,
  type LiveActivityRowView,
  type LiveAutomationSummary,
  type LiveExecutionHealthSummary,
  type LiveOrderRowView,
  type LiveOrderStatusFilter,
  type LivePositionRowView,
} from '@/lib/live-account';
import './live-account.css';

const ORDERS_PAGE_SIZE = 10;
const ACTIVITY_PAGE_SIZE = 10;

const ORDER_FILTERS: readonly LiveOrderStatusFilter[] = ['WORKING', 'HISTORY', 'ALL'];

// ── Presentation helpers (badge semantics match the trade/portfolio pages) ───

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** §36 banner copy — the environment is ALWAYS the backend-computed value. */
function environmentBannerCopy(environment: LiveAccountEnvironment): {
  className: string;
  title: string;
} {
  switch (environment) {
    case 'LIVE':
      return {
        className: 'live-env-banner live-env-banner--live',
        title: 'LIVE ACCOUNT — REAL FUNDS AT RISK',
      };
    case 'DEMO':
      return {
        className: 'live-env-banner live-env-banner--demo',
        title: 'DEMO ACCOUNT — SIMULATED FUNDS',
      };
    case 'PAPER':
      return {
        className: 'live-env-banner live-env-banner--paper',
        title: 'PAPER TRADING — SIMULATED',
      };
    case 'UNKNOWN':
      return {
        className: 'live-env-banner live-env-banner--unknown',
        title: 'ACCOUNT ENVIRONMENT UNKNOWN — VERIFY BROKER CONNECTION',
      };
  }
}

function connectionStatusVariant(status: string): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'CONNECTED') return 'success';
  if (status === 'CONNECTING') return 'warning';
  if (status === 'ERROR' || status === 'SUSPENDED') return 'error';
  return 'info';
}

function authorizationStatusVariant(status: string): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'ACTIVE' || status === 'READY' || status === 'AUTHORIZED') return 'success';
  if (status === 'AUTHORIZATION_REQUIRED' || status === 'VERIFYING') return 'warning';
  if (
    status === 'SUSPENDED' ||
    status === 'REVOKED' ||
    status === 'ERROR' ||
    status === 'DISCONNECTED'
  ) {
    return 'error';
  }
  return 'info';
}

function credentialStatusVariant(status: string): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'VERIFIED' || status === 'ROTATED') return 'success';
  if (status === 'CREATED') return 'info';
  return 'error';
}

function healthVariant(health: string): 'success' | 'warning' | 'error' | 'info' {
  if (health === 'HEALTHY') return 'success';
  if (health === 'DEGRADED') return 'warning';
  if (health === 'UNHEALTHY') return 'error';
  return 'info';
}

/** DEMO/LIVE badge colors match the §36 banner semantics (UNKNOWN is cautionary). */
function accountTypeVariant(accountType: 'DEMO' | 'LIVE'): 'warning' | 'error' {
  return accountType === 'LIVE' ? 'error' : 'warning';
}

function environmentVariant(environment: LiveAccountEnvironment): 'error' | 'warning' | 'info' {
  if (environment === 'LIVE') return 'error';
  if (environment === 'DEMO') return 'warning';
  if (environment === 'UNKNOWN') return 'warning';
  return 'info';
}

function automationStatusVariant(
  status: LiveAutomationSummary['status'],
): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'PAUSED') return 'warning';
  if (status === 'SUSPENDED_RISK_LIMIT' || status === 'SUSPENDED_BROKER') return 'error';
  return 'info';
}

function orderStatusVariant(status: LiveOrderRowView['status']): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'FILLED') return 'success';
  if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') return 'error';
  if (
    status === 'RECONCILIATION_PENDING' ||
    status === 'CREATED' ||
    status === 'SUBMITTED' ||
    status === 'ACKNOWLEDGED' ||
    status === 'PARTIALLY_FILLED'
  ) {
    return 'warning';
  }
  return 'info';
}

function positionStatusVariant(status: LivePositionRowView['status']): 'success' | 'warning' {
  return status === 'OPEN' ? 'success' : 'warning';
}

function alertSeverityVariant(severity: LiveAccountAlertView['severity']): 'error' | 'warning' | 'info' {
  if (severity === 'CRITICAL') return 'error';
  if (severity === 'WARNING') return 'warning';
  return 'info';
}

function reconciliationRunStatusVariant(
  status: LiveAccountConnectionView['reconciliation']['lastRunStatus'],
): 'success' | 'warning' | 'error' | 'info' | null {
  if (status === null) return null;
  if (status === 'COMPLETED') return 'success';
  if (status === 'COMPLETED_WITH_WARNINGS') return 'warning';
  if (status === 'FAILED') return 'error';
  return 'info';
}

function reconciliationSyncVariant(summary: LiveAccountConnectionView['reconciliation']): 'success' | 'warning' | 'error' {
  if (summary.inSync) return 'success';
  if (summary.openCritical > 0) return 'error';
  return 'warning';
}

// ── Section components ───────────────────────────────────────────────────────

function EnvironmentBanner({
  environment,
  generatedAt,
}: {
  environment: LiveAccountEnvironment;
  generatedAt: string;
}) {
  const copy = environmentBannerCopy(environment);
  return (
    <section className={copy.className} aria-label="Account environment" data-testid="live-env-banner">
      <span className="live-env-banner__marker" aria-hidden="true" />
      <div>
        <strong className="live-env-banner__title">{copy.title}</strong>
        <p className="live-env-banner__meta">
          Environment set by the server · Snapshot generated{' '}
          <time dateTime={generatedAt}>{formatTimestamp(generatedAt)}</time>
        </p>
      </div>
    </section>
  );
}

function EnvironmentBannerPlaceholder() {
  return (
    <section
      className="live-env-banner live-env-banner--loading"
      aria-label="Loading account environment"
      data-testid="live-env-banner-loading"
    >
      <span className="live-env-banner__marker" aria-hidden="true" />
      <div>
        <strong className="live-env-banner__title">Loading account environment…</strong>
        <p className="live-env-banner__meta">
          The environment strip appears only after the server confirms the account mode.
        </p>
      </div>
    </section>
  );
}

function AccountSummaryCard({ connection }: { connection: LiveAccountConnectionView }) {
  return (
    <Card className="cockpit-panel">
      <div className="live-connection-head">
        <div className="live-connection-name">
          <strong>{connection.displayName ?? connection.brokerName}</strong>
          <span>{connection.maskedAccountId ?? 'No masked account id on record'}</span>
        </div>
        <Badge variant={accountTypeVariant(connection.accountType)}>
          {formatEnumLabel(connection.accountType)}
        </Badge>
      </div>
      {connection.financial ? (
        <dl className="cockpit-detail-list">
          <div>
            <dt>Currency</dt>
            <dd>{connection.financial.currency ?? 'Not available'}</dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd>{connection.financial.balance}</dd>
          </div>
          <div>
            <dt>Equity</dt>
            <dd>{connection.financial.equity}</dd>
          </div>
          <div>
            <dt>Margin</dt>
            <dd>{connection.financial.margin}</dd>
          </div>
          <div>
            <dt>Free margin</dt>
            <dd>{connection.financial.freeMargin}</dd>
          </div>
          <div>
            <dt>Margin level</dt>
            <dd>{connection.financial.marginLevel ?? 'Not available'}</dd>
          </div>
          <div>
            <dt>Open positions</dt>
            <dd>{connection.financial.openPositionsCount}</dd>
          </div>
          <div>
            <dt>Synced</dt>
            <dd>{formatTimestamp(connection.financial.syncedAt)}</dd>
          </div>
        </dl>
      ) : (
        <p className="muted">
          No synchronized account data yet. Balance, equity, and margin fields stay hidden until the
          broker account snapshot is synchronized.
        </p>
      )}
    </Card>
  );
}

function ConnectionStatusCard({ connection }: { connection: LiveAccountConnectionView }) {
  return (
    <Card className="cockpit-panel">
      <div className="live-connection-head">
        <div className="live-connection-name">
          <strong>{connection.brokerName}</strong>
          <span>{connection.displayName ?? 'No display name set'}</span>
        </div>
        <Badge variant={healthVariant(connection.health)}>{formatEnumLabel(connection.health)}</Badge>
      </div>
      <div className="live-badge-row">
        <Badge variant={accountTypeVariant(connection.accountType)}>
          {formatEnumLabel(connection.accountType)}
        </Badge>
        <Badge variant={connectionStatusVariant(connection.connectionStatus)}>
          {formatEnumLabel(connection.connectionStatus)}
        </Badge>
        <Badge variant={authorizationStatusVariant(connection.authorizationStatus)}>
          {formatEnumLabel(connection.authorizationStatus)}
        </Badge>
        <Badge variant={credentialStatusVariant(connection.credentialStatus)}>
          {formatEnumLabel(connection.credentialStatus)}
        </Badge>
        <Badge variant={connection.executable ? 'success' : 'error'}>
          {connection.executable ? 'Execution enabled' : 'Execution disabled'}
        </Badge>
      </div>
      <dl className="cockpit-detail-list">
        <div>
          <dt>Masked account</dt>
          <dd>{connection.maskedAccountId ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>Account currency</dt>
          <dd>{connection.accountCurrency ?? 'Not available'}</dd>
        </div>
        {connection.accountLeverage !== null && (
          <div>
            <dt>Leverage</dt>
            <dd>1:{connection.accountLeverage}</dd>
          </div>
        )}
        <div>
          <dt>Live trading</dt>
          <dd>{connection.liveTradingEnabled ? 'Enabled' : 'Not enabled'}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>{formatTimestamp(connection.lastSyncAt)}</dd>
        </div>
        <div>
          <dt>Last health check</dt>
          <dd>{formatTimestamp(connection.lastHealthCheckAt)}</dd>
        </div>
      </dl>
      {connection.lastErrorMessage && (
        <p className="live-record__subtle" style={{ overflowWrap: 'anywhere' }}>
          Last sanitized error: {connection.lastErrorMessage}
        </p>
      )}
      <div className="live-card-links">
        <Link href="/onboarding/broker" className="cockpit-text-link">
          Manage broker connections
        </Link>
        {connection.executable && (
          <Link href="/trade" className="cockpit-text-link">
            Open trading workspace
          </Link>
        )}
      </div>
    </Card>
  );
}

function AutomationCard({
  automation,
  sessionBrokerName,
}: {
  automation: LiveAutomationSummary;
  sessionBrokerName: string | null;
}) {
  return (
    <Card className="cockpit-panel">
      <div className="cockpit-card-badge">
        <Badge variant={automationStatusVariant(automation.status)}>
          {formatEnumLabel(automation.status)}
        </Badge>
      </div>
      {automation.killSwitchActive && (
        <Alert variant="error">
          <div style={{ flex: 1 }}>
            <strong>Kill switch active — automation halted.</strong>
            <p style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
              {automation.killSwitchReason ?? 'No reason was provided by the server.'}
            </p>
          </div>
        </Alert>
      )}
      <dl className="cockpit-detail-list">
        <div>
          <dt>Session</dt>
          <dd>{automation.sessionId ? 'Session on record' : 'No session on record'}</dd>
        </div>
        <div>
          <dt>Session broker</dt>
          <dd>{sessionBrokerName ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatTimestamp(automation.startedAt)}</dd>
        </div>
        <div>
          <dt>Ended</dt>
          <dd>{formatTimestamp(automation.endedAt)}</dd>
        </div>
        <div>
          <dt>Kill switch</dt>
          <dd>{automation.killSwitchActive ? 'Engaged' : 'Not engaged'}</dd>
        </div>
      </dl>
      <Link href="/trade" className="cockpit-text-link">
        Open the trading workspace
      </Link>
    </Card>
  );
}

function ExecutionHealthTiles({ health }: { health: LiveExecutionHealthSummary }) {
  const reconciliationWarning = health.reconciliationPending > 0;
  return (
    <div className="live-stat-tiles">
      <div className="live-stat-tile">
        <span className="live-stat-tile__label">Open positions</span>
        <strong>{health.openPositions}</strong>
      </div>
      <div className="live-stat-tile">
        <span className="live-stat-tile__label">Working orders</span>
        <strong>{health.workingOrders}</strong>
      </div>
      <div className={`live-stat-tile${reconciliationWarning ? ' live-stat-tile--warning' : ''}`}>
        <span className="live-stat-tile__label">Reconciliation pending</span>
        <strong>{health.reconciliationPending}</strong>
        {reconciliationWarning && <Badge variant="warning">Needs attention</Badge>}
      </div>
      <div className="live-stat-tile">
        <span className="live-stat-tile__label">Rejected (24h)</span>
        <strong>{health.rejectedLast24h}</strong>
      </div>
      <div className="live-stat-tile">
        <span className="live-stat-tile__label">Filled (24h)</span>
        <strong>{health.filledLast24h}</strong>
      </div>
    </div>
  );
}

function PositionRecord({ position }: { position: LivePositionRowView }) {
  const pending = position.status === 'RECONCILIATION_PENDING';
  return (
    <article className={`live-record${pending ? ' live-record--pending' : ''}`}>
      <div className="live-record__header">
        <div>
          <strong>{position.instrument}</strong>
          <span className="live-record__meta">
            {' '}
            {position.lotSize} lot · {position.brokerName ?? 'Broker unavailable'}
          </span>
        </div>
        <div className="live-badge-row" style={{ marginBottom: 0 }}>
          <Badge variant={environmentVariant(position.environment)}>
            {formatEnumLabel(position.environment)}
          </Badge>
          <Badge variant={position.direction === 'BUY' ? 'success' : 'error'}>
            {position.direction}
          </Badge>
          <Badge variant={positionStatusVariant(position.status)}>
            {formatEnumLabel(position.status)}
          </Badge>
        </div>
      </div>
      <dl className="live-record__grid">
        <div>
          <dt>Requested entry</dt>
          <dd>{position.requestedEntryPrice}</dd>
        </div>
        <div>
          <dt>Fill price</dt>
          <dd>{position.fillPrice ?? 'Pending'}</dd>
        </div>
        <div>
          <dt>Stop loss</dt>
          <dd>{position.stopLoss}</dd>
        </div>
        <div>
          <dt>Take profit</dt>
          <dd>{position.takeProfit}</dd>
        </div>
        {position.trailingStopPips && (
          <div>
            <dt>Trailing stop</dt>
            <dd>{position.trailingStopPips} pips</dd>
          </div>
        )}
        <div>
          <dt>Opened</dt>
          <dd>{formatTimestamp(position.openedAt)}</dd>
        </div>
      </dl>
    </article>
  );
}

function OrderRecord({ order }: { order: LiveOrderRowView }) {
  const pending = order.status === 'RECONCILIATION_PENDING';
  return (
    <article className={`live-record${pending ? ' live-record--pending' : ''}`}>
      <div className="live-record__header">
        <div>
          <strong>{order.instrument}</strong>
          <span className="live-record__meta">
            {' '}
            {formatEnumLabel(order.orderKind)} · {order.timeInForce} ·{' '}
            {order.brokerName ?? 'Broker unavailable'}
          </span>
        </div>
        <div className="live-badge-row" style={{ marginBottom: 0 }}>
          <Badge variant={order.direction === 'BUY' ? 'success' : 'error'}>{order.direction}</Badge>
          <Badge variant={orderStatusVariant(order.status)}>{formatEnumLabel(order.status)}</Badge>
        </div>
      </div>
      <dl className="live-record__grid">
        <div>
          <dt>Requested</dt>
          <dd>
            {order.requestedQuantity} @ {order.requestedPrice ?? 'Market'}
          </dd>
        </div>
        <div>
          <dt>Filled</dt>
          <dd>
            {order.filledQuantity}
            {order.avgFillPrice ? ` @ ${order.avgFillPrice}` : ''}
          </dd>
        </div>
        {order.stopPrice && (
          <div>
            <dt>Stop price</dt>
            <dd>{order.stopPrice}</dd>
          </div>
        )}
        {order.rejectReason && (
          <div>
            <dt>Reject reason</dt>
            <dd>{order.rejectReason}</dd>
          </div>
        )}
        <div>
          <dt>Created</dt>
          <dd>{formatTimestamp(order.createdAt)}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>{formatTimestamp(order.submittedAt)}</dd>
        </div>
        {order.finalizedAt && (
          <div>
            <dt>Finalized</dt>
            <dd>{formatTimestamp(order.finalizedAt)}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

function ReconciliationCard({ connection }: { connection: LiveAccountConnectionView }) {
  const reconciliation = connection.reconciliation;
  const lastRunVariant = reconciliationRunStatusVariant(reconciliation.lastRunStatus);
  return (
    <Card className="cockpit-panel">
      <div className="live-connection-head">
        <div className="live-connection-name">
          <strong>{connection.brokerName}</strong>
          <span>{connection.displayName ?? connection.maskedAccountId ?? 'Connection'}</span>
        </div>
        <div className="live-badge-row" style={{ marginBottom: 0 }}>
          {lastRunVariant && (
            <Badge variant={lastRunVariant}>
              Last run: {formatEnumLabel(reconciliation.lastRunStatus)}
            </Badge>
          )}
          <Badge variant={reconciliationSyncVariant(reconciliation)}>
            {reconciliation.inSync
              ? 'In sync'
              : `${reconciliation.openDiscrepancies} open discrepancies`}
          </Badge>
        </div>
      </div>
      <dl className="cockpit-detail-list">
        <div>
          <dt>Last run</dt>
          <dd>{formatTimestamp(reconciliation.lastRunAt)}</dd>
        </div>
        <div>
          <dt>Last run status</dt>
          <dd>{formatEnumLabel(reconciliation.lastRunStatus) || 'Never run'}</dd>
        </div>
        <div>
          <dt>Open discrepancies</dt>
          <dd>{reconciliation.openDiscrepancies}</dd>
        </div>
        <div>
          <dt>Critical / warning</dt>
          <dd>
            {reconciliation.openCritical} / {reconciliation.openWarning}
          </dd>
        </div>
      </dl>
      {!reconciliation.inSync && (
        <Alert variant={reconciliation.openCritical > 0 ? 'error' : 'warning'}>
          Internal state and provider truth diverge for this connection. Open items stay visible
          until reconciliation resolves them — they are never hidden.
        </Alert>
      )}
    </Card>
  );
}

function AlertsCard({ alerts }: { alerts: LiveAccountAlertView[] }) {
  return (
    <Card
      title="Alerts"
      subtitle="Server-derived from authoritative state — not a separate client-side store."
      className="cockpit-panel"
    >
      {alerts.length === 0 ? (
        <p className="muted">All clear — no live-account alerts were returned.</p>
      ) : (
        <div className="live-alert-list" role="list" aria-label="Live account alerts">
          {alerts.map((alert) => (
            <div
              key={alert.key}
              className={`live-alert-item live-alert-item--${alert.severity.toLowerCase()}`}
              role="listitem"
            >
              <span className="live-alert-item__dot" aria-hidden="true" />
              <div>
                <strong>{formatEnumLabel(alert.kind)}</strong>
                <p>{alert.message}</p>
                {alert.action && (
                  <p className="live-record__subtle">Suggested action: {alert.action}</p>
                )}
                <div className="live-alert-item__meta">
                  <Badge variant={alertSeverityVariant(alert.severity)}>
                    {formatEnumLabel(alert.severity)}
                  </Badge>
                  {alert.brokerName && <span>{alert.brokerName}</span>}
                  {alert.connectionId === null && <span>Account-wide</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ActivityRow({ row }: { row: LiveActivityRowView }) {
  return (
    <div className="live-activity-row">
      <div className="live-activity-row__main">
        <span
          className={`live-activity-row__dot live-activity-row__dot--${row.severity.toLowerCase()}`}
          aria-hidden="true"
        />
        <div className="live-activity-row__text">
          <span className="live-activity-row__label">{formatEnumLabel(row.action)}</span>
          {row.resourceType && (
            <span className="live-activity-row__context">{formatEnumLabel(row.resourceType)}</span>
          )}
        </div>
      </div>
      <time className="live-activity-row__time" dateTime={row.createdAt}>
        {formatTimestamp(row.createdAt)}
      </time>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function LiveAccountPage() {
  const { user, logout, restoring } = useAuth();

  const [overview, setOverview] = useState<LiveAccountOverviewView | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [positions, setPositions] = useState<LivePositionRowView[] | null>(null);
  const [positionsTotal, setPositionsTotal] = useState(0);
  const [loadingPositions, setLoadingPositions] = useState(true);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  const [ordersFilter, setOrdersFilter] = useState<LiveOrderStatusFilter>('WORKING');
  const [orders, setOrders] = useState<LiveOrderRowView[]>([]);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [loadingMoreOrders, setLoadingMoreOrders] = useState(false);

  const [activity, setActivity] = useState<LiveActivityRowView[]>([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loadingMoreActivity, setLoadingMoreActivity] = useState(false);

  /** Monotonic request id so stale order responses never overwrite a newer filter page. */
  const ordersRequestSeq = useRef(0);

  const refreshOverview = useCallback(async () => {
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      setOverview(await loadLiveAccountOverview());
    } catch (err) {
      setOverview(null);
      setOverviewError(mapApiError(err).message);
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const refreshPositions = useCallback(async () => {
    setLoadingPositions(true);
    setPositionsError(null);
    try {
      const snapshot = await loadLiveAccountPositions();
      setPositions(snapshot.positions);
      setPositionsTotal(snapshot.total);
    } catch (err) {
      setPositions(null);
      setPositionsTotal(0);
      setPositionsError(mapApiError(err).message);
    } finally {
      setLoadingPositions(false);
    }
  }, []);

  const loadOrdersPage = useCallback(
    async (status: LiveOrderStatusFilter, offset: number, append: boolean) => {
      const seq = ++ordersRequestSeq.current;
      if (append) {
        setLoadingMoreOrders(true);
      } else {
        setLoadingOrders(true);
        setOrdersError(null);
      }
      try {
        const page = await loadLiveAccountOrders(status, ORDERS_PAGE_SIZE, offset);
        if (seq !== ordersRequestSeq.current) return;
        setOrders((previous) => (append ? [...previous, ...page.orders] : page.orders));
        setOrdersTotal(page.total);
      } catch (err) {
        if (seq !== ordersRequestSeq.current) return;
        if (!append) {
          setOrders([]);
          setOrdersTotal(0);
        }
        setOrdersError(mapApiError(err).message);
      } finally {
        if (seq === ordersRequestSeq.current) {
          setLoadingOrders(false);
          setLoadingMoreOrders(false);
        }
      }
    },
    [],
  );

  const loadActivityPage = useCallback(async (offset: number, append: boolean) => {
    if (append) {
      setLoadingMoreActivity(true);
    } else {
      setLoadingActivity(true);
      setActivityError(null);
    }
    try {
      const page = await loadLiveAccountActivity(ACTIVITY_PAGE_SIZE, offset);
      setActivity((previous) => (append ? [...previous, ...page.activity] : page.activity));
      setActivityTotal(page.total);
    } catch (err) {
      if (!append) {
        setActivity([]);
        setActivityTotal(0);
      }
      setActivityError(mapApiError(err).message);
    } finally {
      setLoadingActivity(false);
      setLoadingMoreActivity(false);
    }
  }, []);

  const refreshCore = useCallback(async () => {
    await Promise.all([refreshOverview(), refreshPositions()]);
  }, [refreshOverview, refreshPositions]);

  useEffect(() => {
    if (!user) return;
    void refreshCore();
    void loadOrdersPage('WORKING', 0, false);
    void loadActivityPage(0, false);
  }, [user, refreshCore, loadOrdersPage, loadActivityPage]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshCore(),
      loadOrdersPage(ordersFilter, 0, false),
      loadActivityPage(0, false),
    ]);
  }, [refreshCore, loadOrdersPage, loadActivityPage, ordersFilter]);

  const handleOrdersFilterChange = useCallback(
    (filter: LiveOrderStatusFilter) => {
      if (filter === ordersFilter) return;
      setOrdersFilter(filter);
      void loadOrdersPage(filter, 0, false);
    },
    [ordersFilter, loadOrdersPage],
  );

  const handleLoadMoreOrders = useCallback(() => {
    void loadOrdersPage(ordersFilter, orders.length, true);
  }, [ordersFilter, orders.length, loadOrdersPage]);

  const handleLoadMoreActivity = useCallback(() => {
    void loadActivityPage(activity.length, true);
  }, [activity.length, loadActivityPage]);

  if (restoring) {
    return (
      <div style={{ padding: '3rem' }}>
        <LoadingSpinner text="Restoring session…" />
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 620, margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">You need to log in to access your live account.</p>
          <Link href="/login" className="btn btn--primary mt-4">
            Go to login
          </Link>
        </Card>
      </div>
    );
  }

  const workspaceLoading =
    loadingOverview || loadingPositions || loadingOrders || loadingActivity;
  const connections = overview?.connections ?? [];
  const automation = overview?.automation ?? null;
  const sessionBrokerName =
    automation?.sessionConnectionId
      ? connections.find((connection) => connection.id === automation.sessionConnectionId)
          ?.brokerName ?? null
      : null;
  const ordersEmptyCopy =
    ordersFilter === 'WORKING'
      ? 'No working orders right now. Orders appear here while they are open with the broker.'
      : ordersFilter === 'HISTORY'
        ? 'No historical orders for this filter yet.'
        : 'No orders on record for this account yet.';

  /* §38 (10) — the activity timeline is independent of overview success, so it
   * is defined once and rendered in either layout branch below. */
  const activityTimelineCard = (
    <Card
      title="Activity Timeline"
      subtitle="Recent audit activity recorded for this account."
      className="cockpit-panel"
    >
      {activityError && <Alert variant="error">{activityError}</Alert>}
      {loadingActivity ? (
        <LoadingSpinner text="Loading activity…" />
      ) : activity.length === 0 && !activityError ? (
        <p className="muted">No activity recorded yet.</p>
      ) : (
        <div className="live-activity-list" aria-label="Recent live account activity">
          {activity.map((row) => (
            <ActivityRow key={row.id} row={row} />
          ))}
        </div>
      )}
      {!loadingActivity && activityTotal > 0 && (
        <p className="live-list-count">
          Showing {activity.length} of {activityTotal} activity rows
        </p>
      )}
      {!loadingActivity && activity.length < activityTotal && (
        <div className="live-load-more">
          <Button
            type="button"
            variant="secondary"
            loading={loadingMoreActivity}
            disabled={loadingMoreActivity}
            onClick={handleLoadMoreActivity}
          >
            {loadingMoreActivity ? 'Loading more…' : 'Load more activity'}
          </Button>
        </div>
      )}
    </Card>
  );

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/live-account" title="Live Account">
      <main className="terminal-foundation live-account" data-testid="live-account-dashboard">
        {/* §36 environment banner — first strip in the content area, backend-authoritative. */}
        {overview ? (
          <EnvironmentBanner
            environment={overview.environment}
            generatedAt={overview.generatedAt}
          />
        ) : loadingOverview ? (
          <EnvironmentBannerPlaceholder />
        ) : null}

        <section className="terminal-foundation__hero" aria-labelledby="live-account-title">
          <div>
            <p className="terminal-foundation__eyebrow">Live account</p>
            <h1 id="live-account-title" className="terminal-foundation__title">
              Live Account
            </h1>
            <p className="terminal-foundation__description">
              Server-authoritative broker account state: connection gates, synchronized financials,
              automation, execution health, reconciliation, alerts, and audit activity. Nothing on
              this page is derived in the browser.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            loading={workspaceLoading}
            disabled={workspaceLoading}
            onClick={() => void refreshAll()}
          >
            {workspaceLoading ? 'Refreshing…' : 'Refresh live account'}
          </Button>
        </section>

        {overviewError && (
          <Alert variant="error">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 'var(--space-1)' }}>
                {overviewError}
              </div>
              <p className="text-sm muted" style={{ marginTop: 0 }}>
                The environment banner and account panels are unavailable. No live-account values
                are shown until the server responds with a verified payload.
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void refreshAll()}
                className="mt-4"
              >
                Retry loading
              </Button>
            </div>
          </Alert>
        )}

        {loadingOverview && !overview ? (
          <Card title="Loading live account state" className="mt-4">
            <LoadingSpinner text="Verifying connections, automation, and execution health…" />
          </Card>
        ) : overview ? (
          <>
            {/* §38 (2) — account summary per connection */}
            <section className="live-section" aria-labelledby="live-summary-title">
              <div className="live-section__heading">
                <div>
                  <p className="terminal-foundation__eyebrow">Synchronized financials</p>
                  <h2 id="live-summary-title">Account Summary</h2>
                  <p className="muted">
                    Broker-reported balances per connection, rendered exactly as decimal strings.
                    The browser never computes equity or margin values.
                  </p>
                </div>
              </div>
              {connections.length === 0 ? (
                <Card className="cockpit-panel">
                  <p className="muted">
                    No broker connections yet. Connect a broker to synchronize account financials.
                  </p>
                  <Link href="/onboarding/broker" className="cockpit-text-link">
                    Manage broker connections
                  </Link>
                </Card>
              ) : (
                <div className="live-connections-grid">
                  {connections.map((connection) => (
                    <AccountSummaryCard key={connection.id} connection={connection} />
                  ))}
                </div>
              )}
            </section>

            {/* §38 (3) — broker connection status per connection */}
            <section className="live-section" aria-labelledby="live-connections-title">
              <div className="live-section__heading">
                <div>
                  <p className="terminal-foundation__eyebrow">Connection gates</p>
                  <h2 id="live-connections-title">Broker Connections</h2>
                  <p className="muted">
                    Connection, authorization, and credential state with the fail-closed execution
                    gate — only the server can report execution as enabled.
                  </p>
                </div>
              </div>
              {connections.length === 0 ? (
                <Card className="cockpit-panel">
                  <p className="muted">No broker connections to report.</p>
                </Card>
              ) : (
                <div className="live-connections-grid">
                  {connections.map((connection) => (
                    <ConnectionStatusCard key={connection.id} connection={connection} />
                  ))}
                </div>
              )}
            </section>

            {/* §38 (4) — automation status */}
            {automation && (
              <section className="live-section" aria-labelledby="live-automation-title">
                <div className="live-section__heading">
                  <div>
                    <p className="terminal-foundation__eyebrow">Automation control</p>
                    <h2 id="live-automation-title">Automation Status</h2>
                    <p className="muted">
                      Session lifecycle and kill-switch state as governed by the server-side
                      execution control plane.
                    </p>
                  </div>
                </div>
                <AutomationCard automation={automation} sessionBrokerName={sessionBrokerName} />
              </section>
            )}

            {/* §38 (5) — execution health tiles */}
            <section className="live-section" aria-labelledby="live-health-title">
              <div className="live-section__heading">
                <div>
                  <p className="terminal-foundation__eyebrow">Execution pipeline</p>
                  <h2 id="live-health-title">Execution Health</h2>
                  <p className="muted">
                    Read-model counters from the execution engine and reconciliation runs over the
                    last 24 hours.
                  </p>
                </div>
              </div>
              <ExecutionHealthTiles health={overview.executionHealth} />
            </section>
          </>
        ) : null}

        {/* §38 (6) — open positions (independent of overview success) */}
        <section className="live-section" aria-labelledby="live-positions-title">
          <div className="live-section__heading">
            <div>
              <p className="terminal-foundation__eyebrow">Exposure</p>
              <h2 id="live-positions-title">Open Positions ({positionsTotal})</h2>
              <p className="muted">
                Open trades with connection context. Reconciliation-pending rows stay flagged until
                the provider diff resolves them.
              </p>
            </div>
          </div>
          {positionsError && (
            <Alert variant="error">
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, marginBottom: 'var(--space-1)' }}>
                  {positionsError}
                </div>
                <Button type="button" variant="secondary" onClick={() => void refreshPositions()}>
                  Retry positions
                </Button>
              </div>
            </Alert>
          )}
          {loadingPositions && !positions ? (
            <Card className="cockpit-panel">
              <LoadingSpinner text="Loading open positions…" />
            </Card>
          ) : positions ? (
            positions.length === 0 ? (
              <Card className="cockpit-panel">
                <p className="muted">No open positions for this account.</p>
              </Card>
            ) : (
              <div className="live-records-grid">
                {positions.map((position) => (
                  <PositionRecord key={position.id} position={position} />
                ))}
              </div>
            )
          ) : null}
        </section>

        {/* §38 (7) — orders with WORKING/HISTORY/ALL filter + offset pagination */}
        <section className="live-section" aria-labelledby="live-orders-title">
          <div className="live-section__heading">
            <div>
              <p className="terminal-foundation__eyebrow">Order lifecycle</p>
              <h2 id="live-orders-title">Orders</h2>
              <p className="muted">
                Normalized order rows from the order domain — working state, terminal history, or
                the full ledger.
              </p>
            </div>
          </div>
          <div className="live-filter-group" role="group" aria-label="Order status filter">
            {ORDER_FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={ordersFilter === filter}
                onClick={() => handleOrdersFilterChange(filter)}
              >
                {formatEnumLabel(filter)}
              </button>
            ))}
          </div>
          {ordersError && <Alert variant="error">{ordersError}</Alert>}
          {loadingOrders ? (
            <Card className="cockpit-panel">
              <LoadingSpinner text="Loading orders…" />
            </Card>
          ) : orders.length === 0 && !ordersError ? (
            <Card className="cockpit-panel">
              <p className="muted">{ordersEmptyCopy}</p>
            </Card>
          ) : (
            <div className="live-records-grid">
              {orders.map((order) => (
                <OrderRecord key={order.id} order={order} />
              ))}
            </div>
          )}
          {!loadingOrders && ordersTotal > 0 && (
            <p className="live-list-count">
              Showing {orders.length} of {ordersTotal} orders
            </p>
          )}
          {!loadingOrders && orders.length < ordersTotal && (
            <div className="live-load-more">
              <Button
                type="button"
                variant="secondary"
                loading={loadingMoreOrders}
                disabled={loadingMoreOrders}
                onClick={handleLoadMoreOrders}
              >
                {loadingMoreOrders ? 'Loading more…' : 'Load more orders'}
              </Button>
            </div>
          )}
        </section>

        {overview && (
          <>
            {/* §38 (8) — reconciliation status per connection */}
            <section className="live-section" aria-labelledby="live-reconciliation-title">
              <div className="live-section__heading">
                <div>
                  <p className="terminal-foundation__eyebrow">Provider truth diff</p>
                  <h2 id="live-reconciliation-title">Reconciliation Status</h2>
                  <p className="muted">
                    Internal state compared against provider truth on every run. Open
                    discrepancies stay visible until resolved — never hidden.
                  </p>
                </div>
              </div>
              {overview.reconciliationLoaded === false ? (
                <Card className="cockpit-panel">
                  <p className="muted">
                    Reconciliation status unavailable — the reconciliation state could not be
                    loaded, so discrepancy counts are hidden rather than shown as zero.
                  </p>
                </Card>
              ) : connections.length === 0 ? (
                <Card className="cockpit-panel">
                  <p className="muted">No broker connections to reconcile.</p>
                </Card>
              ) : (
                <div className="live-reconciliation-grid">
                  {connections.map((connection) => (
                    <ReconciliationCard key={connection.id} connection={connection} />
                  ))}
                </div>
              )}
            </section>

            {/* §38 (9) + (10) — alerts and the activity timeline side by side */}
            <section className="live-section" aria-label="Alerts and recent activity">
              <div className="live-duo-grid">
                <AlertsCard alerts={overview.alerts} />
                {activityTimelineCard}
              </div>
            </section>
          </>
        )}

        {!overview && (
          /* Activity still renders on overview failure — partial-failure design. */
          <section className="live-section" aria-label="Recent activity">
            {activityTimelineCard}
          </section>
        )}

        <aside className="terminal-foundation__policy" aria-label="Live account data integrity policy">
          <strong>Backend-authoritative live account state</strong>
          <p>
            This dashboard renders server-computed read models only: environment, balances,
            connection gates, automation, execution health, reconciliation, alerts, and audit
            activity. The browser never derives the account environment, execution permission,
            financial values, or reconciliation state, and no credential material is ever exposed
            to this page.
          </p>
        </aside>
      </main>
    </DashboardShell>
  );
}
