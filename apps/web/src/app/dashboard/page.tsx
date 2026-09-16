'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/auth-context';
import { DashboardShell, Card, Badge, EmptyState, LoadingSpinner, Alert, Button } from '@/components/ui';
import { useNotification } from '@/hooks/useNotification';
import { mapApiError } from '@/lib/error-mapping';
import { api } from '@/lib/api';
import { formatEnumLabel } from '@irexpro/types';
import type { OnboardingStatus } from '@irexpro/types';

/**
 * Web dashboard — Sprint 29.
 *
 * Shows the onboarding checklist card + existing account/subscription/activity
 * cards. The onboarding card fetches GET /users/me/onboarding-status and
 * displays the next step + missing steps with action buttons.
 *
 * UX-4: Premium visual redesign — premium checklist step rows, status cards
 * with icon containers, polished TRADING_NOT_READY alert. Business logic, API
 * calls, readiness gate, and notifications unchanged.
 */
export default function DashboardPage() {
  const { user, logout, loading, restoring } = useAuth();
  const notify = useNotification();
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  // Track whether the onboarding-status load error has already been surfaced
  // via a toast — prevents spamming on background refreshes.
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
          // Only show the toast once per mount — background refreshes shouldn't spam.
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

  const fullName = user.firstName || user.lastName ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : (user.email ?? user.phone ?? 'Trader');

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/dashboard">
      {/* Premium dashboard header */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ marginBottom: 'var(--space-2)' }}>
          Welcome back, <span style={{ color: 'var(--brand-light)' }}>{fullName.split(' ')[0]}</span>
        </h1>
        <p className="muted" style={{ maxWidth: '640px', lineHeight: 1.6 }}>
          Here&rsquo;s a snapshot of your account, broker connection, and onboarding progress.
        </p>
      </div>

      {/* Sprint 29: Onboarding checklist card */}
      {onboardingLoading ? (
        <Card title="Onboarding checklist" className="mt-4">
          <LoadingSpinner text="Loading onboarding status…" />
        </Card>
      ) : onboarding ? (
        <OnboardingCard status={onboarding} />
      ) : (
        <Card title="Onboarding checklist" className="mt-4">
          <Alert variant="error">{onboardingError ?? 'Unable to load onboarding status.'}</Alert>
        </Card>
      )}

      {/* ── Status cards ──────────────────────────────────────────────────── */}
      <div
        className="stat-grid"
        style={{ marginTop: 'var(--space-6)' }}
      >
        {/* Account status */}
        <Card>
          <span className="stat-card__icon" aria-hidden="true">👤</span>
          <h2 className="card__title" style={{ marginBottom: 'var(--space-2)' }}>Account status</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
            <Badge variant={user.status === 'ACTIVE' ? 'success' : 'warning'}>{formatEnumLabel(user.status)}</Badge>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <p className="text-sm muted">Email: {user.email ?? '(phone-only)'}</p>
            {user.phone && <p className="text-sm muted">Phone: {user.phone}</p>}
            {user.countryCode && <p className="text-sm muted">Country: {user.countryCode}</p>}
            {user.mfaEnabled && <p className="text-sm muted">MFA: Enabled</p>}
          </div>
        </Card>

        {/* Broker connection */}
        <Card>
          <span className="stat-card__icon" aria-hidden="true">🔌</span>
          <h2 className="card__title" style={{ marginBottom: 'var(--space-2)' }}>Broker connection</h2>
          {onboarding?.brokerConnected ? (
            <EmptyState icon="✅" title="Broker connected" description="Your broker account is connected and ready for trading." />
          ) : (
            <EmptyState icon="🔌" title="No broker connected" description="Connect a broker account to begin AI auto-trading." />
          )}
        </Card>

        {/* Performance Fee (subscription-retirement model) */}
        <Card>
          <span className="stat-card__icon" aria-hidden="true">💰</span>
          <h2 className="card__title" style={{ marginBottom: 'var(--space-2)' }}>Performance Fee</h2>
          <p className="text-sm muted" style={{ lineHeight: 1.6 }}>
            You only pay a performance fee when your trading generates qualifying
            realised profit above the high-water mark. No subscription required.
          </p>
        </Card>
      </div>

      <Card title="Recent activity" className="mt-6">
        <EmptyState icon="📈" title="No trading activity yet" description="Your AI trading signals and execution history will appear here once you start trading." />
      </Card>
    </DashboardShell>
  );
}

/**
 * Onboarding checklist card — shows 4 steps with status + action buttons.
 * Sprint 29 amendment: adds "Start trading" button that handles the
 * TRADING_NOT_READY structured error (403 + missingSteps) from the backend.
 *
 * UX-4: Premium redesign using .checklist / .checklist__step classes.
 */
function OnboardingCard({ status }: { status: OnboardingStatus }) {
  const notify = useNotification();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [missingSteps, setMissingSteps] = useState<string[] | null>(null);

  const steps = [
    {
      key: 'PROFILE',
      label: 'Complete profile',
      href: '/onboarding/profile',
      done: status.profileCompleted,
      description: 'Set your name, country, timezone, currency, and trading experience.',
    },
    {
      key: 'RISK_PROFILE',
      label: 'Set risk limits',
      href: '/onboarding/risk',
      done: status.riskProfileCompleted,
      description: 'Configure your daily loss limit, max trade risk, and acknowledge the risk disclosure.',
    },
    {
      key: 'BROKER_CONNECTION',
      label: 'Connect broker',
      href: '/onboarding/broker',
      done: status.brokerConnected,
      description: 'Connect a Paper Trading or MetaTrader 5 broker account.',
    },
  ];

  /** Map a missing step to its onboarding page URL. */
  function stepToHref(step: string): string {
    switch (step) {
      case 'PROFILE': return '/onboarding/profile';
      case 'RISK_PROFILE': return '/onboarding/risk';
      case 'BROKER_CONNECTION': return '/onboarding/broker';
      default: return '/dashboard';
    }
  }

  async function handleStartTrading() {
    setStarting(true);
    setStartError(null);
    setMissingSteps(null);
    try {
      // The session-start contract (Sprint 56 correction round 5) binds the
      // EXACT broker connection + a durable executionMode via the typed
      // client method. The server validates everything fail-closed.
      const connections = await api.listBrokerConnections();
      const connection =
        connections.find((candidate) => candidate.status === 'CONNECTED') ?? connections[0];
      if (!connection) {
        setStartError('Connect a broker account before starting a trading session.');
        notify.warning('Connect a broker account first.');
        return;
      }
      await api.startTradingSession({
        brokerConnectionId: connection.id,
        executionMode: 'PAPER_ONLY',
      });
      // Success — trading session started (no auto-redirect; user stays on dashboard)
      setStartError(null);
      notify.success('Paper trading session started.');
    } catch (err) {
      // Sprint 29 amendment: handle the structured TRADING_NOT_READY error.
      // The error body is { statusCode: 403, code: 'TRADING_NOT_READY', message, missingSteps }
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 403) {
        const body = err as { code?: string; missingSteps?: string[]; message?: string };
        if (body.code === 'TRADING_NOT_READY' && body.missingSteps) {
          setMissingSteps(body.missingSteps);
          setStartError('Your trading setup is not ready. Complete the missing steps below.');
          notify.warning('Your trading setup is not ready.');
        } else {
          setStartError(body.message ?? 'Trading could not be started. Please try again.');
          notify.error(mapApiError(err).message);
        }
      } else {
        // Safe generic message — do NOT expose raw backend errors
        setStartError(err instanceof Error && !err.message.includes('fetch')
          ? err.message
          : 'Unable to start trading. Please try again or contact support.');
        notify.error(mapApiError(err).message);
      }
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card
      title={status.canStartTrading ? 'Trading setup ready' : 'Complete your onboarding'}
      subtitle={status.canStartTrading
        ? 'All required steps are complete. You can start trading when ready.'
        : 'Complete these steps to start automated trading.'}
      className="mt-4 readiness-card"
    >
      {status.canStartTrading ? (
        <Alert variant="success">
          ✅ Trading setup ready. Start a paper trading session below when you are ready.
        </Alert>
      ) : (
        <Alert variant="info">
          Next step: <strong>{status.nextStep === 'READY' ? 'All complete' : status.nextStep.replace(/_/g, ' ').toLowerCase()}</strong>
        </Alert>
      )}

      {/* Sprint 29 amendment: TRADING_NOT_READY error display */}
      {startError && (
        <Alert variant="warning">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 'var(--space-1)' }}>
              {startError}
            </div>
            {missingSteps && missingSteps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-2)' }}>
                {missingSteps.map((step) => (
                  <Link
                    key={step}
                    href={stepToHref(step)}
                    className="text-sm"
                    style={{ textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}
                  >
                    → Complete {formatEnumLabel(step)}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </Alert>
      )}

      {/* Premium onboarding checklist step rows */}
      <div className="checklist" role="list">
        {steps.map((step) => (
          <div
            key={step.key}
            className={`checklist__step${step.done ? ' checklist__step--done' : ''}`}
            role="listitem"
          >
            <span className="checklist__indicator" aria-hidden="true">
              {step.done ? '✓' : ''}
            </span>
            <div className="checklist__body">
              <div className="checklist__step-title">
                {step.label}
                {step.done && <Badge variant="success">Done</Badge>}
              </div>
              <p className="checklist__step-desc">{step.description}</p>
            </div>
            {!step.done && (
              <div className="checklist__action">
                <Link
                  href={step.href}
                  className="btn btn--primary btn--sm"
                  aria-label={status.nextStep === step.key ? `Start: ${step.label}` : `Complete: ${step.label}`}
                >
                  {status.nextStep === step.key ? 'Start' : 'Complete'}
                </Link>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Sprint 29 amendment: Start trading button (only shown when ready) */}
      {status.canStartTrading && (
        <Button
          onClick={handleStartTrading}
          disabled={starting}
          loading={starting}
          variant="primary"
          size="lg"
          block
          style={{ marginTop: 'var(--space-6)' }}
        >
          {starting ? 'Starting…' : 'Start Paper Trading Session'}
        </Button>
      )}
    </Card>
  );
}
