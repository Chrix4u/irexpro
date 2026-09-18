import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiClientError } from '@irexpro/api-client';
import { api } from '../lib/api';
import {
  isValidPhoneResetCode,
  isValidResetPassword,
} from './password-recovery.logic';

type Props = {
  identifier: string;
  onBack: () => void;
  onCompleted: () => Promise<void> | void;
};

export default function ResetPasswordScreen({
  identifier,
  onBack,
  onCompleted,
}: Props) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () =>
      Boolean(identifier.trim()) &&
      isValidPhoneResetCode(code) &&
      isValidResetPassword(password) &&
      password === confirmPassword,
    [code, confirmPassword, identifier, password],
  );

  async function submit() {
    if (!canSubmit || loading) return;

    setLoading(true);
    setError(null);
    try {
      await api.resetPassword({
        identifier: identifier.trim(),
        code: code.trim(),
        password,
      });
      setCompleted(true);
      await onCompleted();
    } catch (err) {
      if (err instanceof ApiClientError && (err.statusCode === 400 || err.statusCode === 401)) {
        setError(
          'This reset code is invalid or has expired. Request a new code and try again.',
        );
      } else {
        setError('Unable to reset your password right now. Check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.eyebrow}>ACCOUNT RECOVERY</Text>
      <Text style={styles.title}>Create a new password</Text>
      <Text style={styles.subtitle}>
        Enter the 6-digit code sent to {identifier || 'your phone'}.
      </Text>

      {completed ? (
        <View style={styles.successBox} accessibilityRole="alert">
          <Text style={styles.successTitle}>Password updated</Text>
          <Text style={styles.successText}>
            Existing sessions were revoked. Sign in again with your new password.
          </Text>
          <Pressable style={styles.button} onPress={onBack}>
            <Text style={styles.buttonText}>Back to login</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <TextInput
            accessibilityLabel="Password reset code"
            style={styles.input}
            placeholder="6-digit code"
            placeholderTextColor="#6b7494"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
          />

          <TextInput
            accessibilityLabel="New password"
            style={styles.input}
            placeholder="New password"
            placeholderTextColor="#6b7494"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
          />
          <TextInput
            accessibilityLabel="Confirm new password"
            style={styles.input}
            placeholder="Confirm new password"
            placeholderTextColor="#6b7494"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
          />

          <Text style={styles.hint}>
            Use at least 12 characters with at least one letter and one number.
          </Text>

          {error ? (
            <View style={styles.errorBox} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            style={[styles.button, (!canSubmit || loading) && styles.disabled]}
            disabled={!canSubmit || loading}
            onPress={() => void submit()}
          >
            {loading ? (
              <ActivityIndicator color="#06231f" />
            ) : (
              <Text style={styles.buttonText}>Reset password</Text>
            )}
          </Pressable>

          <Pressable style={styles.backLink} onPress={onBack}>
            <Text style={styles.backLinkText}>Back to login</Text>
          </Pressable>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1020',
    padding: 24,
    justifyContent: 'center',
  },
  eyebrow: {
    color: '#5eead4',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  title: { fontSize: 24, fontWeight: '700', color: '#e8edff', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#9aa7c7', marginBottom: 20, lineHeight: 20 },
  input: {
    backgroundColor: '#131a2e',
    borderColor: '#243049',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    color: '#e8edff',
    marginBottom: 12,
    fontSize: 16,
  },
  hint: { color: '#7f8ba8', fontSize: 12, lineHeight: 18, marginBottom: 14 },
  button: {
    backgroundColor: '#14b8a6',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#06231f', fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.45 },
  backLink: { alignSelf: 'center', marginTop: 20 },
  backLinkText: { color: '#14b8a6', fontSize: 15, fontWeight: '500' },
  errorBox: {
    borderColor: '#7f1d1d',
    backgroundColor: '#2b1118',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  errorText: { color: '#fecaca', fontSize: 13, lineHeight: 18 },
  successBox: {
    borderColor: '#0f766e',
    backgroundColor: '#0b2728',
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  successTitle: { color: '#99f6e4', fontSize: 16, fontWeight: '700' },
  successText: { color: '#cbd5e1', fontSize: 13, lineHeight: 19, marginBottom: 4 },
});
