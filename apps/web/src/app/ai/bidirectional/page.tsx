'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatEnumLabel } from '@irexpro/types';
import { Alert, Badge, Button, Card, DashboardShell, EmptyState, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import {
  BidirectionalComparisonView,
  BidirectionalSideView,
  loadBidirectionalDecisions,
} from '@/lib/ai-bidirectional-decisions';

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not available'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rMultiple(value: number | null): string {
  if (value === null) return 'Not available';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(3)}R`;
}

function selectionVariant(
  status: BidirectionalComparisonView['selectionStatus'],
): 'success' | 'warning' | 'info' {
  if (status === 'BUY_ELIGIBLE' || status === 'SELL_ELIGIBLE') return 'success';
  if (status === 'BOTH_ELIGIBLE') return 'warning';
  return 'info';
}

function sideVariant(side: BidirectionalSideView): 'success' | 'warning' | 'error' | 'info' {
  if (side.paperExecutionEligible) return 'success';
  if ((side.netExpectedR ?? Number.NEGATIVE_INFINITY) >= 0.08) return 'warning';
  if ((side.netExpectedR ?? 0) < 0) return 'error';
  return 'info';
}

function DirectionCard({ side, label }: { side: BidirectionalSideView | null; label: 'BUY' | 'SELL' }) {
  if (!side) {
    return (
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
        <strong>{label}</strong>
        <p className="text-sm muted mt-2">No persisted decision for this side on the bar.</p>
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <strong>{label}</strong>
        <Badge variant={sideVariant(side)}>
          {side.paperExecutionEligible ? 'PAPER ELIGIBLE' : 'BLOCKED'}
        </Badge>
      </div>
      <div
        className="mt-3"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))',
          gap: 'var(--space-3)',
        }}
      >
        <div><span className="text-sm muted">Confidence</span><div>{percent(side.confidence)}</div></div>
        <div><span className="text-sm muted">Meta probability</span><div>{percent(side.metaProbability)}</div></div>
        <div><span className="text-sm muted">Gross edge</span><div>{rMultiple(side.grossExpectedR)}</div></div>
        <div><span className="text-sm muted">Net edge</span><div>{rMultiple(side.netExpectedR)}</div></div>
        <div><span className="text-sm muted">Consensus</span><div>{side.consensusPassed}/{side.consensusRequired}</div></div>
        <div><span className="text-sm muted">Route</span><div>{side.strategyRoute ? formatEnumLabel(side.strategyRoute) : 'Not available'}</div></div>
        <div><span className="text-sm muted">Regime</span><div>{formatEnumLabel(side.regime)}</div></div>
        <div><span className="text-sm muted">Drift</span><div>{side.driftState ? formatEnumLabel(side.driftState) : 'Not available'}</div></div>
      </div>
      <div className="mt-3">
        <span className="text-sm muted">Why this side {side.paperExecutionEligible ? 'passed' : 'stopped'}</span>
        {side.blockers.length === 0 ? (
          <p className="text-sm mt-1" style={{ marginBottom: 0 }}>No PAPER execution blockers recorded.</p>
        ) : (
          <div className="mt-2" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {side.blockers.map((blocker) => (
              <Badge key={blocker} variant="warning">{formatEnumLabel(blocker)}</Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BidirectionalDecisionPage() {
  const { user, logout, restoring } = useAuth();
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof loadBidirectionalDecisions>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await loadBidirectionalDecisions());
    } catch {
      setSnapshot(null);
      setError('Unable to load the persisted BUY versus SELL decision comparison.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
  }, [user, refresh]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [user, refresh]);

  const summary = useMemo(() => {
    const rows = snapshot?.comparisons ?? [];
    return {
      bars: rows.length,
      buy: rows.filter((row) => row.selectionStatus === 'BUY_ELIGIBLE').length,
      sell: rows.filter((row) => row.selectionStatus === 'SELL_ELIGIBLE').length,
      none: rows.filter((row) => row.selectionStatus === 'NO_ELIGIBLE_DIRECTION').length,
    };
  }, [snapshot]);

  if (restoring) return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring session…" /></div>;

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 620, margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Log in to inspect bidirectional decision evidence.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/ai" title="Bidirectional Decision Monitor">
      <main className="terminal-foundation">
        <section className="terminal-foundation__hero" aria-labelledby="bidirectional-title">
          <div>
            <p className="terminal-foundation__eyebrow">Counterfactual market evidence</p>
            <h1 id="bidirectional-title" className="terminal-foundation__title">BUY vs SELL Decision Monitor</h1>
            <p className="terminal-foundation__description">
              See how the active policy scored both directions on the same closed M5 bar. The page shows persisted browser-safe evidence only—no hidden reasoning, account P&amp;L or execution credentials.
            </p>
            <p className="text-sm muted mt-2">
              Policy: {snapshot?.policyVersion ?? 'Not available'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <Link href="/ai" className="btn btn--secondary">Decision Explorer</Link>
            <Button type="button" variant="secondary" size="sm" loading={loading} disabled={loading} onClick={() => void refresh()}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

        {loading && !snapshot ? (
          <Card title="Loading bidirectional evidence" className="mt-4">
            <LoadingSpinner text="Pairing persisted BUY and SELL decisions…" />
          </Card>
        ) : snapshot ? (
          <>
            <section
              className="mt-4"
              aria-label="Bidirectional summary"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 'var(--space-4)' }}
            >
              <Card title="Recent bars"><strong style={{ fontSize: '1.7rem' }}>{summary.bars}</strong></Card>
              <Card title="BUY eligible"><strong style={{ fontSize: '1.7rem' }}>{summary.buy}</strong></Card>
              <Card title="SELL eligible"><strong style={{ fontSize: '1.7rem' }}>{summary.sell}</strong></Card>
              <Card title="Both blocked"><strong style={{ fontSize: '1.7rem' }}>{summary.none}</strong></Card>
            </section>

            <section className="mt-4">
              <Card title="Latest paired decisions" subtitle={`Snapshot generated ${formatTimestamp(snapshot.generatedAt)} · refreshes every 30 seconds`}>
                {snapshot.comparisons.length === 0 ? (
                  <EmptyState icon="⇄" title="No paired decision evidence yet" description="The next persisted bidirectional scan will appear here." />
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
                    {snapshot.comparisons.map((row) => (
                      <article key={`${row.instrument}-${row.marketBarTime}`} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                          <div>
                            <h3 style={{ margin: 0 }}>{row.instrument}</h3>
                            <p className="text-sm muted mt-1">Closed M5 bar {formatTimestamp(row.marketBarTime)}</p>
                          </div>
                          <Badge variant={selectionVariant(row.selectionStatus)}>{formatEnumLabel(row.selectionStatus)}</Badge>
                        </div>
                        <div className="mt-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--space-3)' }}>
                          <DirectionCard side={row.buy} label="BUY" />
                          <DirectionCard side={row.sell} label="SELL" />
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </Card>
            </section>
          </>
        ) : null}
      </main>
    </DashboardShell>
  );
}
