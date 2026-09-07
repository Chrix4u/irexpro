import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { ApiClientError } from '@irexpro/api-client';
import { ActionButton, Banner, Card, LabeledInput, palette } from '@/components/ui';
import { api } from '@/lib/api';
import { accountSecurityError } from '@/lib/account-security';
import {
  APPEAL_IDENTIFIER_MAX_LENGTH,
  APPEAL_REASON_MAX_LENGTH,
  validateAppealSubmission,
} from '@/lib/account-security-logic';

const APPEAL_RECEIVED_COPY =
  'If an eligible account exists, the request has been received for review.';

/**
 * Pre-auth account appeal screen (Sprint 55 Phase K).
 *
 * PUBLIC flow for users who CANNOT sign in (restricted/locked accounts),
 * reached from the Login screen via the "Can't access your account?" link.
 * Wired to POST /users/account-appeals through api.submitAccountAppeal.
 *
 * Anti-enumeration contract (identical to ForgotPasswordScreen):
 * - The backend ALWAYS answers with the same generic response, and this screen
 *   shows the same generic success card for every server answer. No
 *   success/failure copy varies per identifier — an attacker cannot probe
 *   whether an account exists.
 * - The only visible error is a sanitized network-unreachable banner (the
 *   request never left the device, so nothing about the account was revealed);
 *   the form values are kept so a long appeal reason does not have to be
 *   re-typed.
 * - Identifier and reason are cleared once the submission outcome is shown, so
 *   a submitted appeal cannot be re-submitted accidentally.
 */
export default function AppealScreen({ onBack }: { onBack: () => void }) {
  const [identifier, setIdentifier] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [networkFailed, setNetworkFailed] = useState(false);

  const submissionError = validateAppealSubmission({ identifier, reason });
  const canSubmit = submissionError === null && !submitting && !submitted;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;

    setSubmitting(true);
    setActionError(null);
    setNetworkFailed(false);

    const request = { identifier: identifier.trim(), reason: reason.trim() };
    try {
      await api.submitAccountAppeal(request);
      setSubmitted(true);
      setIdentifier('');
      setReason('');
    } catch (error) {
      if (error instanceof ApiClientError && error.statusCode === 0) {
        // The request never reached the server: no account information was
        // revealed, so a sanitized connection error + kept values is safe.
        setActionError(accountSecurityError(error));
        setNetworkFailed(true);
      } else {
        // The server responded. The anti-enumeration contract is identical to
        // forgot-password: always the same generic outcome, never a
        // per-identifier difference.
        setSubmitted(true);
        setIdentifier('');
        setReason('');
      }
    } finally {
      setSubmitting(false);
    }
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
        accessibilityLabel="Account appeal"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to login"
          onPress={onBack}
          style={styles.backButton}
          disabled={submitting}
        >
          <Text style={styles.backButtonText}>‹ Back to login</Text>
        </Pressable>

        <Text style={styles.title}>Can&apos;t access your account?</Text>
        <Text style={styles.subtitle}>
          If you cannot sign in because your account is restricted or locked, submit an appeal
          for review. The same response is shown for every request.
        </Text>

        {submitted ? (
          <Card>
            <Banner variant="success">{APPEAL_RECEIVED_COPY}</Banner>
            <Text style={styles.bodyText}>
              Nothing about the account is confirmed on this screen. If the appeal is approved,
              signing in will work again.
            </Text>
            <Text style={styles.helper}>
              Appeals are reviewed by the iRexPro team; this app cannot show appeal status.
            </Text>
          </Card>
        ) : (
          <>
            {actionError ? <Banner variant="error">{actionError}</Banner> : null}

            <Card>
              <LabeledInput
                label="Email or phone"
                value={identifier}
                onChangeText={setIdentifier}
                placeholder="Email or international phone (+233...)"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                maxLength={APPEAL_IDENTIFIER_MAX_LENGTH}
                editable={!submitting}
                error={submissionError?.field === 'identifier' ? submissionError.error : null}
              />
              <LabeledInput
                label="What happened?"
                value={reason}
                onChangeText={setReason}
                placeholder="Describe why you cannot access your account"
                multiline
                maxLength={APPEAL_REASON_MAX_LENGTH}
                editable={!submitting}
                error={submissionError?.field === 'reason' ? submissionError.error : null}
              />
              <Text style={styles.characterCount}>
                {reason.length} / {APPEAL_REASON_MAX_LENGTH} characters
              </Text>
              <Text style={styles.helper}>
                Describe the issue in your own words — 20 to 2000 characters. Appeals are
                submit-only; nothing is tracked in the app.
              </Text>
              <ActionButton
                label="Submit appeal"
                busyLabel="Submitting…"
                busy={submitting}
                onPress={() => void handleSubmit()}
                disabled={!canSubmit}
              />
            </Card>

            {networkFailed ? (
              <ActionButton
                label="Try again"
                secondary
                onPress={() => void handleSubmit()}
                disabled={submitting}
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
  helper: { color: palette.helper, fontSize: 12, lineHeight: 18, marginTop: 8 },
  characterCount: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
