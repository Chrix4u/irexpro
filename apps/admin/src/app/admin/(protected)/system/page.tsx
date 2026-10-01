'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MfaSetupResponse } from '@irexpro/types';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';

interface ProviderReadiness {
  id: string;
  displayName: string;
  live: boolean;
  supportedCountries: string[];
}

interface SystemReadiness {
  generatedAt: string;
  security: {
    mfaReady: boolean;
    mfaEncryptionConfigured: boolean;
    verificationPepperConfigured: boolean;
  };
  email: {
    ready: boolean;
    smtpConfigured: boolean;
    fromAddressConfigured: boolean;
    webBaseUrlConfigured: boolean;
  };
  sms: {
    ready: boolean;
    providers: ProviderReadiness[];
    twilio: {
      ready: boolean;
      accountSidConfigured: boolean;
      accountSidFormatValid: boolean;
      authTokenConfigured: boolean;
      authTokenUsable: boolean;
      apiKeyConfigured: boolean;
      apiSecretConfigured: boolean;
      apiKeyPairUsable: boolean;
      fromNumberConfigured: boolean;
      fromNumberFormatValid: boolean;
    };
  };
  payments: {
    paystackEnabled: boolean;
    stripeEnabled: boolean;
  };
}

type MfaLocalState = 'unchanged' | 'enabled' | 'disabled';

function readinessBadge(ready: boolean) {
  return <Badge variant={ready ? 'success' : 'warning'}>{ready ? 'READY' : 'ACTION NEEDED'}</Badge>;
}

function checkLabel(ok: boolean): string {
  return ok ? 'Configured' : 'Needs attention';
}
export default function AdminSystemPage() {
  const { user, hasAdminRole, logout } = useAuth();
  const [readiness, setReadiness] = useState<SystemReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enrollPassword, setEnrollPassword] = useState('');
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaLocalState, setMfaLocalState] = useState<MfaLocalState>('unchanged');

  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disableConfirmOpen, setDisableConfirmOpen] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!hasAdminRole) return;
    refresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      setReadiness(await api.request<SystemReadiness>('/admin/system/readiness'));
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'System readiness could not be loaded.',
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [hasAdminRole]);

  useEffect(() => {
    void load();
  }, [load]);

  const mfaEnabled = useMemo(() => {
    if (mfaLocalState === 'enabled') return true;
    if (mfaLocalState === 'disabled') return false;
    return user?.mfaEnabled === true;
  }, [mfaLocalState, user?.mfaEnabled]);

  async function beginMfaSetup() {
    if (!enrollPassword || mfaBusy) return;
    const password = enrollPassword;
    setEnrollPassword('');
    setMfaError(null);
    setMfaBusy(true);
    try {
      setSetup(await api.beginMfaSetup(password));
    } catch (requestError) {
      setMfaError(requestError instanceof Error ? requestError.message : 'MFA setup could not start.');
    } finally {
      setMfaBusy(false);
    }
  }
  async function enableMfa() {
    if (!setup || !/^\d{6}$/u.test(enrollCode.trim()) || mfaBusy) return;
    const code = enrollCode.trim();
    setEnrollCode('');
    setMfaError(null);
    setMfaBusy(true);
    try {
      await api.enableMfa(code);
      setSetup(null);
      setMfaLocalState('enabled');
    } catch (requestError) {
      setMfaError(requestError instanceof Error ? requestError.message : 'MFA could not be enabled.');
    } finally {
      setMfaBusy(false);
    }
  }

  async function disableMfa() {
    if (!disablePassword || !/^\d{6}$/u.test(disableCode.trim()) || mfaBusy) return;
    const currentPassword = disablePassword;
    const code = disableCode.trim();
    setDisablePassword('');
    setDisableCode('');
    setDisableConfirmOpen(false);
    setMfaError(null);
    setMfaBusy(true);
    try {
      await api.disableMfa(code, currentPassword);
      setMfaLocalState('disabled');
    } catch (requestError) {
      setMfaError(requestError instanceof Error ? requestError.message : 'MFA could not be disabled.');
    } finally {
      setMfaBusy(false);
    }
  }

  async function signInAgain() {
    await logout();
    window.location.assign('/admin/login');
  }

  if (!hasAdminRole) {
    return (
      <>
        <h1>Access denied</h1>
        <Card title="Insufficient permissions">
          <Alert variant="error">Your account does not have admin access.</Alert>
        </Card>
      </>
    );
  }

  const paymentsReady =
    readiness?.payments.paystackEnabled === true || readiness?.payments.stripeEnabled === true;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>System &amp; Security</h1>
          <p className="muted">
            Operational readiness for authentication, communications and fee settlement.
            Secret values are never exposed in this workspace.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={refreshing}
          onClick={() => void load(true)}
        >
          Refresh status
        </Button>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading ? (
        <Card><p className="muted">Checking system readiness…</p></Card>
      ) : readiness ? (
        <div className="stats-grid" style={{ marginBottom: '1.25rem' }}>
          <div className={`stat-card ${readiness.security.mfaReady ? 'stat-card--success' : 'stat-card--warning'}`}>
            <div className="stat-card__label">MFA backend</div>
            <div className="stat-card__value">{readiness.security.mfaReady ? 'Ready' : 'Review'}</div>
            <div className="stat-card__hint">Encrypted TOTP secret + verification pepper</div>
          </div>
          <div className={`stat-card ${readiness.email.ready ? 'stat-card--success' : 'stat-card--warning'}`}>
            <div className="stat-card__label">Email</div>
            <div className="stat-card__value">{readiness.email.ready ? 'Ready' : 'Review'}</div>
            <div className="stat-card__hint">SMTP, sender and web callback configuration</div>
          </div>
          <div className={`stat-card ${readiness.sms.ready ? 'stat-card--success' : 'stat-card--error'}`}>
            <div className="stat-card__label">SMS</div>
            <div className="stat-card__value">{readiness.sms.ready ? 'Ready' : 'Offline'}</div>
            <div className="stat-card__hint">At least one live SMS provider required</div>
          </div>
          <div className={`stat-card ${paymentsReady ? 'stat-card--success' : 'stat-card--warning'}`}>
            <div className="stat-card__label">Fee checkout</div>
            <div className="stat-card__value">{paymentsReady ? 'Ready' : 'Disabled'}</div>
            <div className="stat-card__hint">Production payment-provider enablement</div>
          </div>
        </div>
      ) : null}
      <div className="admin-users-grid">
        <Card title="Admin multi-factor authentication">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '1rem',
              alignItems: 'flex-start',
              marginBottom: '1rem',
            }}
          >
            <div>
              <p style={{ fontWeight: 700, margin: 0 }}>Authenticator protection</p>
              <p className="muted text-sm" style={{ marginTop: '0.3rem' }}>
                TOTP adds a second factor to admin sign-in. Security changes revoke existing sessions.
              </p>
            </div>
            <Badge variant={mfaEnabled ? 'success' : 'warning'}>
              {mfaEnabled ? 'ENABLED' : 'DISABLED'}
            </Badge>
          </div>

          {mfaLocalState !== 'unchanged' ? (
            <Alert variant="success">
              MFA has been {mfaLocalState}. Existing sessions were revoked.
              Sign in again to continue with the new security state.
            </Alert>
          ) : null}
          {mfaError ? <Alert variant="error">{mfaError}</Alert> : null}

          {mfaLocalState !== 'unchanged' ? (
            <Button block onClick={() => void signInAgain()}>Sign in again</Button>
          ) : mfaEnabled ? (
            <>
              <Input
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={disablePassword}
                onChange={(event) => setDisablePassword(event.target.value)}
              />
              <div style={{ marginTop: '0.85rem' }}>
                <Input
                  label="Authenticator code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={disableCode}
                  onChange={(event) =>
                    setDisableCode(event.target.value.replace(/\D/gu, '').slice(0, 6))
                  }
                />
              </div>
              <Button
                variant="danger"
                block
                style={{ marginTop: '1rem' }}
                disabled={!disablePassword || !/^\d{6}$/u.test(disableCode) || mfaBusy}
                onClick={() => setDisableConfirmOpen(true)}
              >
                Disable MFA
              </Button>
            </>
          ) : setup ? (
            <>
              <Alert variant="warning">
                This enrollment secret exists only in page memory. Add it to your
                authenticator before leaving this page.
              </Alert>
              <p className="text-sm muted" style={{ marginTop: '1rem' }}>
                Enrollment secret
              </p>
              <code
                className="break-long"
                style={{
                  display: 'block',
                  padding: '0.75rem',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                {setup.secret}
              </code>
              <p className="text-sm muted" style={{ marginTop: '1rem' }}>
                Authenticator URI
              </p>
              <code
                className="break-long"
                style={{
                  display: 'block',
                  padding: '0.75rem',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                {setup.otpauthUri}
              </code>
              <div style={{ marginTop: '1rem' }}>
                <Input
                  label="Six-digit code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={enrollCode}
                  onChange={(event) =>
                    setEnrollCode(event.target.value.replace(/\D/gu, '').slice(0, 6))
                  }
                />
              </div>
              <Button
                block
                loading={mfaBusy}
                disabled={!/^\d{6}$/u.test(enrollCode) || mfaBusy}
                onClick={() => void enableMfa()}
                style={{ marginTop: '1rem' }}
              >
                Verify &amp; enable MFA
              </Button>
              <Button
                variant="secondary"
                block
                disabled={mfaBusy}
                onClick={() => {
                  setSetup(null);
                  setEnrollCode('');
                  setMfaError(null);
                }}
                style={{ marginTop: '0.65rem' }}
              >
                Cancel enrollment
              </Button>
            </>
          ) : (
            <>
              <Input
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={enrollPassword}
                onChange={(event) => setEnrollPassword(event.target.value)}
              />
              <Button
                block
                loading={mfaBusy}
                disabled={
                  !enrollPassword ||
                  mfaBusy ||
                  readiness?.security.mfaReady !== true
                }
                onClick={() => void beginMfaSetup()}
                style={{ marginTop: '1rem' }}
              >
                Begin MFA setup
              </Button>
              {readiness?.security.mfaReady !== true ? (
                <Alert variant="warning">
                  Server-side MFA key material is not ready, so enrollment is disabled.
                </Alert>
              ) : null}
            </>
          )}
        </Card>

        <Card title="Communications readiness">
          <div style={{ display: 'grid', gap: '0.9rem' }}>
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                }}
              >
                <strong>Email verification &amp; reset</strong>
                {readinessBadge(readiness?.email.ready === true)}
              </div>
              <p className="muted text-sm">
                SMTP: {checkLabel(readiness?.email.smtpConfigured === true)} ·
                {' '}Sender: {checkLabel(readiness?.email.fromAddressConfigured === true)} ·
                {' '}Web URL: {checkLabel(readiness?.email.webBaseUrlConfigured === true)}
              </p>
            </div>

            <div
              style={{
                borderTop: '1px solid var(--border)',
                paddingTop: '0.9rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                }}
              >
                <strong>SMS / phone verification</strong>
                {readinessBadge(readiness?.sms.ready === true)}
              </div>
              <p className="muted text-sm">
                Twilio SID:{' '}
                {readiness?.sms.twilio.accountSidFormatValid
                  ? 'valid format'
                  : 'invalid or placeholder'}
                {' · '}Auth:{' '}
                {readiness?.sms.twilio.authTokenUsable ||
                readiness?.sms.twilio.apiKeyPairUsable
                  ? 'usable'
                  : 'invalid or placeholder'}
                {' · '}Sender:{' '}
                {readiness?.sms.twilio.fromNumberFormatValid
                  ? 'valid E.164'
                  : 'invalid'}
              </p>
              <div className="admin-table-scroll" style={{ marginTop: '0.75rem' }}>
                <table className="admin-table" aria-label="SMS provider readiness">
                  <thead>
                    <tr><th>Provider</th><th>Status</th><th>Coverage</th></tr>
                  </thead>
                  <tbody>
                    {(readiness?.sms.providers ?? []).map((provider) => (
                      <tr key={provider.id}>
                        <td className="admin-table__cell-strong">
                          {provider.displayName}
                        </td>
                        <td>
                          <Badge variant={provider.live ? 'success' : 'warning'}>
                            {provider.live ? 'LIVE' : 'NOT LIVE'}
                          </Badge>
                        </td>
                        <td>{provider.supportedCountries.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Fee settlement readiness">
        <p className="muted" style={{ marginBottom: '1rem' }}>
          Performance-fee calculation can run independently, but customer checkout
          is offered only when a production provider is explicitly enabled.
        </p>
        <div className="stats-grid">
          <div
            className={`stat-card ${readiness?.payments.paystackEnabled
              ? 'stat-card--success'
              : 'stat-card--warning'}`}
          >
            <div className="stat-card__label">Paystack</div>
            <div className="stat-card__value">
              {readiness?.payments.paystackEnabled ? 'Enabled' : 'Disabled'}
            </div>
            <div className="stat-card__hint">Ghana/Africa checkout candidate</div>
          </div>
          <div
            className={`stat-card ${readiness?.payments.stripeEnabled
              ? 'stat-card--success'
              : 'stat-card--warning'}`}
          >
            <div className="stat-card__label">Stripe</div>
            <div className="stat-card__value">
              {readiness?.payments.stripeEnabled ? 'Enabled' : 'Disabled'}
            </div>
            <div className="stat-card__hint">Global card checkout candidate</div>
          </div>
        </div>
        <Alert variant="info">
          Payment redirects never mark invoices paid. A verified server-side
          provider webhook remains the settlement authority.
        </Alert>
      </Card>

      {disableConfirmOpen ? (
        <div
          className="mobile-sheet-overlay"
          onClick={() => !mfaBusy && setDisableConfirmOpen(false)}
        >
          <div
            className="mobile-sheet admin-onboarding-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disable-mfa-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-sheet__header">
              <div>
                <h2 id="disable-mfa-title" className="mobile-sheet__title">
                  Disable admin MFA?
                </h2>
                <p className="muted text-sm" style={{ margin: 0 }}>
                  This weakens sign-in protection and revokes every existing session.
                </p>
              </div>
            </div>
            <div className="admin-onboarding-modal__body">
              <Alert variant="warning">
                You will be signed out everywhere and must sign in again with only
                your password.
              </Alert>
              <div
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  marginTop: '1rem',
                  flexWrap: 'wrap',
                }}
              >
                <Button
                  variant="secondary"
                  disabled={mfaBusy}
                  onClick={() => setDisableConfirmOpen(false)}
                >
                  Keep MFA enabled
                </Button>
                <Button
                  variant="danger"
                  loading={mfaBusy}
                  onClick={() => void disableMfa()}
                >
                  Disable MFA
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
