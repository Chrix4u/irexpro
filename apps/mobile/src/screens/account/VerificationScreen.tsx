import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '@/context/auth-context';
import {
  ActionButton,
  Banner,
  Card,
  Divider,
  LabeledInput,
  SectionHeader,
  StatusPill,
  palette,
} from '@/components/ui';
import { api } from '@/lib/api';
import { accountSecurityError, verificationCodeError } from '@/lib/account-security';
import {
  RESEND_COOLDOWN_SECONDS,
  formatCooldown,
  resendCooldown,
  validateSixDigitCode,
  verificationExpiryHint,
} from '@/lib/account-security-logic';

type VerificationBusy = 'email-request' | 'phone-request' | 'phone-confirm' | null;

/**
 * Email & phone verification sub-screen of the Security hub (Sprint 55
 * Phase H).
 *
 * Honest-state principles:
 * - Verification status is ALWAYS rendered from the authenticated identity
 *   (emailVerified / phoneVerified from /auth/me) — never from local action
 *   results. A successful phone confirmation calls refreshIdentity() so the
 *   pill flips only when the server says so.
 * - Email confirmation happens through the emailed link (a web flow) — the
 *   screen deliberately offers NO token entry field for email; it tells the
 *   user to open the link on their device.
 * - Cooldowns are client-owned (60 seconds between resend requests) and are
 *   only started by SUCCESSFUL requests. The expiry hints are static,
 *   approximate statements of the backend TTLs (email link ~15 min, phone
 *   code ~10 min) — the responses carry no expiry field, so no countdowns
 *   are fabricated.
 * - Every error is rendered through the sanitized accountSecurityError /
 *   verificationCodeError mappers; attempt counters are never displayed
 *   (the server does not expose them).
 * - A single-flight busy guard covers all three actions.
 */
export default function VerificationScreen({
  onBack,
  refreshIdentity,
}: {
  onBack: () => void;
  refreshIdentity: () => Promise<void>;
}) {
  const { user } = useAuth();
  const email = user?.email ?? null;
  const phone = user?.phone ?? null;
  const emailVerified = user?.emailVerified === true;
  const phoneVerified = user?.phoneVerified === true;

  const [busy, setBusy] = useState<VerificationBusy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  const [phoneNotice, setPhoneNotice] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [emailCooldownStartedAt, setEmailCooldownStartedAt] = useState<number | null>(null);
  const [phoneCooldownStartedAt, setPhoneCooldownStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const emailCooldown =
    emailCooldownStartedAt === null
      ? 0
      : resendCooldown(RESEND_COOLDOWN_SECONDS, now - emailCooldownStartedAt);
  const phoneCooldown =
    phoneCooldownStartedAt === null
      ? 0
      : resendCooldown(RESEND_COOLDOWN_SECONDS, now - phoneCooldownStartedAt);
  const cooldownActive = emailCooldown > 0 || phoneCooldown > 0;

  // One shared ticker while any cooldown is running; it stops itself when
  // the last cooldown reaches zero.
  useEffect(() => {
    if (!cooldownActive) return undefined;
    const id: ReturnType<typeof setInterval> = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cooldownActive]);

  function startAction(action: Exclude<VerificationBusy, null>): boolean {
    if (busy) return false;
    setBusy(action);
    setActionError(null);
    return true;
  }

  async function handleEmailRequest(): Promise<void> {
    if (emailVerified || !email || emailCooldown > 0) return;
    if (!startAction('email-request')) return;
    try {
      const response = await api.requestEmailVerification();
      const startedAt = Date.now();
      setNow(startedAt);
      setEmailCooldownStartedAt(startedAt);
      setEmailNotice(`${response.message} ${verificationExpiryHint('email')}`);
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      setBusy(null);
    }
  }

  async function handlePhoneRequest(): Promise<void> {
    if (phoneVerified || !phone || phoneCooldown > 0) return;
    if (!startAction('phone-request')) return;
    try {
      const response = await api.requestPhoneVerification();
      const startedAt = Date.now();
      setNow(startedAt);
      setPhoneCooldownStartedAt(startedAt);
      setPhoneNotice(`${response.message} ${verificationExpiryHint('phone')}`);
    } catch (error) {
      setActionError(accountSecurityError(error));
    } finally {
      setBusy(null);
    }
  }

  async function handlePhoneConfirm(): Promise<void> {
    if (phoneVerified || !phone) return;
    if (!startAction('phone-confirm')) return;
    try {
      if (!validateSixDigitCode(phoneCode)) {
        setActionError('Enter the six-digit verification code.');
        return;
      }
      const code = phoneCode.trim();
      setPhoneCode('');
      const response = await api.confirmPhoneVerification(code);
      setPhoneNotice(response.message);
      // Server-authoritative: the status pill flips only after /auth/me
      // reflects the change.
      await refreshIdentity();
    } catch (error) {
      setActionError(verificationCodeError(error));
    } finally {
      setBusy(null);
    }
  }

  const emailRequested = emailNotice !== null || emailCooldownStartedAt !== null;
  const phoneRequested = phoneNotice !== null || phoneCooldownStartedAt !== null;

  const emailButtonLabel =
    emailCooldown > 0
      ? `Resend in ${formatCooldown(emailCooldown)}`
      : emailRequested
        ? 'Resend verification email'
        : 'Send verification email';
  const phoneButtonLabel =
    phoneCooldown > 0
      ? `Resend in ${formatCooldown(phoneCooldown)}`
      : phoneRequested
        ? 'Resend code'
        : 'Send verification code';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Email and phone verification"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to security"
          onPress={onBack}
          style={styles.backButton}
          disabled={busy !== null}
        >
          <Text style={styles.backButtonText}>‹ Security</Text>
        </Pressable>

        <Text style={styles.title}>Email &amp; Phone Verification</Text>
        <Text style={styles.subtitle}>
          Verification status is loaded from your authenticated identity and is never inferred on
          the device.
        </Text>

        {actionError ? <Banner variant="error">{actionError}</Banner> : null}

        <Card>
          <SectionHeader
            title="Email verification"
            description="Single-use link sent to your address"
            right={
              <StatusPill
                status={emailVerified ? 'Verified' : 'Unverified'}
                tone={emailVerified ? 'positive' : 'neutral'}
              />
            }
          />
          <View style={styles.verificationRow}>
            <View style={styles.verificationCopy}>
              <Text style={styles.rowTitle}>Email</Text>
              <Text style={email ? styles.valueText : styles.valueUnsetText}>
                {email ?? 'No email on account'}
              </Text>
            </View>
          </View>

          {emailNotice ? <Banner variant="success">{emailNotice}</Banner> : null}

          {!emailVerified && email ? (
            <>
              <Text style={styles.helper}>
                Open the link on your device to finish verification. The link is single-use.
              </Text>
              <ActionButton
                label={emailButtonLabel}
                busyLabel="Sending…"
                busy={busy === 'email-request'}
                onPress={() => void handleEmailRequest()}
                disabled={busy !== null || emailCooldown > 0}
                secondary
              />
              {emailCooldown > 0 ? (
                <Text style={styles.helper}>
                  You can request a new link in {formatCooldown(emailCooldown)}.
                </Text>
              ) : (
                <Text style={styles.helper}>
                  Resending is limited to once every {RESEND_COOLDOWN_SECONDS} seconds.
                </Text>
              )}
            </>
          ) : emailVerified ? (
            <Text style={styles.helper}>Your email address is verified.</Text>
          ) : (
            <Text style={styles.helper}>
              No email on account — contact details change only through verified flows.
            </Text>
          )}
        </Card>

        <Card>
          <SectionHeader
            title="Phone verification"
            description="Six-digit code sent by SMS"
            right={
              <StatusPill
                status={phoneVerified ? 'Verified' : 'Unverified'}
                tone={phoneVerified ? 'positive' : 'neutral'}
              />
            }
          />
          <View style={styles.verificationRow}>
            <View style={styles.verificationCopy}>
              <Text style={styles.rowTitle}>Phone</Text>
              <Text style={phone ? styles.valueText : styles.valueUnsetText}>
                {phone ?? 'No phone on account'}
              </Text>
            </View>
          </View>

          {phoneNotice ? <Banner variant="success">{phoneNotice}</Banner> : null}

          {!phoneVerified && phone ? (
            <>
              <ActionButton
                label={phoneButtonLabel}
                busyLabel="Sending…"
                busy={busy === 'phone-request'}
                onPress={() => void handlePhoneRequest()}
                disabled={busy !== null || phoneCooldown > 0}
                secondary
              />
              {phoneCooldown > 0 ? (
                <Text style={styles.helper}>
                  You can request a new code in {formatCooldown(phoneCooldown)}.
                </Text>
              ) : null}
              <Divider />
              <LabeledInput
                label="Verification code"
                value={phoneCode}
                onChangeText={setPhoneCode}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="123456"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                editable={busy === null}
              />
              <ActionButton
                label="Verify phone"
                busyLabel="Verifying…"
                busy={busy === 'phone-confirm'}
                onPress={() => void handlePhoneConfirm()}
                disabled={busy !== null || !validateSixDigitCode(phoneCode)}
              />
            </>
          ) : phoneVerified ? (
            <Text style={styles.helper}>Your phone number is verified.</Text>
          ) : (
            <Text style={styles.helper}>
              No phone on account — contact details change only through verified flows.
            </Text>
          )}
        </Card>
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
  verificationRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  verificationCopy: { flex: 1 },
  rowTitle: { color: palette.text, fontSize: 14, fontWeight: '700', marginBottom: 3 },
  valueText: { color: palette.muted, fontSize: 13 },
  valueUnsetText: { color: palette.dim, fontSize: 13, fontStyle: 'italic' },
  helper: { color: palette.helper, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
