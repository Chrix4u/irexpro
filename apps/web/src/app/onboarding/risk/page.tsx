'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/context/auth-context';
import { Alert, Badge, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { api } from '@/lib/api';
import { mapApiError } from '@/lib/error-mapping';
import type { RiskProfile } from '@irexpro/types';

/**
 * Compatibility route for older links/bookmarks.
 *
 * Risk parameters are intentionally not user onboarding inputs anymore.
 * Conservative limits remain server-managed and are enforced on every AI
 * decision. The normal onboarding path goes Eligibility -> Broker.
 */
export default function OnboardingRiskPage() {
  const { user, logout, restoring } = useAuth();
  const [profile, setProfile] = useState<RiskProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) return;
    api.getRiskProfile()
      .then((next) => {
        if (!cancelled) setProfile(next);
      })
      .catch((requestError) => {
        if (!cancelled) setError(mapApiError(requestError).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [user]);

  if (restoring) {
    return <div style={{ padding: '3rem' }}><p className="muted">Restoring session…</p></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '640px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to continue.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/onboarding/risk" title="AI Protection">
      <main className="workspace-page" aria-labelledby="ai-protection-title">
        <section className="workspace-hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">AI-managed protection</p>
            <h1 id="ai-protection-title" className="workspace-hero__title">Nothing to configure</h1>
            <p className="workspace-hero__description">
              iRexPro applies conservative server-side risk controls automatically. You do not need
              to choose leverage, drawdown, trade count, position size, or execution parameters.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Badge variant={profile?.killSwitchActive ? 'error' : 'success'}>
              {profile?.killSwitchActive ? 'Emergency stop active' : 'Protection active'}
            </Badge>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

        {loading ? (
          <Card><LoadingSpinner text="Loading protection status…" /></Card>
        ) : (
          <section className="workspace-stat-grid" aria-label="Automatic protection summary">
            <Card>
              <p className="workspace-metric__label">Loss & drawdown limits</p>
              <strong className="workspace-metric__value">Automatic</strong>
              <p className="workspace-metric__hint">The server pauses or blocks new exposure when protective limits are reached.</p>
            </Card>
            <Card>
              <p className="workspace-metric__label">Position sizing</p>
              <strong className="workspace-metric__value">AI + risk engine</strong>
              <p className="workspace-metric__hint">Every proposed order is sized and validated before execution.</p>
            </Card>
            <Card>
              <p className="workspace-metric__label">Your setup</p>
              <strong className="workspace-metric__value">3 simple actions</strong>
              <p className="workspace-metric__hint">Connect broker, allocate capital, then switch AI Auto on or off.</p>
            </Card>
          </section>
        )}

        <Card title="Continue setup" subtitle="Advanced protection remains enforced in the background.">
          <div className="workspace-actions" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link href="/onboarding/broker" className="btn btn--primary">Connect broker</Link>
            <Link href="/trade" className="btn btn--secondary">Open AI Auto Trader</Link>
          </div>
        </Card>
      </main>
    </DashboardShell>
  );
}
