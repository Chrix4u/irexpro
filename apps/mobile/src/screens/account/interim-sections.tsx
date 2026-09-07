import { StyleSheet, Text, View } from 'react-native';
import type { MfaSetupResponse } from '@irexpro/types';
import {
  ActionButton,
  Card,
  Divider,
  LabeledInput,
  SectionHeader,
  StatusPill,
} from '@/components/ui';
import { isSixDigitCode } from '@/lib/account-security';

/**
 * INTERIM Sprint 55 account sections — carried over verbatim from the former
 * monolithic AccountScreen so the app stays fully functional at every commit.
 *
 * The AccountScreen hub owns ALL state and handlers (single-flight busy
 * guard, notices, sanitized errors, memory-only MFA enrollment material);
 * these components are purely presentational. Task 40-b/40-c will replace
 * them with dedicated Security / Account Access screens, at which point this
 * file and the corresponding handler block in the hub are deleted.
 */

/** Single-flight busy marker shared by every interim account action. */
export type AccountBusyAction =
  | 'email-request'
  | 'phone-request'
  | 'phone-confirm'
  | 'mfa-setup'
  | 'mfa-enable'
  | 'mfa-disable'
  | 'logout'
  | null;

interface ContactVerificationSectionProps {
  busy: AccountBusyAction;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  phoneCode: string;
  onPhoneCodeChange: (value: string) => void;
  onRequestEmailVerification: () => void;
  onRequestPhoneVerification: () => void;
  onConfirmPhoneVerification: () => void;
}

export function ContactVerificationSection({
  busy,
  email,
  phone,
  emailVerified,
  phoneVerified,
  phoneCode,
  onPhoneCodeChange,
  onRequestEmailVerification,
  onRequestPhoneVerification,
  onConfirmPhoneVerification,
}: ContactVerificationSectionProps) {
  return (
    <Card>
      <Text style={styles.cardTitle}>Contact verification</Text>
      <Text style={styles.muted}>
        Verification status is loaded from your authenticated identity and is never inferred on the device.
      </Text>

      <View style={styles.verificationRow}>
        <View style={styles.verificationCopy}>
          <Text style={styles.rowTitle}>Email</Text>
          <Text style={styles.valueText}>{email ?? 'No email on account'}</Text>
        </View>
        <StatusPill
          status={emailVerified ? 'Verified' : 'Unverified'}
          tone={emailVerified ? 'positive' : 'neutral'}
        />
      </View>
      {!emailVerified && email ? (
        <ActionButton
          label={busy === 'email-request' ? 'Sending…' : 'Send verification email'}
          onPress={onRequestEmailVerification}
          disabled={Boolean(busy)}
          secondary
        />
      ) : null}

      <Divider />

      <View style={styles.verificationRow}>
        <View style={styles.verificationCopy}>
          <Text style={styles.rowTitle}>Phone</Text>
          <Text style={styles.valueText}>{phone ?? 'No phone on account'}</Text>
        </View>
        <StatusPill
          status={phoneVerified ? 'Verified' : 'Unverified'}
          tone={phoneVerified ? 'positive' : 'neutral'}
        />
      </View>
      {!phoneVerified && phone ? (
        <>
          <ActionButton
            label={busy === 'phone-request' ? 'Sending…' : 'Send verification code'}
            onPress={onRequestPhoneVerification}
            disabled={Boolean(busy)}
            secondary
          />
          <LabeledInput
            label="Verification code"
            value={phoneCode}
            onChangeText={onPhoneCodeChange}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="123456"
            editable={!busy}
          />
          <ActionButton
            label={busy === 'phone-confirm' ? 'Verifying…' : 'Verify phone'}
            onPress={onConfirmPhoneVerification}
            disabled={Boolean(busy) || !isSixDigitCode(phoneCode)}
          />
        </>
      ) : null}
    </Card>
  );
}

interface AuthenticatorMfaSectionProps {
  busy: AccountBusyAction;
  mfaEnabled: boolean;
  mfaSetup: MfaSetupResponse | null;
  mfaPassword: string;
  mfaCode: string;
  onMfaPasswordChange: (value: string) => void;
  onMfaCodeChange: (value: string) => void;
  onBeginMfaSetup: () => void;
  onEnableMfa: () => void;
  onDisableMfa: () => void;
  onCancelMfaSetup: () => void;
}

export function AuthenticatorMfaSection({
  busy,
  mfaEnabled,
  mfaSetup,
  mfaPassword,
  mfaCode,
  onMfaPasswordChange,
  onMfaCodeChange,
  onBeginMfaSetup,
  onEnableMfa,
  onDisableMfa,
  onCancelMfaSetup,
}: AuthenticatorMfaSectionProps) {
  return (
    <Card>
      <SectionHeader
        title="Authenticator MFA"
        description="Time-based one-time password protection"
        right={
          <StatusPill
            status={mfaEnabled ? 'Enabled' : 'Disabled'}
            tone={mfaEnabled ? 'positive' : 'neutral'}
          />
        }
      />

      {!mfaEnabled ? (
        !mfaSetup ? (
          <>
            <Text style={styles.bodyText}>
              Re-enter your current password before the server issues one-time enrollment material.
            </Text>
            <LabeledInput
              label="Current password"
              value={mfaPassword}
              onChangeText={onMfaPasswordChange}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              maxLength={128}
              editable={!busy}
            />
            <ActionButton
              label={busy === 'mfa-setup' ? 'Starting setup…' : 'Begin MFA setup'}
              onPress={onBeginMfaSetup}
              disabled={Boolean(busy) || !mfaPassword}
            />
          </>
        ) : (
          <>
            <View style={styles.secretPanel} accessibilityRole="summary">
              <Text style={styles.secretTitle}>One-time enrollment material</Text>
              <Text style={styles.secretWarning}>
                Add this account to your authenticator now. This secret is not saved by the app and disappears when you leave or cancel setup.
              </Text>
              <Text style={styles.secretLabel}>Secret</Text>
              <Text selectable style={styles.secretValue}>{mfaSetup.secret}</Text>
              <Text style={styles.secretLabel}>Authenticator URI</Text>
              <Text selectable style={styles.uriValue}>{mfaSetup.otpauthUri}</Text>
            </View>

            <LabeledInput
              label="Authenticator code"
              value={mfaCode}
              onChangeText={onMfaCodeChange}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="123456"
              editable={!busy}
            />
            <ActionButton
              label={busy === 'mfa-enable' ? 'Enabling MFA…' : 'Verify and enable MFA'}
              onPress={onEnableMfa}
              disabled={Boolean(busy) || !isSixDigitCode(mfaCode)}
            />
            <ActionButton
              label="Cancel setup and clear secret"
              onPress={onCancelMfaSetup}
              disabled={Boolean(busy)}
              secondary
            />
          </>
        )
      ) : (
        <>
          <Text style={styles.bodyText}>
            Disabling MFA requires both your current password and a valid authenticator code. The server revokes existing sessions after the change.
          </Text>
          <LabeledInput
            label="Current password"
            value={mfaPassword}
            onChangeText={onMfaPasswordChange}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            maxLength={128}
            editable={!busy}
          />
          <LabeledInput
            label="Authenticator code"
            value={mfaCode}
            onChangeText={onMfaCodeChange}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="123456"
            editable={!busy}
          />
          <ActionButton
            label={busy === 'mfa-disable' ? 'Disabling MFA…' : 'Disable MFA'}
            onPress={onDisableMfa}
            disabled={Boolean(busy) || !mfaPassword || !isSixDigitCode(mfaCode)}
            danger
          />
        </>
      )}
    </Card>
  );
}

interface SessionSecuritySectionProps {
  busy: AccountBusyAction;
  onLogout: () => void;
}

export function SessionSecuritySection({ busy, onLogout }: SessionSecuritySectionProps) {
  return (
    <Card>
      <Text style={styles.cardTitle}>Session security</Text>
      <Text style={styles.bodyText}>
        Logging out revokes the active server-side session generation before secure local credentials are removed. If the server cannot confirm revocation during a temporary outage, the app keeps the credentials so logout can be retried safely.
      </Text>
      <ActionButton
        label={busy === 'logout' ? 'Revoking session…' : 'Log out'}
        onPress={onLogout}
        disabled={Boolean(busy)}
        danger
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#e8edff', marginBottom: 5 },
  muted: { color: '#9aa7c7', fontSize: 13, lineHeight: 19 },
  bodyText: { color: '#b9c3dd', fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 12 },
  verificationRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 15 },
  verificationCopy: { flex: 1 },
  rowTitle: { color: '#e8edff', fontSize: 14, fontWeight: '700', marginBottom: 3 },
  valueText: { color: '#9aa7c7', fontSize: 13 },
  secretPanel: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#854d0e',
    backgroundColor: '#291f0b',
    borderRadius: 10,
    padding: 12,
  },
  secretTitle: { color: '#fde68a', fontSize: 14, fontWeight: '800', marginBottom: 5 },
  secretWarning: { color: '#fcd34d', fontSize: 12, lineHeight: 18, marginBottom: 10 },
  secretLabel: { color: '#d6c48b', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginTop: 6 },
  secretValue: { color: '#fff7d6', fontSize: 14, lineHeight: 21, marginTop: 3 },
  uriValue: { color: '#fff7d6', fontSize: 11, lineHeight: 17, marginTop: 3 },
});
