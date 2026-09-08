import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import { ApiClientError } from '@irexpro/api-client';
import { ActionButton, Banner, Card, LabeledInput, palette } from '@/components/ui';
import { api } from '@/lib/api';
import { accountSecurityError } from '@/lib/account-security';
import {
  PASSWORD_MAX_LENGTH,
  validateChangePasswordSubmission,
  validateNewPasswordPolicy,
} from '@/lib/account-security-logic';

/**
 * Change password sub-screen of the Security hub (Sprint 55 Phase I).
 *
 * Behavior pinned to the backend contract:
 * - POST /auth/change-password re-authenticates with the current password
 *   (wrong value → 401), enforces the 12–128/letter/number policy on the new
 *   password (weak value → 400), and on success revokes ALL of the user's
 *   sessions — so the only honest post-success state is "sign in again".
 *
 * Secret hygiene (same hardening as the MFA flows):
 * - All three values are captured into local consts and cleared from
 *   component state the moment the request begins; passwords never live in
 *   state past that point, are never logged, and are never persisted.
 * - Errors are rendered ONLY through the sanitized accountSecurityError
 *   mapper — raw server messages are never reflected. Failed submissions
 *   leave the fields empty so the user can safely retry.
 */
export default function ChangePasswordScreen({
  onBack,
  clearSession,
}: {
  onBack: () => void;
  clearSession: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [networkFailed, setNetworkFailed] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  const submissionError = validateChangePasswordSubmission({
    currentPassword,
    newPassword,
    confirmPassword,
  });
  const canSubmit = submissionError === null && !busy && !succeeded;

  // Live field-level validation (the same always-on style as Personal
  // Information): each field shows its error as soon as it is invalid.
  const currentPasswordError =
    currentPassword.length === 0 ? 'Enter your current password.' : null;
  const newPasswordError = validateNewPasswordPolicy(newPassword);
  const confirmPasswordError =
    confirmPassword.length === 0
      ? 'Enter the new password again.'
      : confirmPassword === newPassword
        ? null
        : 'New passwords do not match.';

  function requestSubmit(): void {
    if (!canSubmit) return;
    // Destructive-action confirmation BEFORE the call: changing the password
    // signs the user out of every device.
    Alert.alert(
      'Change password?',
      'This signs you out of ALL devices.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Change Password', style: 'default', onPress: () => void handleSubmit() },
      ],
      { cancelable: true },
    );
  }

  async function handleSubmit(): Promise<void> {
    if (busy || succeeded) return;

    // Re-run the pure gate on submit as a guard against a stale render.
    const gate = validateChangePasswordSubmission({
      currentPassword,
      newPassword,
      confirmPassword,
    });
    if (gate) {
      setActionError('Check the highlighted fields and try again.');
      return;
    }

    // Capture the secrets into local consts and clear them from component
    // state the moment the request begins. They never exist in state (or in
    // any log/persistent store) past this line.
    const current = currentPassword;
    const next = newPassword;
    setBusy(true);
    setActionError(null);
    setNetworkFailed(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');

    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setSucceeded(true);
      Alert.alert(
        'Password changed',
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
      // 401 = wrong current password, 400 = weak new password: sanitized
      // banner; the fields stay empty for a clean retry. Network failures
      // additionally surface an explicit retry affordance.
      setActionError(accountSecurityError(error));
      setNetworkFailed(
        error instanceof ApiClientError && (error.statusCode === 0 || error.statusCode >= 500),
      );
    } finally {
      setBusy(false);
    }
  }

  function requestBack(): void {
    if (busy) return;
    onBack();
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
        accessibilityLabel="Change password"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to security"
          onPress={requestBack}
          style={styles.backButton}
          disabled={busy}
        >
          <Text style={styles.backButtonText}>‹ Security</Text>
        </Pressable>

        <Text style={styles.title}>Password</Text>
        <Text style={styles.subtitle}>
          Set a new sign-in password. Every active session is revoked when the password changes —
          you will sign in again on all devices.
        </Text>

        {succeeded ? (
          <Card>
            <Banner variant="success">
              Password changed. All sessions have been revoked.
            </Banner>
            <Text style={styles.bodyText}>
              Sign in again with your new password to continue using the app.
            </Text>
            <ActionButton label="Sign in again" onPress={() => void clearSession()} />
          </Card>
        ) : (
          <>
            {actionError ? <Banner variant="error">{actionError}</Banner> : null}

            <Card>
              <LabeledInput
                label="Current password"
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                maxLength={PASSWORD_MAX_LENGTH}
                editable={!busy}
                error={currentPasswordError}
              />
              <LabeledInput
                label="New password"
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                maxLength={PASSWORD_MAX_LENGTH}
                editable={!busy}
                error={newPasswordError}
              />
              <LabeledInput
                label="Confirm new password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                maxLength={PASSWORD_MAX_LENGTH}
                editable={!busy}
                error={confirmPasswordError}
              />
              <Text style={styles.helper}>
                At least 12 characters, including a letter and a number. Passwords are never stored
                by the app and never appear in logs.
              </Text>
              <ActionButton
                label="Change password"
                busyLabel="Changing password…"
                busy={busy}
                onPress={requestSubmit}
                disabled={!canSubmit}
              />
            </Card>

            {networkFailed ? (
              <ActionButton
                label="Try again"
                secondary
                disabled={busy}
                onPress={() => {
                  setActionError(null);
                  setNetworkFailed(false);
                }}
              />
            ) : null}
          </>
        )}
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
  bodyText: { color: palette.bodySoft, fontSize: 14, lineHeight: 21, marginTop: 6 },
  helper: { color: palette.helper, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
