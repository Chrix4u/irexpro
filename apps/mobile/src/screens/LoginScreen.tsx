import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { api, setAccessToken } from '@/lib/api';
import { saveTokens } from '@/lib/secure-storage';
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

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      const tokens = await api.login({ identifier: email, password });
      await saveTokens(tokens);
      setAccessToken(tokens.accessToken);
      const me = await api.me();
      setSession(me, tokens.accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>iRexPro</Text>
      <Text style={styles.subtitle}>Log in to your account</Text>

      <TextInput
        style={styles.input}
        placeholder="Email or international phone (+233...)"
        placeholderTextColor="#6b7494"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#6b7494"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Forgot password"
        onPress={onForgotPassword}
        style={styles.forgotLink}
      >
        <Text style={styles.forgotLinkText}>Forgot password?</Text>
      </Pressable>

      {onCantAccessAccount ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Can't access your account?"
          onPress={onCantAccessAccount}
          style={styles.helpLink}
        >
          <Text style={styles.helpLinkText}>Can&apos;t access your account?</Text>
        </Pressable>
      ) : null}

      <Pressable style={styles.button} onPress={handleLogin} disabled={loading}>
        {loading ? (
          <ActivityIndicator color="#06231f" />
        ) : (
          <Text style={styles.buttonText}>Log in</Text>
        )}
      </Pressable>

      <Text style={styles.muted}>
        Your session tokens are stored with Expo SecureStore using the iOS Keychain or Android
        Keystore. They are never stored in AsyncStorage.
      </Text>
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
  forgotLink: { alignSelf: 'flex-end', marginBottom: 4 },
  forgotLinkText: { color: '#14b8a6', fontSize: 14, fontWeight: '500' },
  helpLink: { alignSelf: 'flex-end', minHeight: 46, justifyContent: 'center', marginBottom: 16 },
  helpLinkText: { color: '#9aa7c7', fontSize: 13 },
});
