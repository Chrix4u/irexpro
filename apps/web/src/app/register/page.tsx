'use client';

import { useState, FormEvent, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { AuthLayout, Button, Input, Alert } from '@/components/ui';
import { CountryCodeSelector } from '@/components/country-code-selector';

export default function RegisterPage() {
  const router = useRouter();
  const { register, loading, restoring, error, clearError, user, accessToken } = useAuth();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [countryCode, setCountryCode] = useState('GH');
  const [callingCode, setCallingCode] = useState('+233');
  const [rememberMe, setRememberMe] = useState(false);

  useEffect(() => {
    if (!restoring && user && accessToken) router.replace('/dashboard');
  }, [user, accessToken, restoring, router]);

  if (restoring) {
    return <AuthLayout title="Create account"><p className="loading-text">Restoring session…</p></AuthLayout>;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const fullPhone = phone ? `${callingCode}${phone}` : undefined;
    try {
      await register(email, password, {
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        countryCode,
        phone: fullPhone,
        rememberMe,
      });
      router.push('/dashboard');
    } catch { /* error in context */ }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Start trading with AI-powered risk-gated execution">
      <form onSubmit={handleSubmit}>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="register-name-row">
          <Input label="First name" type="text" placeholder="John" value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={loading} />
          <Input label="Last name" type="text" placeholder="Doe" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={loading} />
        </div>
        <Input
          label="Email (optional if phone provided)"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => { setEmail(e.target.value); clearError(); }}
          disabled={loading}
        />
        <CountryCodeSelector
          value={countryCode}
          onChange={(code, cc) => { setCountryCode(code); setCallingCode(cc); }}
          disabled={loading}
        />
        <Input
          label="Phone (optional if email provided)"
          type="tel"
          placeholder={`${callingCode} 24 123 4567`}
          value={phone}
          onChange={(e) => { setPhone(e.target.value); clearError(); }}
          disabled={loading}
        />
        <Input label="Password" type="password" placeholder="••••••••" value={password} onChange={(e) => { setPassword(e.target.value); clearError(); }} disabled={loading} required minLength={8} autoComplete="new-password" />
        <p className="muted text-sm" style={{ marginBottom: '1rem' }}>
          8+ chars with uppercase, lowercase, number, and special char (@$!%*?&).
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '1rem' }}>
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            disabled={loading}
            style={{ width: '16px', height: '16px', accentColor: 'var(--brand)' }}
          />
          <span className="text-sm muted">Remember me</span>
        </label>
        <Button type="submit" block size="lg" loading={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <div className="auth-divider">or</div>
      <div className="auth-links">
        Already have an account? <Link href="/login">Log in</Link>
      </div>
    </AuthLayout>
  );
}
