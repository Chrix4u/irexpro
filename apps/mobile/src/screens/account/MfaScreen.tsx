import { useReducer, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ApiClientError } from '@irexpro/api-client';
import { useAuth } from '@/context/auth-context';
import {
  ActionButton,
  Banner,
  Card,
  LabeledInput,
  SectionHeader,
  StatusPill,
  palette,
} from '@/components/ui';
import { api } from '@/lib/api';
import {
  accountSecurityError,
  beginMfaSetup,
  isMfaSetupExpiredRejection,
  verificationCodeError,
} from '@/lib/account-security';
import {
  MFA_ENROLLMENT_INITIAL_STATE,
  PASSWORD_MAX_LENGTH,
  mfaEnrollmentReducer,
  validateSixDigitCode,
} from '@/lib/account-security-logic';

/** Static restart copy for the backend's "MFA setup expired" 400. */
const MFA_SETUP_EXPIRED_COPY =
  'Your enrollment window has closed. Start setup again to receive a new secret.';
/** Static copy for the rare race where MFA was enabled from another device. */
const MFA_ALREADY_ENABLED_COPY =
  'Multi-factor authentication is already enabled on your account.';

/**
 * Two-Factor Authentication sub-screen of the Security hub (Sprint 55
 * Phase G) — complete TOTP enrollment and disable UX.
 *
 * The enrollment flow is driven by the pure `mfaEnrollmentReducer` (see
 * account-security-logic.ts): the screen holds only transient busy/error
 * state, while the one-time enrollment material (secret + otpauth URI)
 * exists ONLY inside the reducer's 'verifying' state. The material is:
 *   - never written to SecureStore/AsyncStorage/files,
 *   - never logged,
 *   - provably nulled by the reducer on every terminal (CODE_ACCEPTED /
 *     CODE_REJECTED) and reset (RESTART / CANCEL) transition,
 *   - destroyed with the component when it unmounts (memory-only state).
 *
 * Server-authoritative status: whether MFA is enabled is read from the
 * authenticated identity (`user.mfaEnabled` from /auth/me) — never inferred
 * from local actions. Both enable and disable revoke every session
 * server-side, so success always ends with clearSession() + sign-in again.
 *
 * NOTE: there is deliberately no "copy to clipboard" affordance — that would
 * require expo-clipboard, which is not a dependency of this app. The secret
 * and URI are rendered as selectable Text, which exposes the platform's own
 * long-press selection/copy affordance.
 */
export default function MfaScreen({
  onBack,
  clearSession,
}: {
  onBack: () => void;
  clearSession: () => void;
}) {
  const { user } = useAuth();
  const mfaEnabled = user?.mfaEnabled === true;

  // ── Enrollment flow (MFA off) ───────────────────────────────────────────
  const [enrollment, dispatch] = useReducer(
    mfaEnrollmentReducer,
    MFA_ENROLLMENT_INITIAL_STATE,
  );
  const [enrollPassword, setEnrollPassword] = useState('');
  const [enrollCode, setEnrollCode] = useState('');
  const [enableBusy, setEnableBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [restartNotice, setRestartNotice] = useState<string | null>(null);

  // ── Disable flow (MFA on) ───────────────────────────────────────────────
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disableSucceeded, setDisableSucceeded] = useState(false);

  const beginningSetup = enrollment.status === 'enrolling';

  function startEnrollment(): void {
    setEnrollError(null);
    setRestartNotice(null);
    dispatch({ type: 'START' });
  }

  async function handleBeginSetup(): Promise<void> {
    if (enrollment.status !== 'password' || beginningSetup) return;
    if (!enrollPassword) {
      setEnrollError('Enter your current password to begin MFA setup.');
      return;
    }

    // The password leaves component state the moment the request begins —
    // it exists only in a local const for the duration of the call.
    const password = enrollPassword;
    setEnrollPassword('');
    setEnrollError(null);
    dispatch({ type: 'BEGIN_REQUESTED' });

    try {
      const setup = await beginMfaSetup(password);
      // From here the one-time material lives ONLY in reducer state.
      dispatch({
        type: 'ENROLLMENT_RECEIVED',
        material: { secret: setup.secret, otpauthUri: setup.otpauthUri },
      });
    } catch (error) {
      dispatch({ type: 'BEGIN_FAILED' });
      setEnrollError(accountSecurityError(error));
    }
  }

  async function handleEnableMfa(): Promise<void> {
    if (enrollment.status !== 'verifying' || enableBusy) return;
    if (!validateSixDigitCode(enrollCode)) {
      setEnrollError('Enter the six-digit code from your authenticator app.');
      return;
    }

    const code = enrollCode.trim();
    setEnrollCode('');
    setEnrollError(null);
    setEnableBusy(true);

    try {
      await api.enableMfa(code);
      // CODE_ACCEPTED wipes the enrollment material at the logic level.
      dispatch({ type: 'CODE_ACCEPTED' });
      Alert.alert(
        'MFA enabled',
        'Sign in again with your authenticator.',
        [
          {
            text: 'Sign in',
            onPress: () => {
              void clearSession();
            },
          },
        ],
        { cancelable: false },
      );
    } catch (error) {
      if (isMfaSetupExpiredRejection(error)) {
        // Terminal rejection: CODE_REJECTED wipes the material, RESTART
        // resets the machine, and the static restart copy is surfaced as a
        // notice on the idle screen (the raw server message is never shown).
        setEnrollCode('');
        dispatch({ type: 'CODE_REJECTED', reason: MFA_SETUP_EXPIRED_COPY });
        dispatch({ type: 'RESTART' });
        setRestartNotice(MFA_SETUP_EXPIRED_COPY);
      } else if (error instanceof ApiClientError && error.statusCode === 409) {
        // The enrollment is dead server-side; the failed state keeps the
        // sanitized reason and offers a fresh start.
        setEnrollCode('');
        dispatch({ type: 'CODE_REJECTED', reason: MFA_ALREADY_ENABLED_COPY });
      } else {
        // Bad TOTP (401) or a transient failure: stay in 'verifying' and let
        // the user retry with a fresh code. Sanitized copy only.
        setEnrollError(verificationCodeError(error));
      }
    } finally {
      setEnableBusy(false);
    }
  }

  function discardEnrollment(): void {
    // CANCEL wipes the one-time material at the logic level.
    dispatch({ type: 'CANCEL' });
    setEnrollPassword('');
    setEnrollCode('');
    setEnrollError(null);
    setRestartNotice(null);
  }

  function requestCancelSetup(): void {
    if (beginningSetup || enableBusy) return;
    Alert.alert(
      'Discard enrollment?',
      'The enrollment secret is cleared from memory and cannot be recovered. You would need to start setup again.',
      [
        { text: 'Keep going', style: 'cancel' },
        { text: 'Discard enrollment', style: 'destructive', onPress: discardEnrollment },
      ],
      { cancelable: true },
    );
  }

  function requestDisable(): void {
    if (disableBusy || disableSucceeded) return;
    if (!disablePassword || !validateSixDigitCode(disableCode)) return;

    Alert.alert(
      'Disable MFA?',
      'This removes authenticator protection and signs you out of all devices.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disable MFA', style: 'destructive', onPress: () => void handleDisable() },
      ],
      { cancelable: true },
    );
  }

  async function handleDisable(): Promise<void> {
    if (disableBusy || disableSucceeded) return;

    // Both secrets leave component state the moment the request begins.
    const password = disablePassword;
    const code = disableCode.trim();
    setDisableBusy(true);
    setDisableError(null);
    setDisablePassword('');
    setDisableCode('');

    try {
      await api.disableMfa(code, password);
      setDisableSucceeded(true);
      Alert.alert(
        'MFA disabled',
        'All sessions have been revoked. Please sign in again.',
        [
          {
            text: 'Sign in',
            onPress: () => {
              void clearSession();
            },
          },
        ],
        { cancelable: false },
      );
    } catch (error) {
      setDisableError(accountSecurityError(error));
    } finally {
      setDisableBusy(false);
    }
  }

  function requestBack(): void {
    if (beginningSetup || enableBusy || disableBusy) return;
    if (enrollment.status === 'verifying') {
      // Live enrollment material: confirm, then wipe via CANCEL.
      Alert.alert(
        'Discard enrollment?',
        'The enrollment secret is cleared from memory and cannot be recovered. You would need to start setup again.',
        [
          { text: 'Keep going', style: 'cancel' },
          {
            text: 'Discard enrollment',
            style: 'destructive',
            onPress: () => {
              discardEnrollment();
              onBack();
            },
          },
        ],
        { cancelable: true },
      );
      return;
    }
    // No live material: reset all local state on the way out.
    discardEnrollment();
    setDisablePassword('');
    setDisableCode('');
    setDisableError(null);
    onBack();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const header = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to security"
        onPress={requestBack}
        style={styles.backButton}
        disabled={beginningSetup || enableBusy || disableBusy}
      >
        <Text style={styles.backButtonText}>‹ Security</Text>
      </Pressable>
      <Text style={styles.title}>Two-Factor Authentication</Text>
    </>
  );

  if (mfaEnabled) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Two-factor authentication"
        >
          {header}
          <Text style={styles.subtitle}>
            Protect sign-in with time-based one-time passwords from an authenticator app.
          </Text>

          {disableSucceeded ? (
            <Card>
              <Banner variant="success">MFA disabled. All sessions have been revoked.</Banner>
              <Text style={styles.bodyText}>
                Sign in again with your password to continue. Authenticator protection is now off.
              </Text>
              <ActionButton label="Sign in again" onPress={() => void clearSession()} />
            </Card>
          ) : (
            <Card>
              <SectionHeader
                title="Authenticator protection"
                description="Time-based one-time password (TOTP)"
                right={<StatusPill status="Enabled" tone="positive" />}
              />
              <Text style={styles.bodyText}>
                Disabling MFA requires both your current password and a valid authenticator code.
                The server revokes every session after the change, so you will sign in again
                everywhere.
              </Text>
              {disableError ? <Banner variant="error">{disableError}</Banner> : null}
              <LabeledInput
                label="Current password"
                value={disablePassword}
                onChangeText={setDisablePassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                maxLength={PASSWORD_MAX_LENGTH}
                editable={!disableBusy && !disableSucceeded}
              />
              <LabeledInput
                label="Authenticator code"
                value={disableCode}
                onChangeText={setDisableCode}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="123456"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                editable={!disableBusy && !disableSucceeded}
              />
              <ActionButton
                label="Disable MFA"
                busyLabel="Disabling MFA…"
                busy={disableBusy}
                onPress={requestDisable}
                disabled={
                  disableBusy ||
                  disableSucceeded ||
                  !disablePassword ||
                  !validateSixDigitCode(disableCode)
                }
                danger
              />
            </Card>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Two-factor authentication"
      >
        {header}
        <Text style={styles.subtitle}>
          Protect sign-in with time-based one-time passwords from an authenticator app.
        </Text>

        {enrollment.status === 'succeeded' ? (
          <Card>
            <Banner variant="success">
              MFA enabled. All sessions have been revoked.
            </Banner>
            <Text style={styles.bodyText}>
              Sign in again with your password and authenticator code to continue.
            </Text>
            <ActionButton label="Sign in again" onPress={() => void clearSession()} />
          </Card>
        ) : null}

        {enrollment.status === 'idle' || enrollment.status === 'failed' ? (
          <Card>
            <SectionHeader
              title="Authenticator protection"
              description="Time-based one-time password (TOTP)"
              right={<StatusPill status="Disabled" tone="neutral" />}
            />
            {restartNotice ? <Banner variant="error">{restartNotice}</Banner> : null}
            {enrollment.status === 'failed' && enrollment.failureReason ? (
              <Banner variant="error">{enrollment.failureReason}</Banner>
            ) : null}
            <Text style={styles.bodyText}>
              Add an authenticator app (such as Google Authenticator or Authy) as a second factor
              at sign-in. Enabling MFA re-asks for your current password, shows a one-time
              enrollment secret, and signs you out of all devices once it is on.
            </Text>
            {enrollment.status === 'failed' ? (
              <ActionButton
                label="Start setup again"
                onPress={() => {
                  setEnrollError(null);
                  dispatch({ type: 'RETRY' });
                }}
              />
            ) : (
              <ActionButton label="Add authenticator" onPress={startEnrollment} />
            )}
          </Card>
        ) : null}

        {enrollment.status === 'password' || enrollment.status === 'enrolling' ? (
          <Card>
            <SectionHeader
              title="Start enrollment"
              description="Re-authenticate to receive one-time enrollment material"
              right={<StatusPill status="Disabled" tone="neutral" />}
            />
            <Text style={styles.bodyText}>
              The server issues the enrollment secret only after verifying your current password.
              The password is used for this request and immediately discarded.
            </Text>
            {enrollError ? <Banner variant="error">{enrollError}</Banner> : null}
            <LabeledInput
              label="Current password"
              value={enrollPassword}
              onChangeText={setEnrollPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              maxLength={PASSWORD_MAX_LENGTH}
              editable={!beginningSetup}
            />
            <ActionButton
              label="Begin setup"
              busyLabel="Starting setup…"
              busy={beginningSetup}
              onPress={() => void handleBeginSetup()}
              disabled={beginningSetup || !enrollPassword}
            />
          </Card>
        ) : null}

        {enrollment.status === 'verifying' && enrollment.material ? (
          <Card>
            <SectionHeader
              title="Verify enrollment"
              description="Add the account to your authenticator, then confirm a code"
              right={<StatusPill status="Pending" tone="warning" />}
            />
            <View style={styles.secretPanel} accessibilityRole="summary">
              <Text style={styles.secretTitle}>
                Enrollment secret — shown only during setup, never stored
              </Text>
              <Text style={styles.secretWarning}>
                Add this account to your authenticator now. The secret is not saved by the app and
                disappears when you enable MFA, cancel, or leave this screen. If the enrollment
                window closes before you finish, start setup again for a new secret. Long-press the
                values to select and copy them.
              </Text>
              <Text style={styles.secretLabel}>Secret</Text>
              <Text selectable style={styles.secretValue}>
                {enrollment.material.secret}
              </Text>
              <Text style={styles.secretLabel}>Authenticator URI</Text>
              <Text selectable style={styles.uriValue}>
                {enrollment.material.otpauthUri}
              </Text>
            </View>
            {enrollError ? <Banner variant="error">{enrollError}</Banner> : null}
            <LabeledInput
              label="Authenticator code"
              value={enrollCode}
              onChangeText={setEnrollCode}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="123456"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              editable={!enableBusy}
            />
            <ActionButton
              label="Enable MFA"
              busyLabel="Enabling MFA…"
              busy={enableBusy}
              onPress={() => void handleEnableMfa()}
              disabled={enableBusy || !validateSixDigitCode(enrollCode)}
            />
            <ActionButton
              label="Cancel setup"
              secondary
              onPress={requestCancelSetup}
              disabled={enableBusy}
            />
          </Card>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  scrollView: { flex: 1 },
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
  bodyText: { color: palette.bodySoft, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 12 },
  secretPanel: {
    marginTop: 6,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#854d0e',
    backgroundColor: '#291f0b',
    borderRadius: 10,
    padding: 12,
  },
  secretTitle: { color: '#fde68a', fontSize: 14, fontWeight: '800', marginBottom: 5 },
  secretWarning: { color: '#fcd34d', fontSize: 12, lineHeight: 18, marginBottom: 10 },
  secretLabel: {
    color: '#d6c48b',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: 6,
  },
  secretValue: { color: '#fff7d6', fontSize: 14, lineHeight: 21, marginTop: 3 },
  uriValue: { color: '#fff7d6', fontSize: 11, lineHeight: 17, marginTop: 3 },
});
