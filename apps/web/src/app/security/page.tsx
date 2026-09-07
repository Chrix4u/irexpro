'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import {
  Alert,
  Badge,
  Button,
  Card,
  DashboardShell,
  Input,
  LoadingSpinner,
} from '@/components/ui';
import type { MfaSetupResponse } from '@irexpro/types';

function numericCode(value: string): string {
  return value.replace(/\D/gu, '').slice(0, 6);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message && !error.message.includes('fetch')) {
    return error.message;
  }
  return fallback;
}

export default function SecurityPage() {
  const router = useRouter();
  const { user, restoring, logout, refreshUser } = useAuth();

  const [mfaSetup, setMfaSetup] = useState<MfaSetupResponse | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaMessage, setMfaMessage] = useState<string | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);

  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMessage, setEmailMessage] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [phoneRequested, setPhoneRequested] = useState(false);
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  if (restoring) {
    return <LoadingSpinner text="Restoring security settings…" />;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 620, margin: '0 auto' }}>
        <Card title="Sign in required">
          <p className="muted">Sign in to review or change account security settings.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  async function beginMfaSetup(event: FormEvent) {
    event.preventDefault();
    if (!mfaPassword) return;

    setMfaBusy(true);
    setMfaError(null);
    setMfaMessage(null);
    setMfaSetup(null);
    setMfaCode('');

    const currentPassword = mfaPassword;
    setMfaPassword('');

    try {
      const setup = await api.beginMfaSetup(currentPassword);
      setMfaSetup(setup);
      setMfaMessage('Add this account to your authenticator app, then confirm a current 6-digit code.');
    } catch (error) {
      setMfaError(errorMessage(error, 'Unable to start multi-factor authentication setup.'));
    } finally {
      setMfaBusy(false);
    }
  }

  async function enableMfa(event: FormEvent) {
    event.preventDefault();
    if (mfaCode.length !== 6) return;
    setMfaBusy(true);
    setMfaError(null);
    setMfaMessage(null);
    try {
      await api.enableMfa(mfaCode);
      // The backend intentionally increments sessionVersion when MFA changes.
      // Clear any now-stale local session and require a fresh MFA-capable login.
      setMfaSetup(null);
      setMfaCode('');
      await logout();
      router.replace('/login');
    } catch (error) {
      setMfaError(errorMessage(error, 'Unable to enable multi-factor authentication.'));
    } finally {
      setMfaBusy(false);
    }
  }

  async function disableMfa(event: FormEvent) {
    event.preventDefault();
    if (mfaCode.length !== 6 || !mfaPassword) return;
    setMfaBusy(true);
    setMfaError(null);
    setMfaMessage(null);
    try {
      await api.disableMfa(mfaCode, mfaPassword);
      setMfaCode('');
      setMfaPassword('');
      await logout();
      router.replace('/login');
    } catch (error) {
      setMfaError(errorMessage(error, 'Unable to disable multi-factor authentication.'));
    } finally {
      setMfaBusy(false);
    }
  }

  async function requestEmailVerification() {
    setEmailBusy(true);
    setEmailError(null);
    setEmailMessage(null);
    try {
      const response = await api.requestEmailVerification();
      setEmailMessage(response.message);
    } catch (error) {
      setEmailError(errorMessage(error, 'Unable to request email verification.'));
    } finally {
      setEmailBusy(false);
    }
  }

  async function requestPhoneVerification() {
    setPhoneBusy(true);
    setPhoneError(null);
    setPhoneMessage(null);
    setPhoneCode('');
    try {
      const response = await api.requestPhoneVerification();
      setPhoneRequested(true);
      setPhoneMessage(response.message);
    } catch (error) {
      setPhoneError(errorMessage(error, 'Unable to request phone verification.'));
    } finally {
      setPhoneBusy(false);
    }
  }

  async function confirmPhoneVerification(event: FormEvent) {
    event.preventDefault();
    if (phoneCode.length !== 6) return;
    setPhoneBusy(true);
    setPhoneError(null);
    setPhoneMessage(null);
    try {
      const response = await api.confirmPhoneVerification(phoneCode);
      setPhoneCode('');
      setPhoneRequested(false);
      await refreshUser();
      setPhoneMessage(response.message);
    } catch (error) {
      setPhoneError(errorMessage(error, 'Invalid or expired verification code.'));
    } finally {
      setPhoneBusy(false);
    }
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/security" title="Account Security">
      <main style={{ display: 'grid', gap: '1rem', maxWidth: 900 }}>
        <section aria-labelledby="security-heading">
          <p className="muted" style={{ marginBottom: '0.35rem' }}>Identity & access</p>
          <h1 id="security-heading">Account Security</h1>
          <p className="muted" style={{ marginTop: '0.5rem' }}>
            Manage sign-in protection and verify the contact methods attached to your account.
          </p>
        </section>

        <Card title="Multi-factor authentication" subtitle="Protect sign-in with a time-based authenticator code.">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <strong>Status</strong>
            <Badge variant={user.mfaEnabled ? 'success' : 'warning'}>
              {user.mfaEnabled ? 'Enabled' : 'Not enabled'}
            </Badge>
          </div>
          {mfaError && <Alert variant="error">{mfaError}</Alert>}
          {mfaMessage && <Alert variant="info">{mfaMessage}</Alert>}

          {!user.mfaEnabled && !mfaSetup && (
            <form onSubmit={beginMfaSetup}>
              <Alert variant="info">
                Confirm your current password before generating authenticator setup material.
              </Alert>
              <Input
                label="Current password"
                type="password"
                value={mfaPassword}
                onChange={(event) => setMfaPassword(event.target.value)}
                autoComplete="current-password"
                required
                disabled={mfaBusy}
              />
              <Button type="submit" loading={mfaBusy} disabled={!mfaPassword}>
                Start authenticator setup
              </Button>
            </form>
          )}

          {!user.mfaEnabled && mfaSetup && (
            <form onSubmit={enableMfa}>
              <Alert variant="warning">
                Keep this setup material private. It is shown only for this enrollment attempt and is not stored by the browser UI.
              </Alert>
              <div style={{ margin: '1rem 0' }}>
                <p className="text-sm muted" style={{ marginBottom: '0.35rem' }}>Manual setup key</p>
                <code style={{ overflowWrap: 'anywhere' }}>{mfaSetup.secret}</code>
              </div>
              <p style={{ marginBottom: '1rem' }}>
                <a href={mfaSetup.otpauthUri}>Open in authenticator app</a>
              </p>
              <Input
                label="6-digit authenticator code"
                value={mfaCode}
                onChange={(event) => setMfaCode(numericCode(event.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                disabled={mfaBusy}
              />
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Button type="submit" loading={mfaBusy} disabled={mfaCode.length !== 6}>
                  Enable MFA
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={mfaBusy}
                  onClick={() => {
                    setMfaSetup(null);
                    setMfaCode('');
                    setMfaPassword('');
                    setMfaMessage(null);
                  }}
                >
                  Cancel setup
                </Button>
              </div>
            </form>
          )}

          {user.mfaEnabled && (
            <form onSubmit={disableMfa}>
              <Alert variant="warning">
                Disabling MFA requires your current password and authenticator code. All existing sessions will be revoked.
              </Alert>
              <Input
                label="Current password"
                type="password"
                value={mfaPassword}
                onChange={(event) => setMfaPassword(event.target.value)}
                autoComplete="current-password"
                required
                disabled={mfaBusy}
              />
              <Input
                label="Current 6-digit authenticator code"
                value={mfaCode}
                onChange={(event) => setMfaCode(numericCode(event.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                disabled={mfaBusy}
              />
              <Button
                type="submit"
                variant="danger"
                loading={mfaBusy}
                disabled={mfaCode.length !== 6 || !mfaPassword}
              >
                Disable MFA
              </Button>
            </form>
          )}
        </Card>

        <Card title="Email verification" subtitle="Confirm the email address registered on your account.">
          {!user.email ? (
            <Alert variant="info">No email address is registered on this account.</Alert>
          ) : user.emailVerified ? (
            <Alert variant="success">Your email address is verified.</Alert>
          ) : (
            <>
              <p className="muted" style={{ marginBottom: '1rem', overflowWrap: 'anywhere' }}>
                Verification pending for {user.email}.
              </p>
              {emailError && <Alert variant="error">{emailError}</Alert>}
              {emailMessage && <Alert variant="info">{emailMessage}</Alert>}
              <Button onClick={requestEmailVerification} loading={emailBusy}>
                Send verification email
              </Button>
            </>
          )}
        </Card>

        <Card title="Phone verification" subtitle="Confirm the international phone number registered on your account.">
          {!user.phone ? (
            <Alert variant="info">No phone number is registered on this account.</Alert>
          ) : user.phoneVerified ? (
            <Alert variant="success">Your phone number is verified.</Alert>
          ) : (
            <>
              <p className="muted" style={{ marginBottom: '1rem', overflowWrap: 'anywhere' }}>
                Verification pending for {user.phone}.
              </p>
              {phoneError && <Alert variant="error">{phoneError}</Alert>}
              {phoneMessage && <Alert variant="info">{phoneMessage}</Alert>}
              {!phoneRequested ? (
                <Button onClick={requestPhoneVerification} loading={phoneBusy}>
                  Send verification code
                </Button>
              ) : (
                <form onSubmit={confirmPhoneVerification}>
                  <Input
                    label="6-digit SMS verification code"
                    value={phoneCode}
                    onChange={(event) => setPhoneCode(numericCode(event.target.value))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    disabled={phoneBusy}
                  />
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <Button type="submit" loading={phoneBusy} disabled={phoneCode.length !== 6}>
                      Confirm phone
                    </Button>
                    <Button type="button" variant="secondary" onClick={requestPhoneVerification} disabled={phoneBusy}>
                      Send a new code
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </Card>
      </main>
    </DashboardShell>
  );
}
