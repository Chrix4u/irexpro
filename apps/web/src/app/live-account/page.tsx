'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  LiveAccountActivityPage,
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LivePositionRowView,
} from '@irexpro/types/live-account';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { useNotification } from '@/hooks/useNotification';
import { mapApiError } from '@/lib/error-mapping';
import {
  loadLiveAccountActivity,
  loadLiveAccountOrders,
  loadLiveAccountOverview,
  loadLiveAccountPositions,
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

function money(value: string | null | undefined, currency: string | null | undefined): string {
  if (!value) return '—';
  return currency ? `${value} ${currency}` : value;
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
          <span>{position.direction} · {position.lotSize} lot</span>
        </div>
        <Badge variant={pnlVariant(position.unrealisedPnl)}>
          {position.unrealisedPnl === null
            ? 'P&L unavailable'
            : `${position.unrealisedPnl.startsWith('-') ? '' : '+'}${money(position.unrealisedPnl, position.accountCurrency)}`}
        </Badge>
      </div>
      <div className="activity-position__prices">
        <div><span>Entry</span><strong>{position.fillPrice ?? position.requestedEntryPrice}</strong></div>
        <div><span>Current</span><strong>{position.currentPrice ?? '—'}</strong></div>
        <div><span>Stop loss</span><strong>{position.stopLoss}</strong></div>
        <div><span>Take profit</span><strong>{position.takeProfit}</strong></div>
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

  const primaryConnection = overview?.connections[0] ?? null;
  const financial = primaryConnection?.financial ?? null;
  const activePositions = positions?.positions ?? [];
  const recentOrders = orders?.orders ?? [];
  const recentActivity = activity?.activity ?? [];

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
                        <span>{order.direction} · {order.requestedQuantity}</span>
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
              <Card title="AI Activity" subtitle="Recent account events generated by the server-side trading workflow.">
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
                  <div><span>Filled · 24h</span><strong>{overview?.executionHealth.filledLast24h ?? 0}</strong></div>
                  <div><span>Rejected · 24h</span><strong>{overview?.executionHealth.rejectedLast24h ?? 0}</strong></div>
                </div>
              </Card>
            </section>
          </>
        )}
      </main>
    </DashboardShell>
  );
}
