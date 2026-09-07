import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/context/auth-context';
import { Card, StatusPill, palette } from '@/components/ui';
import ChangePasswordScreen from '@/screens/account/ChangePasswordScreen';
import MfaScreen from '@/screens/account/MfaScreen';
import VerificationScreen from '@/screens/account/VerificationScreen';

type SecurityPanel = 'overview' | 'password' | 'mfa' | 'verification';

/**
 * Security hub sub-screen of the Account tab (Sprint 55 Phase G/H/I).
 *
 * Replaces the former interim "Security" expandable card with a dedicated
 * drill-in hub: chevron rows for Password, Two-Factor Authentication (with a
 * live enabled/disabled pill derived from the authenticated identity), and
 * Email & Phone Verification. The screen manages its own depth-2 state with
 * the same back-header pattern as Personal Information — no navigation
 * library, no new native modules.
 *
 * Each row swaps in a dedicated screen that owns its own side effects:
 *   password     → ChangePasswordScreen   (revokes ALL sessions on success)
 *   mfa          → MfaScreen              (TOTP enrollment / disable)
 *   verification → VerificationScreen     (email link + phone code)
 * All error copy inside those screens goes through the sanitized
 * accountSecurityError / verificationCodeError mappers.
 */
export default function SecurityScreen({
  onBack,
  refreshIdentity,
  clearSession,
}: {
  onBack: () => void;
  refreshIdentity: () => Promise<void>;
  clearSession: () => void;
}) {
  const [panel, setPanel] = useState<SecurityPanel>('overview');
  const { user } = useAuth();

  const mfaEnabled = user?.mfaEnabled === true;

  function goOverview(): void {
    setPanel('overview');
  }

  if (panel === 'password') {
    return <ChangePasswordScreen onBack={goOverview} clearSession={clearSession} />;
  }
  if (panel === 'mfa') {
    return <MfaScreen onBack={goOverview} clearSession={clearSession} />;
  }
  if (panel === 'verification') {
    return <VerificationScreen onBack={goOverview} refreshIdentity={refreshIdentity} />;
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Security settings"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to account"
        onPress={onBack}
        style={styles.backButton}
      >
        <Text style={styles.backButtonText}>‹ Account</Text>
      </Pressable>

      <Text style={styles.title}>Security</Text>
      <Text style={styles.subtitle}>
        Change your password, manage authenticator protection, and verify your contact details.
        Sensitive material stays in memory only while it is used.
      </Text>

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Password"
          onPress={() => setPanel('password')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Password</Text>
            <Text style={styles.sectionRowSubtitle}>
              Change your password — every device signs out
            </Text>
          </View>
          <Text style={styles.sectionChevron}>›</Text>
        </Pressable>
      </Card>

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Two-Factor Authentication"
          onPress={() => setPanel('mfa')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Two-Factor Authentication</Text>
            <Text style={styles.sectionRowSubtitle}>
              Authenticator app (TOTP) protection for sign-in
            </Text>
          </View>
          <View style={styles.rowTrailing}>
            <StatusPill
              status={mfaEnabled ? 'Enabled' : 'Disabled'}
              tone={mfaEnabled ? 'positive' : 'neutral'}
            />
            <Text style={styles.sectionChevron}>›</Text>
          </View>
        </Pressable>
      </Card>

      <Card style={styles.flushCard}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Email and phone verification"
          onPress={() => setPanel('verification')}
          style={styles.sectionRow}
        >
          <View style={styles.sectionRowCopy}>
            <Text style={styles.sectionRowTitle}>Email &amp; Phone Verification</Text>
            <Text style={styles.sectionRowSubtitle}>
              Verify the contact details on your account
            </Text>
          </View>
          <Text style={styles.sectionChevron}>›</Text>
        </Pressable>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  content: { padding: 20, paddingBottom: 40 },
  backButton: {
    minHeight: 46,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginTop: 8,
    marginBottom: 4,
  },
  backButtonText: { color: palette.accent, fontSize: 15, fontWeight: '600' },
  title: { fontSize: 26, fontWeight: '800', color: palette.text, marginTop: 4 },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 16 },
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
  rowTrailing: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionChevron: { color: palette.dim, fontSize: 20, lineHeight: 24 },
});
