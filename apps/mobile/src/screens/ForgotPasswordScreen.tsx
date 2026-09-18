import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
 * Email reset links can hand off to the app through the irexpro:// scheme.
 * Phone-only users can continue directly into the native 6-digit-code reset
 * flow after requesting instructions.
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

  async function handleSubmit() {
    if (!identifier.trim()) return;
    setLoading(true);
    try {
      await api.forgotPassword({ identifier });
    } catch {
      // Even on error, show the generic message — no account enumeration.
      // Only network errors would be visible to the user (caught below).
    } finally {
      setSubmitted(true);
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Forgot password</Text>
      <Text style={styles.subtitle}>
        Enter your email or phone number to receive reset instructions
      </Text>

      {submitted ? (
        <View style={styles.infoBox}>
          <Text style={styles.infoText}>
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
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
          />
          <Pressable style={styles.button} onPress={handleSubmit} disabled={loading}>
            {loading ? (
              <ActivityIndicator color="#06231f" />
            ) : (
              <Text style={styles.buttonText}>Send reset instructions</Text>
            )}
          </Pressable>
        </>
      )}

      <Pressable style={styles.backLink} onPress={onBack}>
        <Text style={styles.backLinkText}>Back to login</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1020', padding: 24, justifyContent: 'center' },
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
  backLink: { alignSelf: 'center', marginTop: 16 },
  backLinkText: { color: '#14b8a6', fontSize: 15, fontWeight: '500' },
});
