'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DashboardShell, Card, Button, Alert, Badge } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { useNotification } from '@/hooks/useNotification';
import { mapApiError } from '@/lib/error-mapping';
import { api } from '@/lib/api';
import { IREXPRO_BROKER_OAUTH_FLOW_KEY } from '@/lib/broker-oauth-flow';
import type { BrokerOAuthAccount, BrokerConnectionView } from '@irexpro/types';

/**
 * cTrader OAuth callback client (Sprint 56 correction round 1 / audit
 * point 6): exchanges the single-use authorization code (server-side, with
 * the platform application credentials), lists the discovered cTID
 * accounts, and links the chosen account as an encrypted broker
 * connection.
 *
 * Honesty rules (mirroring the server):
 * - DEMO accounts are selectable; LIVE accounts render as pending
 *   production-LIVE verification (UNVERIFIED brokers are DEMO-only — the
 *   server fails closed regardless of what this UI allows).
 * - No token material ever appears here (the API never returns it).
 */
type CallbackPhase = 'exchanging' | 'pick' | 'linking' | 'done' | 'error';

export default function BrokerOAuthCallbackClient({ code }: { code: string | null }) {
  const router = useRouter();
  const { user, logout, restoring } = useAuth();
  const notify = useNotification();

  const [phase, setPhase] = useState<CallbackPhase>('exchanging');
  const [accounts, setAccounts] = useState<BrokerOAuthAccount[]>([]);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkedConnection, setLinkedConnection] = useState<BrokerConnectionView | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const storedFlowId = sessionStorage.getItem(IREXPRO_BROKER_OAUTH_FLOW_KEY);
      if (!code) {
        setPhase('error');
        setError(
          'No authorization code was delivered by cTrader (the consent may have been ' +
            'cancelled, or the code already expired). Start the authorization again.',
        );
        return;
      }
      if (!storedFlowId) {
        setPhase('error');
        setError(
          'The OAuth flow could not be matched on this browser session — start the ' +
            'authorization again from the broker connection page.',
        );
        return;
      }
      try {
        const result = await api.completeBrokerOAuth({ flowId: storedFlowId, code });
        if (cancelled) return;
        // The code is spent — clear the local flow reference. The server
        // keeps the flow AUTHORIZED (memory-only, bounded TTL) for linking.
        sessionStorage.removeItem(IREXPRO_BROKER_OAUTH_FLOW_KEY);
        setFlowId(result.flowId);
        setAccounts(result.accounts);
        setPhase('pick');
      } catch (err) {
        if (cancelled) return;
        sessionStorage.removeItem(IREXPRO_BROKER_OAUTH_FLOW_KEY);
        setPhase('error');
        setError(mapApiError(err).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const handleLink = useCallback(
    async (account: BrokerOAuthAccount) => {
      if (!flowId || account.isLive) return;
      setPhase('linking');
      try {
        const connection = await api.linkBrokerOAuth({
          flowId,
          ctidTraderAccountId: account.ctidTraderAccountId,
          displayName: `${account.brokerTitleShort ?? 'cTrader'} DEMO ${account.ctidTraderAccountId}`,
        });
        setLinkedConnection(connection);
        setPhase('done');
        notify.success('cTrader account linked.');
      } catch (err) {
        setPhase('error');
        setError(mapApiError(err).message);
      }
    },
    [flowId, notify],
  );

  if (restoring) {
    return <div style={{ padding: '3rem' }}><p className="muted">Restoring session…</p></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '600px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">You need to be logged in to complete the broker authorization.</p>
          <Link href="/login" className="btn btn--primary mt-4" style={{ display: 'inline-block' }}>Go to login</Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/onboarding/broker">
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ marginBottom: 'var(--space-2)' }}>cTrader authorization</h1>
        <p className="muted" style={{ maxWidth: '640px', lineHeight: 1.6 }}>
          Complete the connection by choosing the trading account you authorized.
        </p>
      </div>

      {phase === 'exchanging' && (
        <Card title="Exchanging authorization…">
          <p className="muted">Completing the cTrader authorization (this takes a moment).</p>
        </Card>
      )}

      {phase === 'error' && (
        <Card title="Authorization could not be completed">
          {error && <Alert variant="error">{error}</Alert>}
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Link href="/onboarding/broker" className="btn btn--primary" style={{ display: 'inline-block' }}>
              Back to broker connections
            </Link>
          </div>
        </Card>
      )}

      {phase === 'pick' && (
        <Card title="Choose an account to link">
          <p className="card__subtitle">
            These are the cTrader accounts you granted access to. DEMO accounts are ready to
            link; LIVE accounts require production-LIVE verification of the broker on our
            platform first (currently pending for cTrader-family brokers).
          </p>
          {accounts.length === 0 ? (
            <Alert variant="warning">
              No trading accounts were granted to this authorization — grant access to at
              least one account at cTrader, then start again.
            </Alert>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {accounts.map((account) => (
                <div
                  key={account.ctidTraderAccountId}
                  style={{
                    padding: 'var(--space-4)',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-tint)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-3)',
                    opacity: account.isLive ? 0.7 : 1,
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '0.95rem' }}>
                        {account.brokerTitleShort ?? 'cTrader'}
                      </strong>
                      <Badge variant={account.isLive ? 'warning' : 'success'}>
                        {account.isLive ? 'LIVE — verification pending' : 'DEMO'}
                      </Badge>
                    </div>
                    <div className="text-sm muted" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                      Account {account.ctidTraderAccountId}
                      {account.traderLogin !== undefined ? ` · login ${account.traderLogin}` : ''}
                    </div>
                    {account.isLive && (
                      <div className="text-sm muted" style={{ marginTop: 'var(--space-1)' }}>
                        Live linking opens after operator-verified production-LIVE evidence —
                        connect the matching DEMO account for now.
                      </div>
                    )}
                  </div>
                  <Button
                    variant={account.isLive ? 'secondary' : 'primary'}
                    size="sm"
                    disabled={account.isLive}
                    onClick={() => void handleLink(account)}
                  >
                    {account.isLive ? 'Not yet available' : 'Link this account'}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Link href="/onboarding/broker" className="text-sm">← Cancel and go back</Link>
          </div>
        </Card>
      )}

      {phase === 'linking' && (
        <Card title="Linking your account…">
          <p className="muted">Saving the encrypted connection.</p>
        </Card>
      )}

      {phase === 'done' && linkedConnection && (
        <Card title="Account linked">
          <Alert variant="success">
            <span style={{ flex: 1 }}>
              ✅ {linkedConnection.brokerName} account {linkedConnection.accountId} is linked
              (credentials encrypted). Next: connect it and run the DEMO validation checklist
              from the broker connections page.
            </span>
          </Alert>
          <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={() => router.push('/onboarding/broker')}>
              Back to broker connections
            </Button>
            <Button variant="secondary" onClick={() => router.push('/dashboard')}>
              Go to dashboard
            </Button>
          </div>
        </Card>
      )}
    </DashboardShell>
  );
}
