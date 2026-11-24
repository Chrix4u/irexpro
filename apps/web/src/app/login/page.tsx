'use client';

import { useState, FormEvent, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { AuthLayout, Button, Input, Alert } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, restoring, error, clearError, user, accessToken } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [expiredNotice, setExpiredNotice] = useState(false);
  useEffect(() => {
    setExpiredNotice(new URLSearchParams(window.location.search).get('reason') === 'session-expired');
  }, []);

  useEffect(() => {
    if (!restoring && user && accessToken) {
      router.replace('/dashboard');
    }
  }, [user, accessToken, restoring, router]);

  if (restoring) {
    return (
      <AuthLayout title="Log in">
        <p className="loading-text">Restoring session…</p>
      </AuthLayout>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await login(identifier, password, rememberMe, mfaCode || undefined);
      router.push('/dashboard');
    } catch { /* error in context */ }
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Log in to your iRexPro account">
      <form onSubmit={handleSubmit}>
        {error && <Alert variant="error">{error}</Alert>}
        {!error && expiredNotice && <Alert variant="warning">Your session has expired. Please sign in again.</Alert>}
        <Input
          label="Email or international phone number"
          type="text"
          placeholder="you@example.com or +233241234567"
          value={identifier}
          onChange={(e) => { setIdentifier(e.target.value); clearError(); }}
          disabled={loading}
          required
          autoComplete="username"
        />
        <Input
          label="Password"
          type="password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => { setPassword(e.target.value); clearError(); }}
          disabled={loading}
          required
          autoComplete="current-password"
        />
        <Input
          label="Authenticator code (if enabled)"
          type="text"
          placeholder="123456"
          value={mfaCode}
          onChange={(e) => {
            setMfaCode(e.target.value.replace(/\D/gu, '').slice(0, 6));
            clearError();
          }}
          disabled={loading}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          aria-describedby="login-mfa-help"
        />
        <p id="login-mfa-help" className="text-sm muted" style={{ marginTop: '-0.5rem', marginBottom: '1rem' }}>
          If multi-factor authentication is enabled, enter the current 6-digit code from your authenticator app. Leave this blank otherwise.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={loading}
              style={{ width: '16px', height: '16px', accentColor: 'var(--brand)' }}
            />
            <span className="text-sm muted">Remember me</span>
          </label>
          <Link href="/forgot-password" className="text-sm">Forgot password?</Link>
        </div>
        <Button type="submit" block size="lg" loading={loading}>
          {loading ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      <div className="auth-links" style={{ marginTop: '1rem' }}>
        Can&apos;t access your account? <Link href="/account-appeal">Request a review</Link>
      </div>
      <div className="auth-divider">or</div>
      <div className="auth-links">
        Don&apos;t have an account? <Link href="/register">Create one</Link>
      </div>
    </AuthLayout>
  );
}
