'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  LiveAccountActivityPage,
  LiveAccountConnectionView,
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LivePositionRowView,
} from '@irexpro/types/live-account';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { ConfirmDialog } from '@/components/notifications/ConfirmDialog';
import { useAuth } from '@/context/auth-context';
import { useNotification } from '@/hooks/useNotification';
import { mapApiError } from '@/lib/error-mapping';
import {
  describeEmergencyStopSummary,
  emergencyStopActiveTradingSession,
  loadLiveAccountActivity,
  loadLiveAccountOrders,
  loadLiveAccountOverview,
  loadLiveAccountPositions,
  reconciliationBlockView,
} from '@/lib/live-account';
import './trading-activity.css';

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatFixedDecimal(
  value: string | null | undefined,
  fractionDigits = 2,
): string {
  if (!value) return '—';

  const normalized = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return normalized;

  const negative = match[1] === '-';
  const integerPart = match[2];
  const fractionalPart = match[3] ?? '';
  const scale = 10n ** BigInt(fractionDigits);
  const paddedFraction = fractionalPart.padEnd(fractionDigits + 1, '0');
  const keptFraction = paddedFraction.slice(0, fractionDigits) || '0';

  let scaled =
    BigInt(integerPart) * scale +
    (fractionDigits > 0 ? BigInt(keptFraction) : 0n);

  const roundDigit = paddedFraction[fractionDigits] ?? '0';
  if (roundDigit >= '5') scaled += 1n;

  const whole = scaled / scale;
  const fraction = fractionDigits > 0
    ? (scaled % scale).toString().padStart(fractionDigits, '0')
    : '';
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative && scaled !== 0n ? '-' : '';

  return fractionDigits > 0
    ? `${sign}${groupedWhole}.${fraction}`
    : `${sign}${groupedWhole}`;
}

function money(value: string | null | undefined, currency: string | null | undefined): string {
  const formatted = formatFixedDecimal(value, 2);
  if (formatted === '—') return formatted;
  return currency ? `${formatted} ${currency}` : formatted;
}

function pnlVariant(value: string | null): 'success' | 'error' | 'info' {
  if (!value || value === '0' || /^0(?:\.0+)?$/.test(value)) return 'info';
  return value.startsWith('-') ? 'error' : 'success';
}

function PositionTile({ position }: { position: LivePositionRowView }) {
  return (
    <article className="activity-position">
      <div className="activity-position__top">
        <div>
          <strong>{position.instrument}</strong>
          <span>{position.direction} · {formatFixedDecimal(position.lotSize, 2)} lot</span>
        </div>
        <Badge variant={pnlVariant(position.unrealisedPnl)}>
          {position.unrealisedPnl === null
            ? 'P&L unavailable'
            : `${position.unrealisedPnl.startsWith('-') ? '' : '+'}${money(position.unrealisedPnl, position.accountCurrency)}`}
        </Badge>
      </div>
      <div className="activity-position__prices">
        <div><span>Entry</span><strong>{formatFixedDecimal(position.fillPrice ?? position.requestedEntryPrice, 5)}</strong></div>
        <div><span>Current</span><strong>{formatFixedDecimal(position.currentPrice, 5)}</strong></div>
        <div><span>Stop loss</span><strong>{formatFixedDecimal(position.stopLoss, 5)}</strong></div>
        <div><span>Take profit</span><strong>{formatFixedDecimal(position.takeProfit, 5)}</strong></div>
      </div>
      <div className="activity-position__foot">
        <span>{position.brokerName ?? 'Broker'}</span>
        <span>{formatTimestamp(position.openedAt ?? position.createdAt)}</span>
      </div>
    </article>
  );
}

export default function TradingActivityPage() {
  const { user, logout, restoring } = useAuth();
  const notify = useNotification();
  const [overview, setOverview] = useState<LiveAccountOverviewView | null>(null);
  const [positions, setPositions] = useState<LiveAccountPositionsView | null>(null);
  const [orders, setOrders] = useState<LiveAccountOrdersPage | null>(null);
  const [activity, setActivity] = useState<LiveAccountActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emergencyStopOpen, setEmergencyStopOpen] = useState(false);
  const [emergencyStopping, setEmergencyStopping] = useState(false);

  const refresh = useCallback(async (initial = false) => {
    if (!user) return;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [nextOverview, nextPositions, nextOrders, nextActivity] = await Promise.all([
        loadLiveAccountOverview(),
        loadLiveAccountPositions(),
        loadLiveAccountOrders('ALL', 16, 0),
        loadLiveAccountActivity(16, 0),
      ]);
      setOverview(nextOverview);
      setPositions(nextPositions);
      setOrders(nextOrders);
      setActivity(nextActivity);
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      if (!initial) notify.error(message);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }, [user, notify]);

  useEffect(() => {
    if (!user) return;
    void refresh(true);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void refresh(false), 12000);
    return () => window.clearInterval(timer);
  }, [user, refresh]);

  // Emergency stop uses the SAME stop-with-close-positions endpoint as the
  // trade workspace stop dialog (see lib/live-account.ts). Defined after
  // `refresh` so the callback can re-read the dashboard afterwards.
  const handleEmergencyStop = useCallback(async () => {
    setEmergencyStopping(true);
    try {
      const outcome = await emergencyStopActiveTradingSession();
      if (outcome.outcome === 'NO_ACTIVE_SESSION') {
        notify.info('AI Trading is already stopped.');
      } else {
        const summary = describeEmergencyStopSummary(outcome.result);
        if (summary.tone === 'success') {
          notify.success(summary.message);
        } else {
          notify.warning(summary.message);
        }
      }
      setEmergencyStopOpen(false);
      await refresh(false);
    } catch (stopError) {
      const message = mapApiError(stopError).message;
      setError(message);
      notify.error(message);
    } finally {
      setEmergencyStopping(false);
    }
  }, [notify, refresh]);

  const primaryConnection = overview?.connections[0] ?? null;
  const financial = primaryConnection?.financial ?? null;
  const activePositions = positions?.positions ?? [];
  const recentOrders = orders?.orders ?? [];
  const recentActivity = activity?.activity ?? [];

  // Emergency stop targets whatever session the server reports as active. The
  // overview automation summary (refreshed on every poll) says whether there is
  // anything to stop; the actual stop re-reads the authoritative active session
  // server-side (see emergencyStopActiveTradingSession).
  const automationStoppable =
    overview?.automation.status === 'ACTIVE' || overview?.automation.status === 'PAUSED';

  const environment = useMemo(() => overview?.environment ?? 'UNKNOWN', [overview]);

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring trading activity…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '680px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to view positions and trading activity.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/live-account" title="Positions & Activity">
      <main className="trading-activity" data-testid="trading-activity">
        <section className="trading-activity__hero">
          <div>
            <p className="workspace-hero__eyebrow">Your AI trading activity</p>
            <h1>Positions &amp; Activity</h1>
            <p>
              Follow the account, open positions, order lifecycle and AI activity in one place.
              Financial values are shown only when returned by the broker or execution engine.
            </p>
          </div>
          <div className="trading-activity__hero-actions">
            <Badge variant={environment === 'LIVE' ? 'warning' : 'info'}>{environment}</Badge>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={refreshing}
              onClick={() => void refresh(false)}
            >
              Refresh
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              aria-label="Emergency stop AI Trading"
              title={
                automationStoppable
                  ? 'Stop AI Trading and close AI-opened positions'
                  : 'AI Trading is not running — nothing to stop'
              }
              disabled={!overview || !automationStoppable || emergencyStopping}
              onClick={() => setEmergencyStopOpen(true)}
            >
              Emergency stop
            </Button>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

        {loading && !overview ? (
          <Card title="Loading trading activity">
            <LoadingSpinner text="Loading broker account, positions and orders…" />
          </Card>
        ) : (
          <>
            <section className="activity-summary-grid" aria-label="Account and AI summary">
              <Card>
                <span className="activity-summary__label">Broker account</span>
                <strong className="activity-summary__value">
                  {primaryConnection?.displayName || primaryConnection?.brokerName || 'Not connected'}
                </strong>
                <span className="activity-summary__meta">
                  {primaryConnection
                    ? `${primaryConnection.connectionStatus} · ${primaryConnection.accountType}`
                    : 'Connect a broker to begin'}
                </span>
              </Card>
              <Card>
                <span className="activity-summary__label">Balance</span>
                <strong className="activity-summary__value">
                  {money(financial?.balance, financial?.currency)}
                </strong>
                <span className="activity-summary__meta">Broker-reported balance</span>
              </Card>
              <Card>
                <span className="activity-summary__label">Equity</span>
                <strong className="activity-summary__value">
                  {money(financial?.equity, financial?.currency)}
                </strong>
                <span className="activity-summary__meta">
                  {financial?.syncedAt ? `Synced ${formatTimestamp(financial.syncedAt)}` : 'Awaiting broker sync'}
                </span>
              </Card>
              <Card>
                <span className="activity-summary__label">Margin</span>
                <strong className="activity-summary__value">
                  {money(financial?.margin, financial?.currency)}
                </strong>
                <span className="activity-summary__meta">Broker-reported margin in use</span>
              </Card>
              <Card>
                <span className="activity-summary__label">Free margin</span>
                <strong className="activity-summary__value">
                  {money(financial?.freeMargin, financial?.currency)}
                </strong>
                <span className="activity-summary__meta">Margin available for new positions</span>
              </Card>
              <Card>
                <span className="activity-summary__label">Margin level</span>
                <strong className="activity-summary__value">
                  {financial?.marginLevel === null || financial?.marginLevel === undefined
                    ? '—'
                    : `${formatFixedDecimal(financial.marginLevel, 2)}%`}
                </strong>
                <span className="activity-summary__meta">
                  Equity-to-margin ratio — blank when no margin is in use
                </span>
              </Card>
              <Card>
                <span className="activity-summary__label">AI Trading</span>
                <strong className="activity-summary__value">
                  {overview?.automation.status ?? 'IDLE'}
                </strong>
                <span className="activity-summary__meta">
                  {overview?.automation.startedAt
                    ? `Started ${formatTimestamp(overview.automation.startedAt)}`
                    : 'Start or stop AI Trading from the AI Trading workspace'}
                </span>
                <Link href="/trade" className="activity-link mt-4">Open AI Trading</Link>
              </Card>
            </section>

            {overview?.alerts.length ? (
              <section className="activity-alert-strip" aria-label="Account alerts">
                {overview.alerts.slice(0, 3).map((item) => (
                  <Alert
                    key={item.key}
                    variant={
                      item.severity === 'CRITICAL'
                        ? 'error'
                        : item.severity === 'WARNING'
                          ? 'warning'
                          : 'info'
                    }
                  >
                    {item.message}
                  </Alert>
                ))}
              </section>
            ) : null}

            <section className="activity-section" aria-labelledby="reconciliation-title">
              <div className="activity-section__head">
                <div>
                  <p className="workspace-hero__eyebrow">Server-side truth</p>
                  <h2 id="reconciliation-title">Reconciliation</h2>
                </div>
              </div>
              <div className="activity-list">
                {overview?.connections.length ? (
                  overview.connections.map((connection: LiveAccountConnectionView) => {
                    const recon = reconciliationBlockView(
                      connection,
                      overview.reconciliationLoaded,
                    );
                    return (
                      <article
                        className="activity-row"
                        key={connection.id}
                        data-testid={`reconciliation-${connection.id}`}
                      >
                        <div>
                          <strong>{connection.displayName || connection.brokerName}</strong>
                          <span>
                            Last run status: {recon.statusLabel} ·{' '}
                            {recon.lastRunAt
                              ? `Last run ${formatTimestamp(recon.lastRunAt)}`
                              : 'Never run'}
                          </span>
                          <span>{recon.discrepancyLabel}</span>
                        </div>
                        <div>
                          <Badge variant={recon.statusVariant}>{recon.statusLabel}</Badge>
                          <Badge
                            variant={
                              recon.unavailable ? 'info' : recon.inSync ? 'success' : 'error'
                            }
                          >
                            {recon.unavailable
                              ? 'Reconciliation status unavailable'
                              : recon.inSync
                                ? 'In sync'
                                : 'Discrepancies open'}
                          </Badge>
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <Card className="activity-empty">
                    <strong>No broker connections</strong>
                    <p className="muted">
                      Reconciliation state appears once a broker is connected.
                    </p>
                  </Card>
                )}
              </div>
            </section>

            <section className="activity-main-grid">
              <section className="activity-section activity-section--positions" aria-labelledby="positions-title">
                <div className="activity-section__head">
                  <div>
                    <p className="workspace-hero__eyebrow">Current exposure</p>
                    <h2 id="positions-title">Open Positions</h2>
                  </div>
                  <Badge variant={activePositions.length ? 'success' : 'info'}>
                    {activePositions.length} open
                  </Badge>
                </div>
                {activePositions.length === 0 ? (
                  <Card className="activity-empty">
                    <strong>No open positions</strong>
                    <p className="muted">New AI positions will appear here with live broker P&amp;L when available.</p>
                  </Card>
                ) : (
                  <div className="activity-position-grid">
                    {activePositions.map((position) => (
                      <PositionTile key={position.id} position={position} />
                    ))}
                  </div>
                )}
              </section>

              <section className="activity-section activity-section--orders" aria-labelledby="orders-title">
                <div className="activity-section__head">
                  <div>
                    <p className="workspace-hero__eyebrow">Order lifecycle</p>
                    <h2 id="orders-title">Recent Orders</h2>
                  </div>
                  <Badge variant="info">{orders?.total ?? 0}</Badge>
                </div>
                <div className="activity-list">
                  {recentOrders.length === 0 ? (
                    <Card className="activity-empty">
                      <strong>No orders yet</strong>
                      <p className="muted">AI order submissions and fills will appear here.</p>
                    </Card>
                  ) : recentOrders.map((order) => (
                    <article className="activity-row" key={order.id}>
                      <div>
                        <strong>{order.instrument}</strong>
                        <span>{order.direction} · {formatFixedDecimal(order.requestedQuantity, 2)}</span>
                      </div>
                      <Badge
                        variant={
                          order.status === 'FILLED'
                            ? 'success'
                            : order.status === 'REJECTED' || order.status === 'CANCELLED'
                              ? 'error'
                              : 'warning'
                        }
                      >
                        {order.status.replaceAll('_', ' ')}
                      </Badge>
                      <time>{formatTimestamp(order.finalizedAt ?? order.submittedAt ?? order.createdAt)}</time>
                    </article>
                  ))}
                </div>
              </section>
            </section>

            <section className="activity-bottom-grid">
              <Card
                className="activity-ai-card"
                title="AI Activity"
                subtitle="Recent account events generated by the server-side trading workflow."
              >
                <div className="activity-timeline">
                  {recentActivity.length === 0 ? (
                    <p className="muted">No recent activity yet.</p>
                  ) : recentActivity.map((item) => (
                    <div className="activity-timeline__item" key={item.id}>
                      <span className={`activity-dot activity-dot--${item.severity.toLowerCase()}`} />
                      <div>
                        <strong>{item.action.replaceAll('_', ' ')}</strong>
                        <span>{formatTimestamp(item.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Execution Health" subtitle="A simple health view of the AI execution pipeline.">
                <div className="activity-health-grid">
                  <div><span>Open positions</span><strong>{overview?.executionHealth.openPositions ?? 0}</strong></div>
                  <div><span>Working orders</span><strong>{overview?.executionHealth.workingOrders ?? 0}</strong></div>
                  <div>
                    <span>Recon pending</span>
                    <strong>{overview?.executionHealth.reconciliationPending ?? 0}</strong>
                  </div>
                  <div><span>Filled · 24h</span><strong>{overview?.executionHealth.filledLast24h ?? 0}</strong></div>
                  <div><span>Rejected · 24h</span><strong>{overview?.executionHealth.rejectedLast24h ?? 0}</strong></div>
                </div>
              </Card>
            </section>
          </>
        )}

        <ConfirmDialog
          open={emergencyStopOpen}
          title="Emergency stop AI Trading?"
          description={
            'Confirming will stop new AI trading first, then immediately request closure of every currently open position that iRexPro can prove was opened by the AI. ' +
            'Broker market conditions determine the actual exit price. If a broker cannot immediately prove a closure, iRexPro will report it as unresolved/reconciliation pending instead of pretending it is closed.'
          }
          confirmLabel={emergencyStopping ? 'Stopping…' : 'Stop & Close AI Positions'}
          cancelLabel="Keep AI Trading Running"
          tone="danger"
          onConfirm={() => void handleEmergencyStop()}
          onCancel={() => {
            if (!emergencyStopping) setEmergencyStopOpen(false);
          }}
        />
      </main>
    </DashboardShell>
  );
}
