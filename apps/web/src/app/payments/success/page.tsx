'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';

type VerifyStatus = 'verifying' | 'confirmed' | 'failed';

function statusVariant(status: VerifyStatus): 'success' | 'warning' | 'error' {
  if (status === 'confirmed') return 'success';
  if (status === 'failed') return 'error';
  return 'warning';
}

function statusLabel(status: VerifyStatus): string {
  if (status === 'confirmed') return 'Confirmed';
  if (status === 'failed') return 'Needs attention';
  return 'Verifying';
}

/**
 * Fees & Payments workspace / provider return surface.
 *
 * DISPLAY-ONLY. Landing here does not prove that a provider payment settled.
 * Verified webhook evidence remains the payment source of truth.
 */
export default function PaymentSuccessPage() {
  const { user, logout, restoring } = useAuth();
  const [status, setStatus] = useState<VerifyStatus>('verifying');
  const [reference, setReference] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (sessionId) setReference(sessionId);

    // Keep the page ready for the future read-only provider-status contract.
    // The browser never changes a fee/payment record to paid by itself.
    const interval = window.setInterval(async () => {
      try {
        // Intentionally no local confirmation. A future authenticated
        // read-only endpoint may update `status` after webhook verification.
      } catch {
        setStatus('verifying');
      }
    }, 3000);

    return () => window.clearInterval(interval);
  }, []);

  if (restoring) {
    return <LoadingSpinner text="Restoring fees and payments…" />;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 620, margin: '0 auto' }}>
        <Card title="Sign in required">
          <p className="muted">Sign in to review payment status and performance-fee information.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/payments/success" title="Fees & Payments">
      <main className="workspace-page" aria-labelledby="fees-payments-title">
        <section className="workspace-hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">Billing & settlement</p>
            <h1 id="fees-payments-title" className="workspace-hero__title">Fees & Payments</h1>
            <p className="workspace-hero__description">
              Review provider verification state and the performance-fee model. Payment settlement is accepted only from verified server-side provider evidence; this browser never marks a charge as paid by itself.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
          </div>
        </section>

        <section className="workspace-grid-3" aria-label="Fees and payments summary">
          <Card>
            <div className="workspace-metric">
              <span className="workspace-metric__label">Billing model</span>
              <strong className="workspace-metric__value">Performance fee</strong>
              <span className="workspace-metric__hint">Applies only to qualifying realised profit under the configured high-water-mark rules.</span>
            </div>
          </Card>
          <Card>
            <div className="workspace-metric">
              <span className="workspace-metric__label">Current provider state</span>
              <strong className="workspace-metric__value">{statusLabel(status)}</strong>
              <span className="workspace-metric__hint">Webhook-verified provider evidence remains authoritative.</span>
            </div>
          </Card>
          <Card>
            <div className="workspace-metric">
              <span className="workspace-metric__label">Fee ledger</span>
              <strong className="workspace-metric__value">Pending contract</strong>
              <span className="workspace-metric__hint">Accrued fee, high-water mark and settlement history will appear only when the backend exposes authoritative records.</span>
            </div>
          </Card>
        </section>

        <section className="workspace-grid-2">
          <Card title="Provider verification" subtitle="A provider redirect is informational until the server verifies settlement.">
            {reference ? (
              <>
                <Alert variant={status === 'failed' ? 'error' : status === 'confirmed' ? 'success' : 'info'}>
                  {status === 'confirmed'
                    ? 'The server reports this provider payment as confirmed.'
                    : status === 'failed'
                      ? 'The provider payment could not be confirmed. Review the provider or try again later.'
                      : 'Payment received by the provider flow — server verification is still pending.'}
                </Alert>
                <div className="workspace-form-section mt-4">
                  <div className="workspace-metric">
                    <span className="workspace-metric__label">Provider reference</span>
                    <code style={{ overflowWrap: 'anywhere' }}>{reference}</code>
                  </div>
                </div>
              </>
            ) : (
              <Alert variant="info">
                No provider checkout reference is attached to this visit. This is your general fees and payments workspace.
              </Alert>
            )}
          </Card>

          <Card title="Performance-fee policy" subtitle="High-water-mark billing protects against charging the same profit twice.">
            <div className="workspace-form-section">
              <div className="workspace-metric">
                <span className="workspace-metric__label">Qualifying basis</span>
                <strong>Net-new realised profit</strong>
                <span className="workspace-metric__hint">The actual configured fee rate must come from the server-side billing configuration.</span>
              </div>
              <div className="workspace-metric">
                <span className="workspace-metric__label">Browser safety</span>
                <strong>No local fee calculation</strong>
                <span className="workspace-metric__hint">The UI does not invent balances, P&amp;L, fee rates or settlement status.</span>
              </div>
            </div>
          </Card>
        </section>

        <section className="workspace-grid-2">
          <Card title="Trading activity">
            <p className="muted">
              Open positions, closed executions and server-authoritative trading activity are available in the Trading Workspace.
            </p>
            <Link href="/trade" className="btn btn--secondary mt-4">Open Trading Workspace</Link>
          </Card>
          <Card title="Portfolio & risk">
            <p className="muted">
              Review execution capacity, risk limits and portfolio freshness before changing trading authority.
            </p>
            <Link href="/portfolio" className="btn btn--secondary mt-4">Open Portfolio & Risk</Link>
          </Card>
        </section>
      </main>
    </DashboardShell>
  );
}
