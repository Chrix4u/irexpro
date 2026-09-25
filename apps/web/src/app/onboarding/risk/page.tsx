'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Badge, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';
import { mapApiError } from '@/lib/error-mapping';
import type { RiskProfile } from '@irexpro/types';

export default function AiProtectionPage() {
  const { user, logout, restoring } = useAuth();
  const [profile, setProfile] = useState<RiskProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.getRiskProfile()
      .then((next) => {
        if (!cancelled) setProfile(next);
      })
      .catch((requestError) => {
        if (!cancelled) setError(mapApiError(requestError).message);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring session…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '680px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to view AI protection status.</p>
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
            <p className="workspace-hero__eyebrow">Automatic account protection</p>
            <h1 id="ai-protection-title" className="workspace-hero__title">AI Protection</h1>
            <p className="workspace-hero__description">
              You do not need to configure trading risk. iRexPro applies server-managed safeguards
              to every AI decision before it can create exposure.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Badge variant={profile?.killSwitchActive ? 'error' : 'success'}>
              {profile?.killSwitchActive ? 'Trading protection active' : 'Protection online'}
            </Badge>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

        {!profile && !error ? (
          <Card title="Loading AI protection">
            <LoadingSpinner text="Loading server-managed safeguards…" />
          </Card>
        ) : profile ? (
          <>
            {profile.killSwitchActive && (
              <Alert variant="warning">
                AI trading is currently stopped by the server-side kill switch.
                {profile.killSwitchReason ? ` Reason: ${profile.killSwitchReason}` : ''}
              </Alert>
            )}

            <section className="workspace-stat-grid" aria-label="Automatic protection limits">
              <Card title="Daily loss protection">
                <div className="workspace-metric">
                  <span className="workspace-metric__value">{profile.maxDailyLossPercent}%</span>
                  <span className="workspace-metric__hint">New exposure is blocked when the daily protection threshold is reached.</span>
                </div>
              </Card>
              <Card title="Drawdown protection">
                <div className="workspace-metric">
                  <span className="workspace-metric__value">{profile.maxDrawdownPercent}%</span>
                  <span className="workspace-metric__hint">The engine suspends automation when the account drawdown threshold is reached.</span>
                </div>
              </Card>
              <Card title="Concurrent positions">
                <div className="workspace-metric">
                  <span className="workspace-metric__value">{profile.maxOpenTrades}</span>
                  <span className="workspace-metric__hint">The AI cannot exceed the server-managed open-position limit.</span>
                </div>
              </Card>
              <Card title="Daily trade count">
                <div className="workspace-metric">
                  <span className="workspace-metric__value">AI-driven</span>
                  <span className="workspace-metric__hint">No fixed trades-per-day cap. Every qualified opportunity can be considered while the protections above remain active.</span>
                </div>
              </Card>
            </section>

            <Card
              title="What you control"
              subtitle="The complex trading configuration stays with the AI and server-side risk engine."
            >
              <div className="workspace-grid-3">
                <div className="workspace-form-section">
                  <strong>1. Connect broker</strong>
                  <span className="muted text-sm">Choose the broker account the AI is allowed to use.</span>
                </div>
                <div className="workspace-form-section">
                  <strong>2. Allocate capital</strong>
                  <span className="muted text-sm">Set the maximum account capital available to the AI.</span>
                </div>
                <div className="workspace-form-section">
                  <strong>3. AI automation</strong>
                  <span className="muted text-sm">Start or stop AI Trading. The engine handles strategy and risk checks.</span>
                </div>
              </div>
              <div className="workspace-actions mt-4" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Link href="/onboarding/broker" className="btn btn--secondary">Broker Account</Link>
                <Link href="/trade" className="btn btn--primary">Open AI Trading</Link>
              </div>
            </Card>
          </>
        ) : null}
      </main>
    </DashboardShell>
  );
}
