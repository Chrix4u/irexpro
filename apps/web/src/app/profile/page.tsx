'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MyProfileView } from '@irexpro/types';
import type { EligibilityStatusView } from '@irexpro/types/eligibility';
import { createEligibilityApi } from '@irexpro/api-client/eligibility';
import { Alert, Badge, Button, Card, DashboardShell, Input, LoadingSpinner } from '@/components/ui';
import { TimezoneSelect } from '@/components/forms/TimezoneSelect';
import { useAuth } from '@/context/auth-context';
import { useNotification } from '@/hooks/useNotification';
import { api } from '@/lib/api';
import { mapApiError } from '@/lib/error-mapping';

const eligibilityApi = createEligibilityApi(api);

function kycVariant(status: EligibilityStatusView['kycStatus'] | undefined) {
  if (status === 'APPROVED') return 'success' as const;
  if (status === 'REJECTED') return 'error' as const;
  if (status === 'PENDING') return 'warning' as const;
  return 'info' as const;
}

function kycLabel(status: EligibilityStatusView['kycStatus'] | undefined) {
  if (!status || status === 'NONE') return 'Not submitted';
  if (status === 'PENDING') return 'Pending review';
  if (status === 'APPROVED') return 'Approved';
  return 'Rejected';
}

export default function ProfilePage() {
  const router = useRouter();
  const { user, logout, refreshUser, restoring } = useAuth();
  const notify = useNotification();

  const [profile, setProfile] = useState<MyProfileView | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [submittingKyc, setSubmittingKyc] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [timezone, setTimezone] = useState('');
  const [preferredCurrency, setPreferredCurrency] = useState('USD');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const applyProfile = useCallback((value: MyProfileView) => {
    setProfile(value);
    setFirstName(value.profile.firstName ?? '');
    setLastName(value.profile.lastName ?? '');
    setDateOfBirth(value.profile.dateOfBirth ?? '');
    setCountryCode(value.countryCode ?? '');
    setTimezone(value.timezone ?? '');
    setPreferredCurrency(value.preferredCurrency ?? 'USD');
  }, []);

  const loadAccount = useCallback(async () => {
    const [profileResponse, eligibilityResponse] = await Promise.all([
      api.getMyProfile(),
      eligibilityApi.getMyStatus(),
    ]);
    applyProfile(profileResponse);
    setEligibility(eligibilityResponse);
  }, [applyProfile]);

  useEffect(() => {
    if (!user) {
      if (!restoring) setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [profileResponse, eligibilityResponse] = await Promise.all([
          api.getMyProfile(),
          eligibilityApi.getMyStatus(),
        ]);
        if (cancelled) return;
        applyProfile(profileResponse);
        setEligibility(eligibilityResponse);
      } catch (requestError) {
        if (!cancelled) setError(mapApiError(requestError).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, restoring, applyProfile]);

  async function handleProfileSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!dateOfBirth) {
      setError('Please provide your date of birth.');
      return;
    }

    setSavingProfile(true);
    try {
      const updated = await api.updateMyProfile({
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        dateOfBirth,
        countryCode: countryCode.trim().toUpperCase() || undefined,
        timezone: timezone || undefined,
        preferredCurrency: preferredCurrency.trim().toUpperCase() || undefined,
      });
      applyProfile(updated);
      await Promise.all([refreshUser(), loadAccount()]);
      notify.success('Profile updated successfully.');
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleKycSubmission() {
    setError(null);
    setSubmittingKyc(true);
    try {
      const status = await eligibilityApi.submitKyc();
      setEligibility(status);
      notify.success('KYC submitted for review.');
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setSubmittingKyc(false);
    }
  }

  async function handlePasswordChange(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (currentPassword === newPassword) {
      setError('Choose a new password that is different from your current password.');
      return;
    }

    setChangingPassword(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      notify.success('Password changed. Sign in again with your new password.');
      await logout();
      router.replace('/login');
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
      setChangingPassword(false);
    }
  }

  if (restoring || loading) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Loading your profile…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '600px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to manage your profile and identity verification.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/profile" title="My Profile">
      <main className="workspace-page" aria-labelledby="profile-center-title">
        <section className="workspace-hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">Account · identity & security</p>
            <h1 id="profile-center-title" className="workspace-hero__title">My Profile</h1>
            <p className="workspace-hero__description">
              Manage your personal details, KYC review status, password and account-security settings from one place.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Badge variant={kycVariant(eligibility?.kycStatus)}>
              KYC · {kycLabel(eligibility?.kycStatus)}
            </Badge>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

        <section className="workspace-grid-2">
          <Card title="Identity & contact" subtitle="Contact verification is managed through the Security Center.">
            <div className="workspace-kv-list">
              <div className="workspace-kv-row">
                <span className="text-sm muted">Email</span>
                <strong>{profile?.email ?? 'Not provided'}</strong>
              </div>
              <div className="workspace-kv-row">
                <span className="text-sm muted">Email verification</span>
                <Badge variant={profile?.emailVerifiedAt ? 'success' : 'warning'}>
                  {profile?.emailVerifiedAt ? 'Verified' : 'Not verified'}
                </Badge>
              </div>
              <div className="workspace-kv-row">
                <span className="text-sm muted">Phone</span>
                <strong>{profile?.phone ?? 'Not provided'}</strong>
              </div>
              <div className="workspace-kv-row">
                <span className="text-sm muted">Phone verification</span>
                <Badge variant={profile?.phoneVerifiedAt ? 'success' : 'warning'}>
                  {profile?.phoneVerifiedAt ? 'Verified' : 'Not verified'}
                </Badge>
              </div>
              <div className="workspace-kv-row">
                <span className="text-sm muted">Multi-factor authentication</span>
                <Badge variant={profile?.mfaEnabled ? 'success' : 'info'}>
                  {profile?.mfaEnabled ? 'Enabled' : 'Not enabled'}
                </Badge>
              </div>
            </div>
            <div className="workspace-actions mt-4">
              <Link href="/security" className="btn btn--secondary">Open Security Center</Link>
            </div>
          </Card>

          <Card title="KYC review" subtitle="KYC approval is performed by an authorized reviewer; users cannot self-approve identity verification.">
            <div className="workspace-kv-list">
              <div className="workspace-kv-row">
                <span className="text-sm muted">Status</span>
                <Badge variant={kycVariant(eligibility?.kycStatus)}>
                  {kycLabel(eligibility?.kycStatus)}
                </Badge>
              </div>
              <div className="workspace-kv-row">
                <span className="text-sm muted">Age requirement</span>
                <strong>{eligibility?.ageStatus?.replaceAll('_', ' ') ?? 'Not available'}</strong>
              </div>
              <div className="workspace-kv-row">
                <span className="text-sm muted">Jurisdiction</span>
                <strong>{eligibility?.jurisdictionStatus?.replaceAll('_', ' ') ?? 'Not available'}</strong>
              </div>
            </div>

            {eligibility?.kycStatus === 'NONE' && (
              <div className="mt-4">
                <Alert variant="info">
                  Submit your completed identity profile for KYC review. This records a review request; it does not mark your identity as verified.
                </Alert>
                <Button
                  type="button"
                  className="mt-4"
                  loading={submittingKyc}
                  disabled={submittingKyc || eligibility.ageStatus !== 'ADULT'}
                  onClick={() => void handleKycSubmission()}
                >
                  Submit KYC for review
                </Button>
              </div>
            )}

            {eligibility?.kycStatus === 'PENDING' && (
              <div className="mt-4">
                <Alert variant="info">
                  Your KYC submission is pending administrator review. Trading readiness remains restricted until approval is recorded.
                </Alert>
              </div>
            )}

            {eligibility?.kycStatus === 'APPROVED' && (
              <div className="mt-4">
                <Alert variant="success">
                  Your identity review is approved for the current date-of-birth record.
                </Alert>
              </div>
            )}

            {eligibility?.kycStatus === 'REJECTED' && (
              <div className="mt-4">
                <Alert variant="error">
                  Your current identity record was rejected. Review your profile information and contact support for the required correction before another review.
                </Alert>
              </div>
            )}
          </Card>
        </section>

        <Card title="Personal profile" subtitle="Changing your date of birth invalidates previous KYC approval and requires a new review.">
          <form onSubmit={handleProfileSubmit} className="onboarding-form">
            <section className="form-section">
              <h3 className="form-section__title">Personal information</h3>
              <div className="workspace-form-grid workspace-form-grid--3">
                <Input
                  label="First name"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  disabled={savingProfile}
                  placeholder="John"
                />
                <Input
                  label="Last name"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  disabled={savingProfile}
                  placeholder="Doe"
                />
                <Input
                  label="Date of birth"
                  type="date"
                  value={dateOfBirth}
                  onChange={(event) => setDateOfBirth(event.target.value)}
                  disabled={savingProfile}
                  required
                />
              </div>
            </section>

            <section className="form-section">
              <h3 className="form-section__title">Regional preferences</h3>
              <div className="workspace-form-grid workspace-form-grid--3">
                <div>
                  <Input
                    label="Country code"
                    value={countryCode}
                    onChange={(event) => setCountryCode(event.target.value)}
                    disabled={savingProfile}
                    maxLength={2}
                    placeholder="GH"
                  />
                  <p className="helper-text">ISO 3166-1 alpha-2, for example GH, US or GB.</p>
                </div>
                <TimezoneSelect
                  value={timezone}
                  onChange={setTimezone}
                  label="Timezone"
                  disabled={savingProfile}
                />
                <div>
                  <Input
                    label="Preferred currency"
                    value={preferredCurrency}
                    onChange={(event) => setPreferredCurrency(event.target.value)}
                    disabled={savingProfile}
                    maxLength={3}
                    placeholder="USD"
                  />
                  <p className="helper-text">ISO 4217 code, for example USD, GHS or EUR.</p>
                </div>
              </div>
            </section>


            <div className="workspace-actions">
              <Button type="submit" size="lg" loading={savingProfile}>
                Save profile
              </Button>
            </div>
          </form>
        </Card>

        <Card title="Password" subtitle="Changing your password revokes existing sessions. You will sign in again after the change.">
          <form onSubmit={handlePasswordChange} className="onboarding-form">
            <div className="workspace-form-grid workspace-form-grid--3">
              <Input
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={changingPassword}
                required
              />
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={changingPassword}
                minLength={12}
                required
              />
              <Input
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={changingPassword}
                minLength={12}
                required
              />
            </div>
            <p className="helper-text">
              Use 12–128 characters with at least one letter and one number.
            </p>
            <div className="workspace-actions">
              <Button type="submit" loading={changingPassword}>
                Change password
              </Button>
            </div>
            <div className="workspace-actions mt-3">
              <Link href="/forgot-password" className="btn btn--secondary">
                Forgot current password?
              </Link>
            </div>
          </form>
        </Card>
      </main>
    </DashboardShell>
  );
}
