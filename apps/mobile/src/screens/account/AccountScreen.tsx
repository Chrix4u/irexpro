import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MfaSetupResponse } from '@irexpro/types';
import { useAuth } from '@/context/auth-context';
import {
  Banner,
  Card,
  Divider,
  StatusPill,
  palette,
} from '@/components/ui';
import { api } from '@/lib/api';
import {
  accountSecurityError,
  beginMfaSetup,
  isSixDigitCode,
} from '@/lib/account-security';
import {
  accountStatusMeta,
  deriveInitials,
} from '@/lib/account-security-logic';
import PersonalInformationScreen from '@/screens/account/PersonalInformationScreen';
import {
  AuthenticatorMfaSection,
  ContactVerificationSection,
  SessionSecuritySection,
} from '@/screens/account/interim-sections';
import type { AccountBusyAction } from '@/screens/account/interim-sections';

/**
 * Account hub — Sprint 55 restructure of the Account tab.
 *
 * Replaces the former monolithic AccountScreen with an identity-first hub:
 * an identity card (initials avatar, name, contact rows with verification
 * badges, account status, MFA indicator) plus section navigation. "Personal
 * Information" opens a dedicated sub-screen (production-grade profile
 * editing); the sub-screen swap mirrors how AppShell swaps
 * Login/ForgotPassword (state + onBack, no navigation library).
 *
 * "Security" and "Account Access" are INTERIM expandable sections embedding
 * the former screen's Contact verification / Authenticator MFA / Session
 * security cards (identical behavior, single-flight busy guard owned here,
 * MFA enrollment material kept memory-only). Tasks 40-b/40-c replace them
 * with dedicated screens; "Sign Out" always calls the auth-context logout.
 */

export type AccountSubScreen = 'personal' | 'security' | 'access' | null;

type ExpandableSection = 'security' | 'access';

export default function AccountScreen() {
  const {
    user,
    accessToken,
    error: authError,
    setSession,
    clearSession,
    logout,
  } = useAuth();

  const [subScreen, setSubScreen] = useState<AccountSubScreen>(null);
  const [expandedSection, setExpandedSection] = useState<ExpandableSection | null>(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaSetup, setMfaSetup] = useState<MfaSetupResponse | null>(null);
  const [busy, setBusy] = useState<AccountBusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── Interim account actions (carried over from the former screen) ────────

  function startAction(action: Exclude<AccountBusyAction, null>): boolean {
    if (busy) return false;
    setBusy(action);
    setNotice(null);
    setActionError(null);
    return true;
  }

  function finishAction() {
    setBusy(null);
  }

  async function refreshIdentity(): Promise<void> {
    if (!accessToken) {
      throw new Error('Authenticated access token is unavailable');
    }
    const refreshed = await api.me();
    setSession(refreshed, accessToken);
  }

  async function handleEmailVerificationRequest() {
    if (!startAction('email-request')) return;
    try {
      const response = await api.requestEmailVerification();
      setNotice(response.message);
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      finishAction();
    }
  }

  async function handlePhoneVerificationRequest() {
    if (!startAction('phone-request')) return;
    try {
      const response = await api.requestPhoneVerification();
      setNotice(response.message);
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      finishAction();
    }
  }

  async function handlePhoneVerificationConfirm() {
    if (!startAction('phone-confirm')) return;
    try {
      if (!isSixDigitCode(phoneCode)) {
        setActionError('Enter the six-digit verification code.');
        return;
      }
      const response = await api.confirmPhoneVerification(phoneCode.trim());
      setPhoneCode('');
      await refreshIdentity();
      setNotice(response.message);
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      finishAction();
    }
  }

  async function handleBeginMfaSetup() {
    if (!startAction('mfa-setup')) return;
    try {
      if (!mfaPassword) {
        setActionError('Enter your current password to begin MFA setup.');
        return;
      }
      // Never leave the password in component state longer than the local
      // variable needs it: clear it as the request begins, not after.
      const password = mfaPassword;
      setMfaPassword('');
      const setup = await beginMfaSetup(password);
      // Enrollment material remains component-memory-only. Never persist or log it.
      setMfaSetup(setup);
      setMfaCode('');
      setNotice('MFA enrollment started. Add the account to your authenticator, then verify a code.');
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      finishAction();
    }
  }

  async function handleEnableMfa() {
    if (!startAction('mfa-enable')) return;
    try {
      if (!mfaSetup) {
        setActionError('Begin MFA setup before verifying an authenticator code.');
        return;
      }
      if (!isSixDigitCode(mfaCode)) {
        setActionError('Enter the six-digit code from your authenticator app.');
        return;
      }

      await api.enableMfa(mfaCode.trim());
      // The backend revokes every existing session when MFA is enabled.
      // Clear the local token pair immediately rather than leave stale credentials active.
      setMfaSetup(null);
      setMfaCode('');
      await clearSession();
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      finishAction();
    }
  }

  async function handleDisableMfa() {
    if (!startAction('mfa-disable')) return;
    try {
      if (!mfaPassword) {
        setActionError('Enter your current password to disable MFA.');
        return;
      }
      if (!isSixDigitCode(mfaCode)) {
        setActionError('Enter the six-digit code from your authenticator app.');
        return;
      }
      // Same hardening as MFA setup: the password leaves component state the
      // moment the request begins.
      const password = mfaPassword;
      const code = mfaCode.trim();
      setMfaPassword('');

      await api.disableMfa(code, password);
      setMfaCode('');
      // Disabling MFA also revokes all existing sessions server-side.
      await clearSession();
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      finishAction();
    }
  }

  function handleCancelMfaSetup() {
    setMfaSetup(null);
    setMfaCode('');
    setNotice(null);
    setActionError(null);
  }

  async function handleLogout() {
    if (!startAction('logout')) return;
    try {
      await logout();
    } finally {
      finishAction();
    }
  }

  // ── Sub-screen navigation ────────────────────────────────────────────────

  if (subScreen === 'personal') {
    return (
      <PersonalInformationScreen
        onBack={() => setSubScreen(null)}
        refreshIdentity={refreshIdentity}
      />
    );
  }

  if (!user) {
    return (
      <View style={styles.emptyShell}>
        <Text style={styles.emptyText}>Loading account…</Text>
      </View>
    );
  }

  // ── Hub home ─────────────────────────────────────────────────────────────

  const emailVerified = user.emailVerified === true;
  const phoneVerified = user.phoneVerified === true;
  const mfaEnabled = user.mfaEnabled === true;
  const statusMeta = accountStatusMeta(user.status);
  const initials = deriveInitials({
    profile: { firstName: user.firstName, lastName: user.lastName },
    email: user.email,
    phone: user.phone,
  });
  const fullName =
    [user.firstName?.trim(), user.lastName?.trim()].filter(Boolean).join(' ') || 'Add your name';

  const securityExpanded = expandedSection === 'security';
  const accessExpanded = expandedSection === 'access';

  function toggleSection(section: ExpandableSection) {
    setExpandedSection((current) => (current === section ? null : section));
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Account settings and security"
    >
      <Text style={styles.title}>Account</Text>
      <Text style={styles.subtitle}>
        Your identity, security protections and session in one place. Sensitive security material
        stays in memory only while you use it.
      </Text>

      {(actionError || authError) ? (
        <Banner variant="error">{actionError ?? authError}</Banner>
      ) : null}

      {notice ? <Banner variant="success">{notice}</Banner> : null}

      <Card>
        <View style={styles.identityHeader}>
          <View
            style={styles.avatar}
            accessibilityRole="image"
            accessibilityLabel={`Account initials: ${initials}`}
          >
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={styles.identityHeaderCopy}>
            <Text style={styles.fullName}>{fullName}</Text>
            <StatusPill status={user.status} tone={statusMeta.tone} />
          </View>
        </View>

        <Divider />

        <View style={styles.identityRow}>
          <View style={styles.identityRowCopy}>
            <Text style={styles.identityRowTitle}>Email</Text>
            <Text style={user.email ? styles.identityRowValue : styles.identityRowUnset}>
              {user.email ?? 'No email on account'}
            </Text>
          </View>
          <StatusPill
            status={emailVerified ? 'Verified' : 'Unverified'}
            tone={emailVerified ? 'positive' : 'neutral'}
          />
        </View>

        <View style={styles.identityRow}>
          <View style={styles.identityRowCopy}>
            <Text style={styles.identityRowTitle}>Phone</Text>
            <Text style={user.phone ? styles.identityRowValue : styles.identityRowUnset}>
              {user.phone ?? 'No phone on account'}
            </Text>
          </View>
          <StatusPill
            status={phoneVerified ? 'Verified' : 'Unverified'}
            tone={phoneVerified ? 'positive' : 'neutral'}
          />
        </View>

        <View style={styles.identityRow}>
          <View style={styles.identityRowCopy}>
            <Text style={styles.identityRowTitle}>Multi-factor authentication</Text>
            <Text style={styles.identityRowValue}>
              {mfaEnabled ? 'Authenticator app protection is on' : 'Authenticator app protection is off'}
            </Text>
          </View>
          <StatusPill
            status={mfaEnabled ? 'Enabled' : 'Disabled'}
            tone={mfaEnabled ? 'positive' : 'neutral'}
          />
        </View>
      </Card>

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Personal Information"
          onPress={() => setSubScreen('personal')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Personal Information</Text>
            <Text style={styles.sectionRowSubtitle}>
              Name, date of birth, country, timezone, currency, trading experience
            </Text>
          </View>
          <Text style={styles.sectionChevron}>›</Text>
        </Pressable>
      </Card>

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Security"
          accessibilityState={{ expanded: securityExpanded }}
          onPress={() => toggleSection('security')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Security</Text>
            <Text style={styles.sectionRowSubtitle}>
              Contact verification and authenticator MFA
            </Text>
          </View>
          <Text style={styles.sectionIndicator}>{securityExpanded ? '−' : '+'}</Text>
        </Pressable>
      </Card>

      {securityExpanded ? (
        <>
          <ContactVerificationSection
            busy={busy}
            email={user.email}
            phone={user.phone}
            emailVerified={emailVerified}
            phoneVerified={phoneVerified}
            phoneCode={phoneCode}
            onPhoneCodeChange={setPhoneCode}
            onRequestEmailVerification={() => void handleEmailVerificationRequest()}
            onRequestPhoneVerification={() => void handlePhoneVerificationRequest()}
            onConfirmPhoneVerification={() => void handlePhoneVerificationConfirm()}
          />
          <AuthenticatorMfaSection
            busy={busy}
            mfaEnabled={mfaEnabled}
            mfaSetup={mfaSetup}
            mfaPassword={mfaPassword}
            mfaCode={mfaCode}
            onMfaPasswordChange={setMfaPassword}
            onMfaCodeChange={setMfaCode}
            onBeginMfaSetup={() => void handleBeginMfaSetup()}
            onEnableMfa={() => void handleEnableMfa()}
            onDisableMfa={() => void handleDisableMfa()}
            onCancelMfaSetup={handleCancelMfaSetup}
          />
        </>
      ) : null}

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Account Access"
          accessibilityState={{ expanded: accessExpanded }}
          onPress={() => toggleSection('access')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Account Access</Text>
            <Text style={styles.sectionRowSubtitle}>Session security and sign-out</Text>
          </View>
          <Text style={styles.sectionIndicator}>{accessExpanded ? '−' : '+'}</Text>
        </Pressable>
      </Card>

      {accessExpanded ? (
        <SessionSecuritySection busy={busy} onLogout={() => void handleLogout()} />
      ) : null}

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          accessibilityState={{ disabled: Boolean(busy) }}
          onPress={() => void handleLogout()}
          style={styles.sectionRow}
          disabled={Boolean(busy)}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.signOutTitle}>
              {busy === 'logout' ? 'Signing out…' : 'Sign Out'}
            </Text>
            <Text style={styles.sectionRowSubtitle}>
              Revoke this session and return to the sign-in screen
            </Text>
          </View>
        </Pressable>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  content: { padding: 20, paddingBottom: 40 },
  title: { fontSize: 26, fontWeight: '800', color: palette.text, marginTop: 8 },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 16 },
  emptyShell: { flex: 1, backgroundColor: palette.bg, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: palette.muted, fontSize: 16 },
  identityHeader: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: palette.accentText, fontSize: 18, fontWeight: '800' },
  identityHeaderCopy: { flex: 1, gap: 6 },
  fullName: { fontSize: 18, fontWeight: '700', color: palette.text },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 15 },
  identityRowCopy: { flex: 1 },
  identityRowTitle: { color: palette.text, fontSize: 14, fontWeight: '700', marginBottom: 3 },
  identityRowValue: { color: palette.muted, fontSize: 13 },
  identityRowUnset: { color: palette.dim, fontSize: 13, fontStyle: 'italic' },
  flushCard: { padding: 0 },
  sectionRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
  },
  sectionRowCopy: { flex: 1 },
  sectionRowTitle: { color: palette.text, fontSize: 15, fontWeight: '700' },
  sectionRowSubtitle: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 3 },
  sectionChevron: { color: palette.dim, fontSize: 20, lineHeight: 24 },
  sectionIndicator: { color: palette.dim, fontSize: 20, lineHeight: 24, fontWeight: '700' },
  signOutTitle: { color: palette.danger.text, fontSize: 15, fontWeight: '700' },
});
