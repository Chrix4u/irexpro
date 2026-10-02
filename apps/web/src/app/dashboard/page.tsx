'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/auth-context';
import { DashboardShell, Card, Badge, EmptyState, LoadingSpinner, Alert } from '@/components/ui';
import { useNotification } from '@/hooks/useNotification';
import { MotionStatusOrb } from '@/components/ui/motion-status-orb';
import { mapApiError } from '@/lib/error-mapping';
import { api } from '@/lib/api';
import { formatEnumLabel } from '@irexpro/types';
import type { OnboardingStatus } from '@irexpro/types';
import type { LiveAccountActivityPage, LiveActivityRowView } from '@irexpro/types/live-account';
import { loadLiveAccountActivity } from '@/lib/live-account';

export default function DashboardPage() {
  const { user, logout, restoring } = useAuth();
  const notify = useNotification();
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [activity, setActivity] = useState<LiveAccountActivityPage | null>(null);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const refreshActivity = async (initial = false) => {
      if (initial && !cancelled) setActivityLoading(true);
      try {
        const nextActivity = await loadLiveAccountActivity(8, 0);
        if (!cancelled) {
          setActivity(nextActivity);
          setActivityError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setActivityError(mapApiError(err).message);
        }
      } finally {
        if (initial && !cancelled) setActivityLoading(false);
      }
    };

    void refreshActivity(true);
    const timer = window.setInterval(() => void refreshActivity(false), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user]);

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
      <main className="workspace-page dashboard-motion" aria-labelledby="dashboard-title">
        <section className="workspace-hero dashboard-motion__hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">Trading operations overview</p>
            <h1 id="dashboard-title" className="workspace-hero__title">
              {`WELCOME BACK, ${fullName.split(' ')[0]}`.toUpperCase()}
            </h1>
            <p className="workspace-hero__description">
              Track onboarding readiness, broker connectivity, account protection and the next step in your trading workflow from one responsive overview.
            </p>
          </div>
          <div className="workspace-hero__actions dashboard-motion__status">
            <MotionStatusOrb
              tone={onboarding?.canStartTrading ? 'success' : 'info'}
              active={!onboardingLoading}
              label={onboarding?.canStartTrading ? 'Trading ready' : 'Setup in progress'}
            />
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
          <Card className="dashboard-motion__card">
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

          <Card className="dashboard-motion__card">
            <span className="stat-card__icon" aria-hidden="true">🔌</span>
            <h2 className="card__title">Broker connection</h2>
            {onboarding?.brokerConnected ? (
              <EmptyState icon="✓" title="Broker connected" description="Your broker account is connected and available to the trading workflow." />
            ) : (
              <EmptyState icon="◎" title="No broker connected" description="Connect a paper/demo broker account to continue setup." />
            )}
          </Card>

          <Card className="dashboard-motion__card">
            <span className="stat-card__icon" aria-hidden="true">◈</span>
            <h2 className="card__title">Performance fee</h2>
            <p className="text-sm muted" style={{ lineHeight: 1.65 }}>
              Performance fees apply only to qualifying realised profit above the applicable high-water mark. No subscription is required.
            </p>
            <Link href="/payments" className="btn btn--secondary btn--sm mt-4">Review fees & payments</Link>
          </Card>
        </section>

        <Card title="Recent activity" subtitle="Latest server-authoritative account, AI trading and execution events." className="dashboard-motion__activity">
          {activityLoading ? (
            <LoadingSpinner text="Loading recent activity…" />
          ) : activityError ? (
            <Alert variant="error">{activityError}</Alert>
          ) : activity?.activity.length ? (
            <div>
              <div role="list" aria-label="Recent account activity" style={{ display: 'grid', gap: 'var(--space-3)' }}>
                {activity.activity.map((item) => (
                  <ActivityRow key={item.id} item={item} />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 'var(--space-3)' }}>
                <Link href="/live-account" className="btn btn--secondary btn--sm">View all activity</Link>
              </div>
            </div>
          ) : (
            <EmptyState icon="↗" title="No activity yet" description="Broker, AI session and execution events will appear here as soon as the server records them." />
          )}
        </Card>
      </main>
    </DashboardShell>
  );
}

function OnboardingCard({ status }: { status: OnboardingStatus }) {
  const steps = [
    {
      key: 'PROFILE',
      label: 'Verify your profile',
      href: '/onboarding/profile',
      done: status.profileCompleted,
      description: 'Provide the identity and regional details required for account verification.',
    },
    {
      key: 'ELIGIBILITY',
      label: 'Complete required disclosures',
      href: '/onboarding/eligibility',
      done: status.eligibilityCompleted,
      description: 'Complete the server-required age, identity, jurisdiction and disclosure checks.',
    },
    {
      key: 'BROKER_CONNECTION',
      label: 'Connect broker',
      href: '/onboarding/broker',
      done: status.brokerConnected,
      description: 'Connect the broker account the AI will trade through.',
    },
  ];

  function stepToHref(step: string): string {
    switch (step) {
      case 'PROFILE': return '/onboarding/profile';
      case 'ELIGIBILITY': return '/onboarding/eligibility';
      case 'BROKER_CONNECTION': return '/onboarding/broker';
      default: return '/dashboard';
    }
  }


  return (
    <Card
      title={status.canStartTrading ? 'Trading setup ready' : 'Complete your onboarding'}
      subtitle={status.canStartTrading
        ? 'All required steps are complete. Open AI Trading to allocate capital and start AI Trading.'
        : 'Complete these steps to enable the trading workflow.'}
      className="readiness-card"
    >
      {status.canStartTrading ? (
        <Alert variant="success">Trading setup ready. Continue to AI Trading to allocate capital and start AI Trading.</Alert>
      ) : (
        <Alert variant="info">
          Next step: <strong>{status.nextStep === 'READY' ? 'All complete' : status.nextStep.replace(/_/g, ' ').toLowerCase()}</strong>
        </Alert>
      )}


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
                  {status.nextStep === step.key ? 'Start' : 'Complete'}
                </Link>
              </div>
            )}
          </div>
        ))}
      </div>

      {status.canStartTrading && (
        <Link href="/trade" className="btn btn--primary btn--lg btn--block readiness-card__cta">
          Open AI Trading
        </Link>
      )}
    </Card>
  );
}


function ActivityRow({ item }: { item: LiveActivityRowView }) {
  const badgeVariant = item.severity === 'CRITICAL'
    ? 'error'
    : item.severity === 'WARNING'
      ? 'warning'
      : 'info';
  const label = item.action
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const timestamp = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(item.createdAt));

  return (
    <div
      role="listitem"
      className="dashboard-motion__activity-row"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: 'var(--space-3)',
        alignItems: 'center',
        paddingBottom: 'var(--space-3)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <strong>{label}</strong>
          <Badge variant={badgeVariant}>{item.severity}</Badge>
        </div>
        <p className="text-sm muted mt-1">
          {item.resourceType ? item.resourceType : 'Account activity'}
          {item.resourceId ? ` · ${item.resourceId.slice(0, 8)}` : ''}
        </p>
      </div>
      <time className="text-sm muted" dateTime={item.createdAt} style={{ whiteSpace: 'nowrap' }}>
        {timestamp}
      </time>
    </div>
  );
}
