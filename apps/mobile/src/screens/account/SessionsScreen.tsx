import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiClientError } from '@irexpro/api-client';
import { useAuth } from '@/context/auth-context';
import {
  ActionButton,
  Banner,
  Card,
  SectionHeader,
  SkeletonBlock,
  StatusPill,
  palette,
} from '@/components/ui';
import { api, setAccessToken } from '@/lib/api';
import { accountSecurityError } from '@/lib/account-security';
import { clearTokens, getAccessToken, saveTokens } from '@/lib/secure-storage';
import {
  currentSessionView,
  deviceSummary,
  formatSessionTimestamps,
} from '@/lib/account-security-logic';

type SessionBusyAction = 'revokeOthers' | 'logout' | null;

const REVOKE_CONCURRENT_ROTATION_ERROR =
  'Your session could not be verified — it may have changed on another device. Please try again.';
const REVOKE_STORAGE_ERROR =
  'Secure session storage is unavailable. Please sign in again.';

/**
 * Sessions & Devices sub-screen of the Security hub (Sprint 55 Phase J).
 *
 * Honest session UX pinned to the backend contract:
 * - "This device" shows ONLY real data: the device label derived from the
 *   platform and the current session's start/expiry decoded from the live
 *   access token's own iat/exp claims. Nothing is fabricated and the values
 *   are re-derived after every token rotation (the revoke-others call here,
 *   or any refresh elsewhere).
 * - POST /auth/sessions/revoke-others bumps the global session version,
 *   killing every OTHER session, and returns a FRESH pair for THIS device.
 *   The new pair is persisted BEFORE it is exposed anywhere (saveTokens →
 *   setAccessToken → auth-context setSession), mirroring how auth-context
 *   handles rotated pairs; only then is the session view re-derived.
 * - "Sign out everywhere" delegates to the auth-context logout with its
 *   existing global semantics (server revocation ladder).
 * - The app has no server-side session registry, so a per-device list is NOT
 *   rendered — an honest limitation note explains the all-or-others model.
 */
export default function SessionsScreen({ onBack }: { onBack: () => void }) {
  const { user, accessToken, error: authError, setSession, clearSession, logout } = useAuth();

  const [busy, setBusy] = useState<SessionBusyAction>(null);
  const [sessionView, setSessionView] = useState<{ startedAt: number; expiresAt: number } | null>(
    null,
  );
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revokeFailedNetwork, setRevokeFailedNetwork] = useState(false);

  const cancelledRef = useRef(false);

  const device = deviceSummary({ OS: Platform.OS, Version: Platform.Version });
  const timestamps = sessionView ? formatSessionTimestamps(sessionView) : null;

  function startAction(action: Exclude<SessionBusyAction, null>): boolean {
    if (busy) return false;
    setBusy(action);
    return true;
  }

  // The persisted SecureStore token is the initial source of truth for the
  // current-session view; a cancelled ref keeps unmount safe.
  useEffect(() => {
    cancelledRef.current = false;
    void (async () => {
      const storedToken = await getAccessToken();
      if (cancelledRef.current) return;
      setSessionView(storedToken ? currentSessionView(storedToken) : null);
      setSessionLoaded(true);
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Re-derive after ANY token rotation: the auth-context access token changes
  // atomically with every persisted rotation (including revoke-others here).
  useEffect(() => {
    setSessionView(accessToken ? currentSessionView(accessToken) : null);
    setSessionLoaded(true);
  }, [accessToken]);

  function requestRevokeOthers(): void {
    if (busy) return;
    Alert.alert(
      'Sign out other devices?',
      'Every other session will be signed out immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out others',
          style: 'destructive',
          onPress: () => void revokeOtherSessions(),
        },
      ],
      { cancelable: true },
    );
  }

  async function revokeOtherSessions(): Promise<void> {
    if (!startAction('revokeOthers')) return;
    setNotice(null);
    setActionError(null);
    setRevokeFailedNetwork(false);
    try {
      const pair = await api.revokeOtherSessions();

      // Persist the fresh pair BEFORE exposing it anywhere — the server has
      // already killed the previous generation, so an unpersisted pair must
      // never become the live session credential.
      try {
        await saveTokens(pair);
      } catch {
        // SecureStore is unavailable and the stored pair is now stale. Mirror
        // the auth-context ladder: wipe credentials and require a fresh
        // sign-in rather than expose a session that cannot survive restart.
        setAccessToken(null);
        await clearTokens();
        Alert.alert(
          'Session storage unavailable',
          REVOKE_STORAGE_ERROR,
          [{ text: 'Sign in', onPress: () => { void clearSession(); } }],
          { cancelable: false },
        );
        return;
      }

      setAccessToken(pair.accessToken);
      if (user) {
        // Keep the auth-context's in-memory token in sync with the rotation.
        setSession(user, pair.accessToken);
      }
      setSessionView(currentSessionView(pair.accessToken));
      setNotice('All other sessions have been signed out.');
    } catch (error) {
      if (error instanceof ApiClientError && error.statusCode === 401) {
        // Concurrent rotation (or an expired access token): sanitized copy
        // suggesting a retry; the raw server message is never rendered.
        setActionError(REVOKE_CONCURRENT_ROTATION_ERROR);
      } else {
        setActionError(accountSecurityError(error));
        setRevokeFailedNetwork(
          error instanceof ApiClientError &&
            (error.statusCode === 0 || error.statusCode >= 500),
        );
      }
    } finally {
      setBusy(null);
    }
  }

  function requestSignOutEverywhere(): void {
    if (busy) return;
    Alert.alert(
      'Sign out everywhere?',
      'You will be signed out on every device, including this one.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void signOutEverywhere() },
      ],
      { cancelable: true },
    );
  }

  async function signOutEverywhere(): Promise<void> {
    if (!startAction('logout')) return;
    setNotice(null);
    setActionError(null);
    try {
      // Global semantics (server revocation ladder) live in the auth-context.
      await logout();
    } finally {
      setBusy(null);
    }
  }

  function requestBack(): void {
    if (busy) return;
    onBack();
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Sessions and devices"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to security"
        onPress={requestBack}
        style={styles.backButton}
        disabled={busy !== null}
      >
        <Text style={styles.backButtonText}>‹ Security</Text>
      </Pressable>

      <Text style={styles.title}>Sessions &amp; Devices</Text>
      <Text style={styles.subtitle}>
        Your current session on this device, plus controls to sign out other devices or every
        device at once.
      </Text>

      {authError ? <Banner variant="error">{authError}</Banner> : null}
      {notice ? <Banner variant="success">{notice}</Banner> : null}
      {actionError ? <Banner variant="error">{actionError}</Banner> : null}

      <Card>
        <SectionHeader
          title="This device"
          right={<StatusPill status="Current session" tone="positive" />}
        />
        <Text style={styles.deviceText}>{device}</Text>

        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Session started</Text>
          {sessionLoaded ? (
            <Text style={timestamps ? styles.detailValue : styles.detailUnavailable}>
              {timestamps ? timestamps.started : 'Unavailable from the current token'}
            </Text>
          ) : (
            <SkeletonBlock height={12} style={styles.detailSkeleton} />
          )}
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Session expires</Text>
          {sessionLoaded ? (
            <Text style={timestamps ? styles.detailValue : styles.detailUnavailable}>
              {timestamps ? timestamps.expires : 'Unavailable from the current token'}
            </Text>
          ) : (
            <SkeletonBlock height={12} style={styles.detailSkeleton} />
          )}
        </View>
        <Text style={styles.helper}>
          Start and expiry are read from this device's access token — no session details for
          other devices are stored on the phone.
        </Text>
      </Card>

      <Card>
        <SectionHeader title="Other devices" />
        <Text style={styles.bodyText}>
          Sign out every device except this one. This device receives a fresh session token
          immediately and stays signed in.
        </Text>
        <ActionButton
          label="Sign out other sessions"
          busyLabel="Signing out other devices…"
          busy={busy === 'revokeOthers'}
          onPress={requestRevokeOthers}
          disabled={busy !== null}
        />
        {revokeFailedNetwork ? (
          <ActionButton
            label="Try again"
            secondary
            onPress={() => void revokeOtherSessions()}
            disabled={busy !== null}
          />
        ) : null}
      </Card>

      <Card>
        <SectionHeader title="Sign out everywhere" />
        <Text style={styles.bodyText}>
          Revoke every session including this one and return to the sign-in screen.
        </Text>
        <ActionButton
          label="Sign out everywhere"
          busyLabel="Signing out…"
          busy={busy === 'logout'}
          onPress={requestSignOutEverywhere}
          danger
          disabled={busy !== null}
        />
      </Card>

      <Card>
        <Text style={styles.limitationText}>
          iRexPro immediately signs out every other device. A full list of individual devices
          with per-device sign-out requires a server-side session registry — planned as a
          follow-up.
        </Text>
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
  deviceText: { color: palette.text, fontSize: 16, fontWeight: '700', marginTop: 6 },
  detailRow: { marginTop: 14 },
  detailLabel: { color: palette.muted, fontSize: 13, fontWeight: '600', marginBottom: 4 },
  detailValue: { color: palette.body, fontSize: 13 },
  detailUnavailable: { color: palette.dim, fontSize: 13, fontStyle: 'italic' },
  detailSkeleton: { width: 140 },
  helper: { color: palette.helper, fontSize: 12, lineHeight: 18, marginTop: 12 },
  bodyText: { color: palette.bodySoft, fontSize: 14, lineHeight: 21, marginTop: 6 },
  limitationText: { color: palette.muted, fontSize: 13, lineHeight: 19 },
});
