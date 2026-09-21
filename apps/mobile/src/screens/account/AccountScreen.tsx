import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/context/auth-context';
import {
  Banner,
  Card,
  Divider,
  StatusPill,
  palette,
} from '@/components/ui';
import { api } from '@/lib/api';
import { eligibility } from '@/lib/eligibility';
import type { EligibilityStatusView } from '@irexpro/types/eligibility';
import {
  accountStatusMeta,
  deriveInitials,
  kycStatusRowView,
} from '@/lib/account-security-logic';
import AccountAccessScreen from '@/screens/account/AccountAccessScreen';
import PersonalInformationScreen from '@/screens/account/PersonalInformationScreen';
import SecurityScreen from '@/screens/account/SecurityScreen';

/** Single-flight busy marker owned by the Account hub. */
type AccountBusyAction = 'logout' | null;

/**
 * Account hub — Sprint 55 restructure of the Account tab.
 *
 * An identity-first hub: an identity card (initials avatar, name, contact
 * rows with verification badges, account status, MFA indicator) plus section
 * navigation. "Personal Information", "Security", and "Account Access" each
 * open a dedicated sub-screen (production-grade profile editing; password
 * change, TOTP MFA enrollment, contact verification, Sessions & Devices, and
 * the Security Activity timeline; honest account-status guidance with appeal
 * direction); the sub-screen swap mirrors how AppShell swaps
 * Login/ForgotPassword/Appeal (state + onBack, no navigation library).
 *
 * "Sign Out" always calls the auth-context logout under the single-flight
 * busy guard owned here.
 */
export type AccountSubScreen = 'personal' | 'security' | 'access' | null;

export default function AccountScreen({
  onOpenPayments,
}: {
  onOpenPayments?: () => void;
}) {
  const {
    user,
    accessToken,
    error: authError,
    setSession,
    clearSession,
    logout,
  } = useAuth();

  const [subScreen, setSubScreen] = useState<AccountSubScreen>(null);
  const [busy, setBusy] = useState<AccountBusyAction>(null);
  // Production-LIVE completion round (audit P8: no KYC status surface): the
  // identity card renders the server-reported KYC/jurisdiction/disclosures
  // truth from GET /users/me/eligibility. Fail-closed: null renders an honest
  // "unavailable" row — never a guessed status, never a green pill.
  const [kycStatus, setKycStatus] = useState<EligibilityStatusView | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await eligibility.getMyStatus();
        if (!cancelled) setKycStatus(status);
      } catch {
        if (!cancelled) setKycStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const kycRow = kycStatusRowView(kycStatus);

  function startAction(action: Exclude<AccountBusyAction, null>): boolean {
    if (busy) return false;
    setBusy(action);
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

  if (subScreen === 'security') {
    return (
      <SecurityScreen
        onBack={() => setSubScreen(null)}
        refreshIdentity={refreshIdentity}
        clearSession={clearSession}
      />
    );
  }

  if (subScreen === 'access') {
    return <AccountAccessScreen onBack={() => setSubScreen(null)} />;
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

      {authError ? <Banner variant="error">{authError}</Banner> : null}

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

        <View style={styles.identityRow}>
          <View style={styles.identityRowCopy}>
            <Text style={styles.identityRowTitle}>Identity verification (KYC)</Text>
            <Text style={styles.identityRowValue}>{kycRow.detail}</Text>
          </View>
          <StatusPill status={kycRow.pillLabel} tone={kycRow.pillTone} />
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
              Name, date of birth, country, timezone and currency
            </Text>
          </View>
          <Text style={styles.sectionChevron}>›</Text>
        </Pressable>
      </Card>

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Security"
          onPress={() => setSubScreen('security')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Security</Text>
            <Text style={styles.sectionRowSubtitle}>
              Password, two-factor authentication, email &amp; phone verification
            </Text>
          </View>
          <Text style={styles.sectionChevron}>›</Text>
        </Pressable>
      </Card>

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Account Access"
          onPress={() => setSubScreen('access')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Account Access</Text>
            <Text style={styles.sectionRowSubtitle}>
              Account status, restrictions and how to appeal
            </Text>
          </View>
          <Text style={styles.sectionChevron}>›</Text>
        </Pressable>
      </Card>

      {onOpenPayments ? (
        <Card style={styles.flushCard}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fees and Payments"
            onPress={onOpenPayments}
            style={styles.sectionRow}
          >
            <View style={styles.sectionRowCopy}>
              <Text style={styles.sectionRowTitle}>Fees &amp; Payments</Text>
              <Text style={styles.sectionRowSubtitle}>
                Review service fees and payment activity
              </Text>
            </View>
            <Text style={styles.sectionChevron}>›</Text>
          </Pressable>
        </Card>
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
  signOutTitle: { color: palette.danger.text, fontSize: 15, fontWeight: '700' },
});
