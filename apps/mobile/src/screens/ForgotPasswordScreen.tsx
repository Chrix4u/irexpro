import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import { api } from '../lib/api';

/**
 * ForgotPasswordScreen — Sprint 28.
 *
 * Wired to the real POST /auth/forgot-password endpoint via the shared API
 * client. The backend ALWAYS returns the same generic message — no account
 * enumeration. We show the same generic message here.
 *
 * Accepts email OR international phone number as the identifier.
 *
 * Email reset links remain on the verified HTTPS web flow. Phone-only users
 * can continue directly into the native 6-digit-code reset flow after
 * requesting instructions. Raw recovery credentials are never placed in a
 * custom mobile URI scheme.
 */
export default function ForgotPasswordScreen({
  onBack,
  onUseSmsCode,
}: {
  onBack: () => void;
  onUseSmsCode: (identifier: string) => void;
}) {
  const [identifier, setIdentifier] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState(false);
  const submitting = useRef(false);

  async function handleSubmit() {
    if (submitting.current || !identifier.trim()) return;
    submitting.current = true;
    setLoading(true);
    setError(false);
    try {
      await api.forgotPassword({ identifier: identifier.trim() });
      setSubmitted(true);
    } catch {
      // Do not disclose provider errors or imply an account exists.
      setError(true);
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>Forgot password</Text>
      <Text style={styles.subtitle}>
        Enter your email or phone number to receive reset instructions
      </Text>

      {submitted ? (
        <View style={styles.infoBox}>
          <Text accessibilityRole="alert" style={styles.infoText}>
            If an account exists for this identifier, password reset instructions
            have been sent. Check your email (including spam) or phone messages.
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.codeButton}
            onPress={() => onUseSmsCode(identifier.trim())}
          >
            <Text style={styles.codeButtonText}>I received an SMS code</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Email or +233241234567"
            placeholderTextColor="#6b7494"
            accessibilityLabel="Email or phone number"
            autoComplete="username"
            editable={!loading}
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
          />
          {error ? <Text accessibilityRole="alert" style={styles.error}>Unable to confirm your request. Check your connection and try again.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Send reset instructions" accessibilityState={{ disabled: loading || !identifier.trim(), busy: loading }} style={[styles.button, (loading || !identifier.trim()) && styles.disabled]} onPress={handleSubmit} disabled={loading || !identifier.trim()}>
            {loading ? (
              <ActivityIndicator color="#06231f" />
            ) : (
              <Text style={styles.buttonText}>Send reset instructions</Text>
            )}
          </Pressable>
        </>
      )}

      <Pressable accessibilityRole="button" accessibilityLabel="Back to login" accessibilityState={{ disabled: loading }} disabled={loading} style={styles.backLink} onPress={onBack}>
        <Text style={styles.backLinkText}>Back to login</Text>
      </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1020' },
  content: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  error: { color: '#f87171', fontSize: 14, marginBottom: 12 },
  disabled: { opacity: 0.5 },
  title: { fontSize: 24, fontWeight: '700', color: '#e8edff', marginBottom: 4 },
  subtitle: { fontSize: 15, color: '#9aa7c7', marginBottom: 24 },
  input: {
    backgroundColor: '#131a2e', borderColor: '#243049', borderWidth: 1,
    borderRadius: 10, padding: 14, color: '#e8edff', marginBottom: 12, fontSize: 16,
  },
  button: { backgroundColor: '#14b8a6', borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 16 },
  buttonText: { color: '#06231f', fontWeight: '700', fontSize: 16 },
  infoBox: { backgroundColor: 'rgba(13,148,136,0.1)', borderColor: 'rgba(13,148,136,0.3)', borderWidth: 1, borderRadius: 10, padding: 16, marginBottom: 16 },
  infoText: { color: '#5eead4', fontSize: 14, lineHeight: 20 },
  codeButton: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#14b8a6',
    borderRadius: 9,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  codeButtonText: { color: '#5eead4', fontSize: 14, fontWeight: '700' },
  backLink: { alignSelf: 'center', minHeight: 46, justifyContent: 'center', marginTop: 16 },
  backLinkText: { color: '#14b8a6', fontSize: 15, fontWeight: '500' },
});
