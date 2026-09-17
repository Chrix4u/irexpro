'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createEligibilityApi } from '@irexpro/api-client/eligibility';
import type {
  EligibilityDisclosureKey,
  EligibilityStatusView,
} from '@irexpro/types/eligibility';
import { Alert, Badge, Button, Card, DashboardShell } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';
import { mapApiError } from '@/lib/error-mapping';

const eligibilityApi = createEligibilityApi(api);

function jurisdictionCopy(status: EligibilityStatusView) {
  switch (status.jurisdictionStatus) {
    case 'ELIGIBLE':
      return {
        variant: 'success' as const,
        label: 'Jurisdiction eligible',
        text: 'Your current jurisdiction has passed the active policy or an authorised review.',
      };
    case 'REVIEW_REQUIRED':
      return {
        variant: 'warning' as const,
        label: 'Review required',
        text: 'Your jurisdiction requires an authorised compliance review before readiness can be completed.',
      };
    case 'INELIGIBLE':
      return {
        variant: 'error' as const,
        label: 'Not eligible',
        text: 'The service cannot be enabled for the jurisdiction currently recorded on your account.',
      };
    default:
      return {
        variant: 'warning' as const,
        label: 'Country required',
        text: 'Complete your profile with a valid country code before jurisdiction eligibility can be determined.',
      };
  }
}

function identityCopy(status: EligibilityStatusView) {
  if (status.ageStatus === 'UNDER_18') {
    return {
      variant: 'error' as const,
      label: 'Adult-age requirement not met',
      text: 'This account cannot complete readiness because the service is restricted to adults age 18 or older.',
    };
  }
  if (status.ageStatus === 'MISSING_DOB') {
    return {
      variant: 'warning' as const,
      label: 'Date of birth required',
      text: 'Add a date of birth to your profile so the server can evaluate the adult-age requirement.',
    };
  }
  if (status.ageStatus === 'INVALID_DOB') {
    return {
      variant: 'error' as const,
      label: 'Date of birth needs correction',
      text: 'The stored date of birth is not valid. Update the profile before readiness can continue.',
    };
  }
  switch (status.kycStatus) {
    case 'APPROVED':
      return {
        variant: 'success' as const,
        label: 'Identity review approved',
        text: 'The adult-age requirement and the current KYC review state are approved.',
      };
    case 'PENDING':
      return {
        variant: 'warning' as const,
        label: 'KYC review pending',
        text: 'An authorised compliance review is still pending. Readiness remains blocked until it is approved.',
      };
    case 'REJECTED':
      return {
        variant: 'error' as const,
        label: 'KYC review not approved',
        text: 'The current KYC review is not approved. Readiness remains blocked.',
      };
    default:
      return {
        variant: 'warning' as const,
        label: 'KYC review required',
        text: 'An authorised compliance review is required before readiness can be completed.',
      };
  }
}

export default function EligibilityOnboardingPage() {
  const router = useRouter();
  const { user, logout, restoring } = useAuth();
  const [status, setStatus] = useState<EligibilityStatusView | null>(null);
  const [selected, setSelected] = useState<Set<EligibilityDisclosureKey>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const next = await eligibilityApi.getMyStatus();
      setStatus(next);
      setSelected(new Set());
    } catch (err) {
      setError(mapApiError(err).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const acceptedKeys = useMemo(
    () => new Set(status?.consents.map((item) => item.key) ?? []),
    [status],
  );

  if (restoring) {
    return (
      <div style={{ padding: '3rem' }}>
        <p className="muted">Restoring session…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '620px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">You need to log in to complete eligibility onboarding.</p>
          <Link href="/login" className="btn btn--primary mt-4" style={{ display: 'inline-block' }}>
            Go to login
          </Link>
        </Card>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!status) return;
    setError(null);
    setMessage(null);

    if (status.ageStatus !== 'ADULT') {
      setError('The adult-age requirement must be satisfied before disclosure evidence can be recorded.');
      return;
    }

    const missing = status.disclosures.filter((item) => !acceptedKeys.has(item.key));
    if (missing.some((item) => !selected.has(item.key))) {
      setError('Review and accept every outstanding required disclosure before continuing.');
      return;
    }

    if (missing.length === 0) {
      if (status.canProceed) router.push('/onboarding/broker');
      return;
    }

    setSaving(true);
    try {
      const next = await eligibilityApi.acceptDisclosures({
        policyVersion: status.policyVersion,
        policyFingerprint: status.policyFingerprint,
        acceptances: missing.map((item) => ({
          key: item.key,
          version: item.version,
          contentSha256: item.contentSha256,
        })),
      });
      setStatus(next);
      setSelected(new Set());
      if (next.canProceed) {
        setMessage('Eligibility evidence is complete. Continuing to broker connection…');
        router.push('/onboarding/broker');
      } else if (next.jurisdictionStatus === 'REVIEW_REQUIRED') {
        setMessage('Disclosure evidence is recorded. Jurisdiction review is still required.');
      } else if (next.kycStatus !== 'APPROVED') {
        setMessage('Disclosure evidence is recorded. Identity/KYC review is still required.');
      } else {
        setMessage('Disclosure evidence is recorded. Readiness remains unavailable.');
      }
    } catch (err) {
      setError(mapApiError(err).message);
    } finally {
      setSaving(false);
    }
  }

  const jCopy = status ? jurisdictionCopy(status) : null;
  const iCopy = status ? identityCopy(status) : null;
  const profileNeedsDob = status?.ageStatus === 'MISSING_DOB' || status?.ageStatus === 'INVALID_DOB';
  const disclosuresDisabled = status?.ageStatus !== 'ADULT' || status?.jurisdictionStatus === 'INELIGIBLE';

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/onboarding/eligibility">
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <Badge variant="info">Step 2 of 3</Badge>
        <h1 style={{ margin: 'var(--space-3) 0 var(--space-2)' }}>Eligibility & disclosures</h1>
        <p className="muted" style={{ maxWidth: '780px', lineHeight: 1.65 }}>
          Readiness is server-authoritative: adult age, KYC status, jurisdiction policy, and exact
          disclosure consent must all pass. A self-attestation never overrides these checks.
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {message && <Alert variant="success">{message}</Alert>}

      {loading && (
        <Card>
          <p className="muted">Loading current eligibility and identity readiness…</p>
        </Card>
      )}

      {!loading && !status && (
        <Card>
          <h2 className="card__title">Eligibility unavailable</h2>
          <p className="muted">
            The platform could not verify a safe eligibility contract. No previous status is being reused.
          </p>
          <Button type="button" onClick={() => void load()} style={{ marginTop: 'var(--space-4)' }}>
            Retry
          </Button>
        </Card>
      )}

      {status && jCopy && iCopy && (
        <form onSubmit={submit}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
              gap: 'var(--space-4)',
              marginBottom: 'var(--space-5)',
            }}
          >
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <p className="eyebrow">Jurisdiction gate</p>
                  <h2 className="card__title">{jCopy.label}</h2>
                </div>
                <Badge variant={jCopy.variant}>{status.jurisdictionStatus.replaceAll('_', ' ')}</Badge>
              </div>
              <p className="muted" style={{ lineHeight: 1.6 }}>{jCopy.text}</p>
              <dl style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
                <div><strong>Country:</strong> {status.countryCode ?? 'Not provided'}</div>
                <div><strong>Policy:</strong> {status.policyVersion}</div>
                <div><strong>Policy fingerprint:</strong> {status.policyFingerprint.slice(0, 12)}…</div>
                <div><strong>Decision source:</strong> {status.decisionSource.replaceAll('_', ' ')}</div>
                <div><strong>Reason:</strong> {status.reasonCode.replaceAll('_', ' ')}</div>
              </dl>
            </Card>

            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <p className="eyebrow">Identity gate</p>
                  <h2 className="card__title">{iCopy.label}</h2>
                </div>
                <Badge variant={iCopy.variant}>{status.kycStatus.replaceAll('_', ' ')}</Badge>
              </div>
              <p className="muted" style={{ lineHeight: 1.6 }}>{iCopy.text}</p>
              <dl style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
                <div><strong>Age check:</strong> {status.ageStatus.replaceAll('_', ' ')}</div>
                <div><strong>KYC state:</strong> {status.kycStatus.replaceAll('_', ' ')}</div>
                <div><strong>Reason:</strong> {status.identityReasonCode.replaceAll('_', ' ')}</div>
              </dl>
              {profileNeedsDob && (
                <Link href="/onboarding/profile" className="btn btn--secondary" style={{ display: 'inline-block', marginTop: 'var(--space-4)' }}>
                  Update profile
                </Link>
              )}
            </Card>

            <Card>
              <p className="eyebrow">Readiness evidence</p>
              <h2 className="card__title">
                {status.missingConsentKeys.length === 0
                  ? 'Disclosures complete'
                  : `${status.missingConsentKeys.length} disclosures outstanding`}
              </h2>
              <p className="muted" style={{ lineHeight: 1.6 }}>
                Acceptance is bound to the active policy fingerprint and the SHA-256 digest of each exact disclosure copy. A policy change requires fresh evidence.
              </p>
              <div style={{ marginTop: 'var(--space-4)' }}>
                <Badge variant={status.canProceed ? 'success' : 'warning'}>
                  {status.canProceed ? 'Eligibility gate complete' : 'Readiness blocked'}
                </Badge>
              </div>
            </Card>
          </div>

          <Card>
            <h2 className="card__title">Required disclosures</h2>
            <p className="card__subtitle">
              Read each item carefully. Disclosure consent cannot override adult-age, KYC, or jurisdiction restrictions.
            </p>

            <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-5)' }}>
              {status.disclosures.map((item) => {
                const accepted = acceptedKeys.has(item.key);
                const checked = accepted || selected.has(item.key);
                return (
                  <label
                    key={item.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto minmax(0, 1fr)',
                      gap: 'var(--space-3)',
                      alignItems: 'start',
                      padding: 'var(--space-4)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-lg)',
                      cursor: accepted || disclosuresDisabled ? 'default' : 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={accepted || saving || disclosuresDisabled}
                      onChange={(event) => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(item.key);
                          else next.delete(item.key);
                          return next;
                        });
                      }}
                      style={{ marginTop: '0.25rem' }}
                    />
                    <span>
                      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                        <strong>{item.title}</strong>
                        <Badge variant={accepted ? 'success' : 'info'}>
                          {accepted ? 'Accepted' : `Version ${item.version}`}
                        </Badge>
                      </span>
                      <span className="muted" style={{ display: 'block', marginTop: 'var(--space-2)', lineHeight: 1.65 }}>
                        {item.body}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-6)' }}>
              {!disclosuresDisabled && status.missingConsentKeys.length > 0 && (
                <Button type="submit" size="lg" loading={saving}>
                  {saving ? 'Recording evidence…' : 'Accept required disclosures'}
                </Button>
              )}
              {status.canProceed && (
                <Button type="button" size="lg" onClick={() => router.push('/onboarding/risk')}>
                  Continue to next step
                </Button>
              )}
              <Button type="button" variant="secondary" onClick={() => void load()} disabled={saving}>
                Refresh status
              </Button>
            </div>
          </Card>

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-4)' }}>
            <Link href="/onboarding/profile" className="text-sm">← Back to profile</Link>
            <span className="muted text-sm">All readiness gates must be complete before the account can proceed.</span>
          </div>
        </form>
      )}
    </DashboardShell>
  );
}
