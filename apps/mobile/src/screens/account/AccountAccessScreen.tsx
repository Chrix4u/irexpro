import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/context/auth-context';
import { Card, SectionHeader, StatusPill, palette } from '@/components/ui';
import {
  accountStatusGuidance,
  accountStatusMeta,
  isRestrictedAccountStatus,
} from '@/lib/account-security-logic';

/**
 * Account Access sub-screen of the Account hub (Sprint 55 Phase K).
 *
 * Honest status UX:
 * - The status ALWAYS comes from the authenticated identity in the
 *   auth-context (server-authoritative /auth/me projection) — it is never
 *   inferred, guessed, or cached locally.
 * - Each status renders pinned honest copy, including the fact that
 *   suspension/locking revoked existing sessions server-side.
 * - Restricted statuses additionally show what a restriction means (sessions
 *   revoked, sign-in blocked, trading halted) — with NO administrative review
 *   details exposed.
 * - Appeal guidance points to the pre-auth appeal flow on the sign-in screen.
 *   The user-facing appeal API is submit-only, so no appeal status is tracked
 *   or fabricated here.
 */
export default function AccountAccessScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();

  if (!user) {
    return (
      <View style={styles.emptyShell}>
        <Text style={styles.emptyText}>Loading account…</Text>
      </View>
    );
  }

  const statusMeta = accountStatusMeta(user.status);
  const restricted = isRestrictedAccountStatus(user.status);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Account access"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to account"
        onPress={onBack}
        style={styles.backButton}
      >
        <Text style={styles.backButtonText}>‹ Account</Text>
      </Pressable>

      <Text style={styles.title}>Account Access</Text>
      <Text style={styles.subtitle}>
        Your account&apos;s access state, what a restriction means, and how to appeal one.
      </Text>

      <Card>
        <SectionHeader
          title="Account status"
          right={<StatusPill status={statusMeta.label} tone={statusMeta.tone} />}
        />
        <Text style={styles.bodyText}>{accountStatusGuidance(user.status)}</Text>
        <Text style={styles.helper}>
          Status is confirmed by the server only — never inferred on this device.
        </Text>
      </Card>

      {restricted ? (
        <Card>
          <Text style={styles.cardTitle}>What a restriction means</Text>
          <View style={styles.bulletRow}>
            <View style={styles.bulletDot} />
            <Text style={styles.bulletText}>
              Existing sessions were revoked on the server when the restriction was applied.
            </Text>
          </View>
          <View style={styles.bulletRow}>
            <View style={styles.bulletDot} />
            <Text style={styles.bulletText}>
              Signing in to the account is blocked while the restriction is in place.
            </Text>
          </View>
          <View style={styles.bulletRow}>
            <View style={styles.bulletDot} />
            <Text style={styles.bulletText}>
              Trading and account changes are halted for the account.
            </Text>
          </View>
        </Card>
      ) : null}

      {restricted ? (
        <Card>
          <Text style={styles.cardTitle}>Appeal a restriction</Text>
          <Text style={styles.bodyText}>
            Restricted accounts can be appealed from the sign-in screen — choose
            &apos;Can&apos;t access your account?&apos; before signing in.
          </Text>
          <Text style={styles.helper}>
            Appeals are submit-only — this app cannot show appeal status or review progress.
          </Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  content: { padding: 20, paddingBottom: 40 },
  emptyShell: { flex: 1, backgroundColor: palette.bg, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: palette.muted, fontSize: 16 },
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
  cardTitle: { fontSize: 17, fontWeight: '700', color: palette.text, marginBottom: 5 },
  bodyText: { color: palette.bodySoft, fontSize: 14, lineHeight: 21, marginTop: 6 },
  helper: { color: palette.helper, fontSize: 12, lineHeight: 18, marginTop: 10 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 10 },
  bulletDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.dim, marginTop: 7 },
  bulletText: { flex: 1, color: palette.bodySoft, fontSize: 14, lineHeight: 21 },
});
