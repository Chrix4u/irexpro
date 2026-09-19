'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatEnumLabel } from '@irexpro/types';
import type { RiskIntelligenceView } from '@irexpro/types/risk-intelligence';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { loadTraderRiskIntelligence } from '@/lib/trader-risk-intelligence';

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export default function PortfolioRiskPage() {
  const { user, logout, restoring } = useAuth();
  const [snapshot, setSnapshot] = useState<RiskIntelligenceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await loadTraderRiskIntelligence());
    } catch {
      setSnapshot(null);
      setError(
        'Unable to load the authoritative portfolio and risk snapshot. Previously loaded state has been cleared.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
  }, [user, refresh]);

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
          <p className="muted">You need to log in to access portfolio and risk intelligence.</p>
          <Link href="/login" className="btn btn--primary mt-4">
            Go to login
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/portfolio" title="Portfolio & Risk">
      <main className="terminal-foundation">
        <section className="terminal-foundation__hero" aria-labelledby="portfolio-risk-title">
          <div>
            <p className="terminal-foundation__eyebrow">Capital governance</p>
            <h1 id="portfolio-risk-title" className="terminal-foundation__title">
              Portfolio & Risk Intelligence
            </h1>
            <p className="terminal-foundation__description">
              Server-authoritative risk policy, execution capacity, portfolio freshness, and recent risk vetoes. Raw risk context and derived financial performance remain outside this browser contract.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={loading}
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? 'Refreshing…' : 'Refresh intelligence'}
          </Button>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

        {loading && !snapshot ? (
          <Card title="Loading risk intelligence" className="mt-4">
            <LoadingSpinner text="Checking policy, capacity, portfolio freshness, and risk vetoes…" />
          </Card>
        ) : snapshot ? (
          <>
            <section
              className="mt-4"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              <Card title="Risk Engine">
                <div className="workspace-kv-list">
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Kill switch</span>
                    <Badge variant={snapshot.engine.killSwitchActive ? 'error' : 'success'}>
                      {snapshot.engine.killSwitchActive ? 'Active' : 'Clear'}
                    </Badge>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Broker gate</span>
                    <Badge variant={snapshot.engine.brokerConnected ? 'success' : 'warning'}>
                      {snapshot.engine.brokerConnected ? 'Connected' : 'Unavailable'}
                    </Badge>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Risk acknowledgement</span>
                    <Badge
                      variant={snapshot.policy.riskAcknowledgementAccepted ? 'success' : 'warning'}
                    >
                      {snapshot.policy.riskAcknowledgementAccepted ? 'Accepted' : 'Required'}
                    </Badge>
                  </div>
                </div>
              </Card>

              <Card title="Execution Capacity">
                <dl className="workspace-kv-list">
                  <div className="workspace-kv-row">
                    <dt className="text-sm muted">Open positions</dt>
                    <dd>
                      {snapshot.execution.openPositions} / {snapshot.execution.maxOpenPositions}
                    </dd>
                  </div>
                  <div className="workspace-kv-row">
                    <dt className="text-sm muted">Open-position slots remaining</dt>
                    <dd>{snapshot.execution.openPositionSlotsRemaining}</dd>
                  </div>
                  <div className="workspace-kv-row">
                    <dt className="text-sm muted">Trades opened today</dt>
                    <dd>
                      {snapshot.execution.todayTrades} / {snapshot.execution.maxDailyTrades}
                    </dd>
                  </div>
                  <div className="workspace-kv-row">
                    <dt className="text-sm muted">Daily trade slots remaining</dt>
                    <dd>{snapshot.execution.dailyTradeSlotsRemaining}</dd>
                  </div>
                </dl>
              </Card>

              <Card title="Portfolio Freshness">
                <dl style={{ display: 'grid', gap: 'var(--space-3)' }}>
                  <div className="workspace-kv-row">
                    <dt className="text-sm muted">Broker accounts</dt>
                    <dd>{snapshot.portfolio.totalAccounts}</dd>
                  </div>
                  <div className="workspace-kv-row">
                    <dt className="text-sm muted">Connected</dt>
                    <dd>{snapshot.portfolio.connectedAccounts}</dd>
                  </div>
                  <div className="workspace-kv-row">
                    <dt className="text-sm muted">Fresh / stale / unavailable</dt>
                    <dd>
                      {snapshot.portfolio.freshSnapshots} / {snapshot.portfolio.staleSnapshots} /{' '}
                      {snapshot.portfolio.unavailableSnapshots}
                    </dd>
                  </div>
                </dl>
                <Link href="/trade/portfolio" className="btn btn--secondary mt-4">
                  Open Portfolio Truth
                </Link>
              </Card>
            </section>

            <section className="mt-4">
              <Card title="Risk Policy">
                <div className="workspace-kv-list">
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Trading mode</span>
                    <strong>{formatEnumLabel(snapshot.policy.allowedTradingMode)}</strong>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Max daily loss</span>
                    <strong>{snapshot.policy.limits.maxDailyLossPercent}%</strong>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Max drawdown</span>
                    <strong>{snapshot.policy.limits.maxDrawdownPercent}%</strong>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Max risk per trade</span>
                    <strong>{snapshot.policy.limits.maxTradeRiskPercent}%</strong>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Max position size</span>
                    <strong>{snapshot.policy.limits.maxPositionSizeLot} lot</strong>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Min stop-loss distance</span>
                    <strong>{snapshot.policy.limits.minStopLossPips} pips</strong>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Max leverage allowed</span>
                    <strong>{snapshot.policy.limits.maxLeverageAllowed}:1</strong>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="text-sm muted">Instrument policy</span>
                    <strong>
                      {snapshot.policy.limits.allowedInstruments?.length
                        ? snapshot.policy.limits.allowedInstruments.join(', ')
                        : 'All instruments'}
                    </strong>
                  </div>
                </div>
              </Card>
            </section>

            <section className="mt-4">
              <Card title={`Recent Risk Vetoes (${snapshot.recentViolations.length})`}>
                {snapshot.recentViolations.length === 0 ? (
                  <p className="muted">No recent risk vetoes were returned.</p>
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    {snapshot.recentViolations.map((violation) => (
                      <article
                        key={violation.id}
                        style={{
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 'var(--radius-lg)',
                          padding: 'var(--space-4)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 'var(--space-3)',
                            flexWrap: 'wrap',
                          }}
                        >
                          <strong>{formatEnumLabel(violation.rejectionCode)}</strong>
                          <span className="text-sm muted">
                            {formatTimestamp(violation.evaluatedAt)}
                          </span>
                        </div>
                        <p className="mt-2">{violation.rejectionReason}</p>
                      </article>
                    ))}
                  </div>
                )}
                <p className="text-sm muted mt-4">
                  Internal risk context, signal lineage, balances, equity, and proposed order details are intentionally withheld from this browser view.
                </p>
              </Card>
            </section>

            <div className="mt-4">
              <Alert variant="info">
                This workspace reports risk policy and capacity only. It does not calculate exposure, P&amp;L, drawdown usage, or margin utilisation in the browser. Those metrics will be added only after authoritative server-side contracts exist.
              </Alert>
            </div>
          </>
        ) : null}
      </main>
    </DashboardShell>
  );
}
