'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { loadCounterMirrorReport, type CounterMirrorReportView } from '@/lib/ai-counter-mirror';

function usd(n: number | null): string {
  return n === null || !Number.isFinite(n)
    ? 'Not measured'
    : (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
}
function when(x: string | null | undefined): string {
  if (!x || !Number.isFinite(Date.parse(x))) return 'Not available';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Accra',
    day: '2-digit',month: '2-digit',year: 'numeric',
    hour: '2-digit',minute: '2-digit',
  }).format(new Date(x));
}
function outcomeBadge(n: number | null): 'success'|'warning'|'error' {
  return n === null ? 'warning' : n >= 0 ? 'success' : 'error';
}

export default function CounterMirrorPage() {
  const { user, logout, restoring } = useAuth();
  const [report, setReport] = useState<CounterMirrorReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReport(await loadCounterMirrorReport());
      setError(null);
    } catch {
      setError('The private counter experiment report is not available.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!user) return;
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [user, load]);

  if (restoring) return <div style={{ padding: '3rem' }}>
    <LoadingSpinner text="Restoring account…" />
  </div>;
  if (!user) return <div style={{ padding: '3rem', maxWidth: 620 }}>
    <Card title="Sign in required">
      <p>Your counter-direction experiments are private.</p>
      <Link href="/login" className="btn btn--primary mt-4">Sign in</Link>
    </Card>
  </div>;
  return <DashboardShell user={user} onLogout={logout}
    title="MAIN vs COUNTER Research Monitor" activeRoute="/ai">
    <main className="terminal-foundation">
      <section className="terminal-foundation__hero">
        <div>
          <p className="terminal-foundation__eyebrow">Paired trading experiment</p>
          <h1 className="terminal-foundation__title">MAIN vs COUNTER</h1>
          <p className="terminal-foundation__description">
            Actual Pepperstone demo entries compared with virtual opposite-direction
            positions. Every counter is paired to its main trade.
          </p>
          <p className="text-sm muted mt-2">
            Report {when(report?.generatedAt)} · observer refreshes every 2 minutes
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <Link href="/trade" prefetch={false} className="btn btn--secondary">AI Trader</Link>
          <Link href="/ai/bidirectional" className="btn btn--secondary">BUY / SELL analysis</Link>
          <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </section>
      <Alert variant="warning">
        <strong>COUNTER is a virtual experiment, not a broker order.</strong> Its
        estimated P&amp;L includes a minute-level spread proxy and commission.
        It is not a guaranteed execution result.
      </Alert>
      {report?.stale ? <Alert variant="warning">
        Research data is older than five minutes. Open marks may be stale.
      </Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      {loading && !report ? <Card title="Loading paired trades" className="mt-4">
        <LoadingSpinner text="Retrieving owner-scoped report…" />
      </Card> : null}
      {report ? <>
        <section className="mt-4" aria-label="MAIN vs COUNTER daily comparison">
          <Card title="Daily scoreboard"
            subtitle="Actual broker net vs same-horizon virtual counter net, after estimated costs">
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              {report.daily.map(d => <article key={d.day}
                style={{ border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)', padding: 'var(--space-3)' }}>
                <strong>{d.day.split('-').reverse().join('/')}</strong>
                <div style={{ display: 'grid', gap: 'var(--space-3)',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(min(160px,100%),1fr))',
                  marginTop: 'var(--space-3)' }}>
                  <div>
                    <Badge variant="info">MAIN · ACTUAL</Badge>
                    <strong style={{ display: 'block', fontSize: '1.45rem', marginTop: 8 }}>
                      {usd(d.mainNetUsd)}
                    </strong>
                    <p className="text-sm muted">
                      {d.mainClosed} trades, {d.mainWins} wins, {d.mainLosses} losses
                    </p>
                  </div>
                  <div>
                    <Badge variant="warning">COUNTER · VIRTUAL</Badge>
                    <strong style={{ display: 'block', fontSize: '1.45rem', marginTop: 8 }}>
                      {usd(d.counterEstimatedNetUsd)}
                    </strong>
                    <p className="text-sm muted">
                      {d.counterComparable} comparable, {d.counterWins} virtual wins
                    </p>
                  </div>
                  <div>
                    <Badge variant={outcomeBadge(d.pairedEstimatedNetUsd)}>
                      Combined estimate
                    </Badge>
                    <strong style={{ display: 'block', fontSize: '1.45rem', marginTop: 8 }}>
                      {usd(d.pairedEstimatedNetUsd)}
                    </strong>
                    <p className="text-sm muted">Comparable pairs only</p>
                  </div>
                </div>
              </article>)}
            </div>
          </Card>
        </section>
        <section className="mt-4">
          <Card title="Trade-by-trade paired positions"
            subtitle="MAIN is broker executed; COUNTER is research only">
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              {report.pairs.map(p => <article key={p.pairId}
                style={{ border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)', padding: 'var(--space-3)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between',
                  flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <strong>{p.instrument} · {p.main.lotSize ?? '—'} lots</strong>
                  <span className="text-sm muted">Opened {when(p.openedAt)}</span>
                </div>
                <div style={{ display: 'grid', gap: 'var(--space-3)',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(min(210px,100%),1fr))',
                  marginTop: 'var(--space-3)' }}>
                  <div style={{ border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)', padding: 'var(--space-3)' }}>
                    <Badge variant="info">MAIN · ACTUAL</Badge>
                    <p className="mt-2"><strong>{p.main.direction}</strong> · {p.main.state}</p>
                    <strong style={{ fontSize: '1.25rem' }}>
                      {usd(p.main.netUsd ?? p.main.openMarkEstimateNetUsd)}
                    </strong>
                    <p className="text-sm muted mt-1">
                      {p.main.netUsd === null ? 'Open mark estimate' : 'Realized after-cost P&L'}
                    </p>
                  </div>
                  <div style={{ border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)', padding: 'var(--space-3)' }}>
                    <Badge variant="warning">COUNTER · VIRTUAL</Badge>
                    <p className="mt-2"><strong>{p.counter.direction}</strong> ·
                      {' '}{p.counter.state.replaceAll('_', ' ')}</p>
                    <strong style={{ fontSize: '1.25rem' }}>
                      {usd(p.counter.matchedHorizonEstimateUsd ??
                        p.counter.openMarkEstimateNetUsd)}
                    </strong>
                    <p className="text-sm muted mt-1">
                      Mirrored SL/TP: {p.counter.barrierOutcome.replaceAll('_', ' ')}
                      {p.counter.mirroredBarrierEstimateUsd !== null
                        ? ' · ' + usd(p.counter.mirroredBarrierEstimateUsd) : ''}
                    </p>
                  </div>
                </div>
              </article>)}
            </div>
          </Card>
        </section>
      </> : null}
    </main>
  </DashboardShell>;
}
