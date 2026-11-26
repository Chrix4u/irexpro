import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { api, setAccessToken } from '@/lib/api';
import { clearTokens, saveTokens } from '@/lib/secure-storage';
import { establishLogin } from './login-screen.logic';
import { useAuth } from '@/context/auth-context';

export default function LoginScreen({
  onForgotPassword,
  onCantAccessAccount,
}: {
  onForgotPassword?: () => void;
  /** Opens the pre-auth account-appeal flow (restricted/locked accounts). */
  onCantAccessAccount?: () => void;
}) {
  const { setSession } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitting = useRef(false);

  async function handleLogin() {
    if (submitting.current || !email.trim() || !password) return;
    submitting.current = true;
    setLoading(true);
    setError(null);
    try {
      const session = await establishLogin({
        login: (credentials) => api.login(credentials),
        me: () => api.me(),
        setAccessToken,
        saveTokens,
        clearTokens,
      }, email, password);
      setSession(session.user, session.accessToken);
    } catch {
      setError('Unable to sign in. Check your details and connection, then try again.');
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
      <Text accessibilityRole="header" style={styles.title}>iRexPro</Text>
      <Text style={styles.subtitle}>Log in to your account</Text>

      <TextInput
        style={styles.input}
        placeholder="Email or international phone (+233...)"
        placeholderTextColor="#6b7494"
        accessibilityLabel="Email or phone number"
        autoComplete="username"
        editable={!loading}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#6b7494"
        accessibilityLabel="Password"
        autoComplete="current-password"
        editable={!loading}
        value={password}
        onChangeText={setPassword}
        returnKeyType="go"
        onSubmitEditing={handleLogin}
        secureTextEntry
      />

      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Forgot password"
        disabled={loading}
        accessibilityState={{ disabled: loading }}
        onPress={onForgotPassword}
        style={styles.forgotLink}
      >
        <Text style={styles.forgotLinkText}>Forgot password?</Text>
      </Pressable>

      {onCantAccessAccount ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Can't access your account?"
          disabled={loading}
          accessibilityState={{ disabled: loading }}
          onPress={onCantAccessAccount}
          style={styles.helpLink}
        >
          <Text style={styles.helpLinkText}>Can&apos;t access your account?</Text>
        </Pressable>
      ) : null}

      <Pressable accessibilityRole="button" accessibilityLabel="Log in" accessibilityState={{ disabled: loading || !email.trim() || !password, busy: loading }} style={[styles.button, (loading || !email.trim() || !password) && styles.disabled]} onPress={handleLogin} disabled={loading || !email.trim() || !password}>
        {loading ? (
          <ActivityIndicator color="#06231f" />
        ) : (
          <Text style={styles.buttonText}>Log in</Text>
        )}
      </Pressable>

      <Text style={styles.muted}>
        Secure sign-in
      </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1020',
  },
  content: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  disabled: { opacity: 0.5 },
  title: { fontSize: 28, fontWeight: '700', color: '#e8edff', marginBottom: 4 },
  subtitle: { fontSize: 15, color: '#9aa7c7', marginBottom: 24 },
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
  button: {
    backgroundColor: '#14b8a6',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  buttonText: { color: '#06231f', fontWeight: '700', fontSize: 16 },
  error: { color: '#f87171', fontSize: 14, marginBottom: 12 },
  muted: { color: '#6b7494', fontSize: 12, lineHeight: 18 },
  forgotLink: { alignSelf: 'flex-end', minHeight: 46, justifyContent: 'center', marginBottom: 4 },
  forgotLinkText: { color: '#14b8a6', fontSize: 14, fontWeight: '500' },
  helpLink: { alignSelf: 'flex-end', minHeight: 46, justifyContent: 'center', marginBottom: 16 },
  helpLinkText: { color: '#9aa7c7', fontSize: 13 },
});
