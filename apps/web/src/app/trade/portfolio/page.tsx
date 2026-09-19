'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  PortfolioAccountView,
  PortfolioConnectionStatus,
  PortfolioSnapshotUnavailableReason,
} from '@irexpro/types/portfolio';
import { useAuth } from '@/context/auth-context';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { loadTraderPortfolio } from '@/lib/trader-portfolio';

function connectionBadgeVariant(
  status: PortfolioConnectionStatus,
): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'CONNECTED') return 'success';
  if (status === 'CONNECTING') return 'warning';
  if (status === 'ERROR' || status === 'SUSPENDED') return 'error';
  return 'info';
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function unavailableMessage(reason: PortfolioSnapshotUnavailableReason): string {
  if (reason === 'CURRENCY_UNAVAILABLE') {
    return 'Financial values are withheld because the synchronized account currency is unavailable or invalid.';
  }
  if (reason === 'UNVERIFIED_ZERO_PLACEHOLDER') {
    return 'Financial values are withheld because the stored zero values have not yet been verified by a successful broker balance sync.';
  }
  return 'No verified broker financial snapshot has been synchronized for this account yet.';
}

function AccountPortfolioCard({ account }: { account: PortfolioAccountView }) {
  const snapshot = account.snapshot;

  return (
    <Card title={account.displayName ?? account.brokerName}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-4)',
        }}
      >
        <Badge variant={connectionBadgeVariant(account.connectionStatus)}>
          {account.connectionStatus.replaceAll('_', ' ').toLowerCase()}
        </Badge>
        <Badge variant="info">{account.accountType.toLowerCase()}</Badge>
        {snapshot && (
          <Badge variant={snapshot.freshness === 'FRESH' ? 'success' : 'warning'}>
            {snapshot.freshness === 'FRESH' ? 'Fresh snapshot' : 'Stale snapshot'}
          </Badge>
        )}
      </div>

      <dl style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div>
          <dt className="text-sm muted">Broker</dt>
          <dd>{account.brokerName}</dd>
        </div>
        <div>
          <dt className="text-sm muted">Live-trading flag (compatibility mirror)</dt>
          <dd>
            {account.liveTradingEnabled ? 'Enabled' : 'Not enabled'} — not the authoritative
            trading state; the session execution mode and authorization gates are.
          </dd>
        </div>
      </dl>

      {snapshot ? (
        <div style={{ marginTop: 'var(--space-5)' }}>
          {snapshot.freshness === 'STALE' && (
            <Alert variant="warning">
              This is the last verified broker snapshot, but the server has marked it stale. Do not
              treat it as current account state.
            </Alert>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: 'var(--space-4)',
              marginTop: 'var(--space-4)',
            }}
          >
            <div>
              <p className="text-sm muted" style={{ margin: 0 }}>
                Balance
              </p>
              <p style={{ fontSize: '1.35rem', fontWeight: 700, margin: 'var(--space-1) 0 0' }}>
                {snapshot.currency} {snapshot.balance}
              </p>
            </div>
            <div>
              <p className="text-sm muted" style={{ margin: 0 }}>
                Equity
              </p>
              <p style={{ fontSize: '1.35rem', fontWeight: 700, margin: 'var(--space-1) 0 0' }}>
                {snapshot.currency} {snapshot.equity}
              </p>
            </div>
          </div>

          <dl style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <div>
              <dt className="text-sm muted">Broker snapshot time</dt>
              <dd>{formatTimestamp(snapshot.syncedAt)}</dd>
            </div>
            <div>
              <dt className="text-sm muted">Snapshot age at response time</dt>
              <dd>{snapshot.ageSeconds} seconds</dd>
            </div>
          </dl>
        </div>
      ) : (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <Alert variant="warning">
            {unavailableMessage(account.snapshotUnavailableReason ?? 'NO_SYNC')}
          </Alert>
        </div>
      )}
    </Card>
  );
}

export default function AccountPortfolioPage() {
  const { user, logout, restoring } = useAuth();
  const [accounts, setAccounts] = useState<PortfolioAccountView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshPortfolio = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAccounts(await loadTraderPortfolio());
    } catch {
      // Fail closed: never keep previously loaded monetary values after a failed
      // refresh because account state or currency may have changed meanwhile.
      setAccounts(null);
      setError(
        'Unable to load the authoritative portfolio snapshot. Previously loaded financial values have been cleared.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refreshPortfolio();
  }, [user, refreshPortfolio]);

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
          <p className="muted">You need to log in to access Portfolio Truth.</p>
          <Link href="/login" className="btn btn--primary mt-4">
            Go to login
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell
      user={user}
      onLogout={logout}
      activeRoute="/trade/portfolio"
      title="Portfolio Truth"
    >
      <main className="terminal-foundation">
        <section className="terminal-foundation__hero" aria-labelledby="portfolio-truth-title">
          <div>
            <p className="terminal-foundation__eyebrow">Portfolio Truth</p>
            <h1 id="portfolio-truth-title" className="terminal-foundation__title">
              Account Portfolio
            </h1>
            <p className="terminal-foundation__description">
              Currency-aware balance and equity snapshots from persisted broker synchronization.
              No monetary values are reconstructed from browser state or assumed to be USD.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={loading}
            disabled={loading}
            onClick={() => void refreshPortfolio()}
          >
            {loading ? 'Refreshing…' : 'Refresh portfolio'}
          </Button>
        </section>

        <div style={{ marginTop: 'var(--space-4)' }}>
          <Link href="/trade" className="btn btn--ghost btn--sm">
            Back to Trading Workspace
          </Link>
        </div>

        {error && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        <section aria-labelledby="portfolio-accounts-title" style={{ marginTop: 'var(--space-6)' }}>
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <h2 id="portfolio-accounts-title" style={{ margin: 0 }}>
              Broker Accounts
            </h2>
            <p className="muted" style={{ marginTop: 'var(--space-2)', lineHeight: 1.6 }}>
              Margin, free margin, leverage, position count, and P&amp;L remain hidden until those
              fields have an equally authoritative synchronization path.
            </p>
          </div>

          {loading && !accounts ? (
            <Card title="Loading portfolio">
              <LoadingSpinner text="Loading verified broker account snapshots…" />
            </Card>
          ) : accounts && accounts.length > 0 ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 'var(--space-4)',
              }}
            >
              {accounts.map((account) => (
                <AccountPortfolioCard key={account.connectionId} account={account} />
              ))}
            </div>
          ) : accounts ? (
            <Card title="No broker accounts">
              <p className="muted">
                No broker accounts are available for Portfolio Truth yet. Connect a broker account
                before financial snapshots can be synchronized.
              </p>
              <Link href="/onboarding/broker" className="btn btn--ghost btn--sm mt-4">
                Review broker connection
              </Link>
            </Card>
          ) : null}
        </section>

        <section style={{ marginTop: 'var(--space-6)' }}>
          <Alert variant="info">
            Portfolio Truth is read-only. It does not place trades, calculate profit, or infer
            financial performance in the browser.
          </Alert>
        </section>
      </main>
    </DashboardShell>
  );
}
