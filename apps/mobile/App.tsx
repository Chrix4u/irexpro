import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/context/auth-context';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import LoginScreen from './src/screens/LoginScreen';
import ForgotPasswordScreen from './src/screens/ForgotPasswordScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import AccountScreen from './src/screens/account/AccountScreen';
import PaymentsScreen from './src/screens/PaymentsScreen';

/**
 * iRexPro mobile app entry (Expo + React Native + TypeScript).
 *
 * Auth flow:
 *   LoginScreen → api.login(identifier, password) → { accessToken, refreshToken }
 *   → persist both tokens in Expo SecureStore → api.me(accessToken)
 *   → AuthUser → show authenticated tabs.
 *
 * On app launch, AuthProvider validates the stored access token and, on a 401,
 * rotates the SecureStore refresh token through /auth/refresh. Transient API
 * failures preserve the encrypted-at-rest credentials and expose a safe retry
 * path instead of forcing a new login.
 *
 * Tokens are never stored in AsyncStorage. The app talks only to the public API
 * (EXPO_PUBLIC_API_BASE_URL), never directly to the internal AI engine.
 */

type Tab = 'dashboard' | 'account' | 'payments';

export default function App() {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

function AppShell() {
  const { user, loading, error, restoreSession } = useAuth();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  if (loading && !user) {
    return (
      <SafeAreaView style={styles.shell}>
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <Text style={styles.loadingText}>Restoring session…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.shell}>
        {error ? (
          <View
            style={styles.restoreAlert}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            <Text style={styles.restoreAlertText}>{error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry session restoration"
              style={styles.retryButton}
              onPress={() => void restoreSession()}
            >
              <Text style={styles.retryButtonText}>Retry session</Text>
            </Pressable>
          </View>
        ) : null}
        {showForgotPassword ? (
          <ForgotPasswordScreen onBack={() => setShowForgotPassword(false)} />
        ) : (
          <LoginScreen onForgotPassword={() => setShowForgotPassword(true)} />
        )}
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.shell}>
      <SafeAreaView style={styles.content} edges={['top', 'left', 'right']}>
        {tab === 'dashboard' && <DashboardScreen />}
        {tab === 'account' && <AccountScreen />}
        {tab === 'payments' && <PaymentsScreen />}
      </SafeAreaView>
      <SafeAreaView
        style={styles.tabBar}
        edges={['bottom', 'left', 'right']}
        accessibilityRole="tablist"
      >
        <TabButton
          label="Dashboard"
          active={tab === 'dashboard'}
          onPress={() => setTab('dashboard')}
        />
        <TabButton
          label="Payments"
          active={tab === 'payments'}
          onPress={() => setTab('payments')}
        />
        <TabButton
          label="Account"
          active={tab === 'account'}
          onPress={() => setTab('account')}
        />
      </SafeAreaView>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.tab, active && styles.tabActive]}
    >
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: '#0b1020' },
  content: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#9aa7c7', fontSize: 16 },
  restoreAlert: {
    marginTop: 48,
    marginHorizontal: 20,
    borderWidth: 1,
    borderColor: '#7c2d12',
    backgroundColor: '#2a1714',
    borderRadius: 10,
    padding: 14,
  },
  restoreAlertText: { color: '#fed7aa', fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 4 },
  retryButtonText: { color: '#2dd4bf', fontSize: 13, fontWeight: '700' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#243049',
    paddingBottom: 16,
  },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabActive: { borderTopWidth: 2, borderTopColor: '#14b8a6' },
  tabLabel: { color: '#6b7494', fontSize: 13 },
  tabLabelActive: { color: '#14b8a6', fontWeight: '700' },
});
