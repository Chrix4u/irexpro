'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/auth-context';
import { DashboardShell, Card, Badge, EmptyState, LoadingSpinner, Alert } from '@/components/ui';
import { useNotification } from '@/hooks/useNotification';
import { mapApiError } from '@/lib/error-mapping';
import { api } from '@/lib/api';
import { formatEnumLabel } from '@irexpro/types';
import type { OnboardingStatus } from '@irexpro/types';

export default function DashboardPage() {
  const { user, logout, restoring } = useAuth();
  const notify = useNotification();
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const onboardingErrorShownRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await api.getOnboardingStatus();
        if (!cancelled) setOnboarding(status);
      } catch (err) {
        if (!cancelled) {
          setOnboardingError(err instanceof Error ? err.message : 'Failed to load onboarding status');
          if (!onboardingErrorShownRef.current) {
            notify.error(mapApiError(err).message);
            onboardingErrorShownRef.current = true;
          }
        }
      } finally {
        if (!cancelled) setOnboardingLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, notify]);

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring session…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '600px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">You need to log in to view your trading dashboard.</p>
          <a href="/login" className="btn btn--primary mt-4" style={{ display: 'inline-block' }}>Go to login</a>
        </Card>
      </div>
    );
  }

  const fullName = user.firstName || user.lastName
    ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
    : (user.email ?? user.phone ?? 'Trader');

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/dashboard">
      <main className="workspace-page" aria-labelledby="dashboard-title">
        <section className="workspace-hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">Trading operations overview</p>
            <h1 id="dashboard-title" className="workspace-hero__title">
              Welcome back, {fullName.split(' ')[0]}
            </h1>
            <p className="workspace-hero__description">
              Track onboarding readiness, broker connectivity, account protection and the next step in your trading workflow from one responsive overview.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Badge variant={onboarding?.canStartTrading ? 'success' : 'info'}>
              {onboarding?.canStartTrading ? 'Trading ready' : 'Setup in progress'}
            </Badge>
          </div>
        </section>

        {onboardingLoading ? (
          <Card title="Onboarding checklist">
            <LoadingSpinner text="Loading onboarding status…" />
          </Card>
        ) : onboarding ? (
          <OnboardingCard status={onboarding} />
        ) : (
          <Card title="Onboarding checklist">
            <Alert variant="error">{onboardingError ?? 'Unable to load onboarding status.'}</Alert>
          </Card>
        )}

        <section className="workspace-stat-grid" aria-label="Account overview">
          <Card>
            <span className="stat-card__icon" aria-hidden="true">👤</span>
            <h2 className="card__title">Account status</h2>
            <div className="mt-2">
              <Badge variant={user.status === 'ACTIVE' ? 'success' : 'warning'}>{formatEnumLabel(user.status)}</Badge>
            </div>
            <div className="mt-4" style={{ display: 'grid', gap: 'var(--space-1)' }}>
              <p className="text-sm muted">Email: {user.email ?? '(phone-only)'}</p>
              {user.phone && <p className="text-sm muted">Phone: {user.phone}</p>}
              {user.countryCode && <p className="text-sm muted">Country: {user.countryCode}</p>}
              <p className="text-sm muted">MFA: {user.mfaEnabled ? 'Enabled' : 'Not enabled'}</p>
            </div>
          </Card>

          <Card>
            <span className="stat-card__icon" aria-hidden="true">🔌</span>
            <h2 className="card__title">Broker connection</h2>
            {onboarding?.brokerConnected ? (
              <EmptyState icon="✓" title="Broker connected" description="Your broker account is connected and available to the trading workflow." />
            ) : (
              <EmptyState icon="◎" title="No broker connected" description="Connect a paper/demo broker account to continue setup." />
            )}
          </Card>

          <Card>
            <span className="stat-card__icon" aria-hidden="true">◈</span>
            <h2 className="card__title">Performance fee</h2>
            <p className="text-sm muted" style={{ lineHeight: 1.65 }}>
              Performance fees apply only to qualifying realised profit above the applicable high-water mark. No subscription is required.
            </p>
            <Link href="/payments/success" className="btn btn--secondary btn--sm mt-4">Review fees & payments</Link>
          </Card>
        </section>

        <Card title="Recent activity" subtitle="Server-authoritative decisions and executions appear in the trading surfaces.">
          <EmptyState icon="↗" title="No trading activity yet" description="AI decision evidence and execution history will appear after the trading pipeline records activity." />
        </Card>
      </main>
    </DashboardShell>
  );
}

function OnboardingCard({ status }: { status: OnboardingStatus }) {
  const steps = [
    {
      key: 'PROFILE',
      label: 'Identity & account details',
      href: '/onboarding/profile',
      done: status.profileCompleted,
      description: 'Add the identity and regional details needed for eligibility.',
    },
    {
      key: 'ELIGIBILITY',
      label: 'Eligibility & disclosures',
      href: '/onboarding/eligibility',
      done: status.eligibilityCompleted,
      description: 'Complete age, KYC, jurisdiction and required automated-trading disclosures.',
    },
    {
      key: 'BROKER_CONNECTION',
      label: 'Connect broker',
      href: '/onboarding/broker',
      done: status.brokerConnected,
      description: 'Connect the broker account the AI will use. You will allocate capital in AI Auto Trader.',
    },
  ];

  return (
    <Card
      title={status.canStartTrading ? 'Ready for AI Auto Trader' : 'Complete your setup'}
      subtitle={status.canStartTrading
        ? 'Your broker is connected. Choose an allocation and switch AI Auto on when you are ready.'
        : 'Three simple steps prepare the account; trading parameters are managed by the AI and risk engine.'}
      className="readiness-card"
    >
      <div className="checklist" role="list">
        {steps.map((step) => (
          <div key={step.key} className={`checklist__step${step.done ? ' checklist__step--done' : ''}`} role="listitem">
            <span className="checklist__indicator" aria-hidden="true">{step.done ? '✓' : ''}</span>
            <div className="checklist__body">
              <div className="checklist__step-title">
                {step.label}
                {step.done && <Badge variant="success">Done</Badge>}
              </div>
              <p className="checklist__step-desc">{step.description}</p>
            </div>
            {!step.done && (
              <div className="checklist__action">
                <Link href={step.href} className="btn btn--primary btn--sm">
                  {status.nextStep === step.key ? 'Continue' : 'Open'}
                </Link>
              </div>
            )}
          </div>
        ))}
      </div>

      {status.canStartTrading && (
        <Link href="/trade" className="btn btn--primary btn--lg" style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
          Allocate capital & open AI Auto Trader
        </Link>
      )}
    </Card>
  );
}
