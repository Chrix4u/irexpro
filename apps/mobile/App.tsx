import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/context/auth-context';
import { RealtimeProvider } from '@/context/realtime-context';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import LoginScreen from './src/screens/LoginScreen';
import ForgotPasswordScreen from './src/screens/ForgotPasswordScreen';
import ResetPasswordScreen from './src/screens/ResetPasswordScreen';
import AppealScreen from './src/screens/AppealScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import AccountScreen from './src/screens/account/AccountScreen';
import PaymentsScreen from './src/screens/PaymentsScreen';
import BrokerScreen from './src/screens/BrokerScreen';
import LiveAccountScreen from './src/screens/LiveAccountScreen';
import AiTradingScreen from './src/screens/AiTradingScreen';

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
 *
 * RealtimeProvider is mounted only inside the authenticated branch. Logout or
 * session revocation therefore unmounts the provider and disconnects the
 * realtime socket so no authenticated channel outlives the session.
 */

type Tab = 'dashboard' | 'ai' | 'brokers' | 'live' | 'account' | 'payments';

/** Unauthenticated stack: login, forgot-password, and the pre-auth appeal. */
type AuthScreen = 'login' | 'forgot-password' | 'appeal';

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
  const { user, loading, error, restoreSession, clearSession } = useAuth();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [authScreen, setAuthScreen] = useState<AuthScreen>('login');
  const [phoneResetIdentifier, setPhoneResetIdentifier] = useState<string | null>(null);

  if (phoneResetIdentifier) {
    return (
      <SafeAreaView style={styles.shell}>
        <ResetPasswordScreen
          identifier={phoneResetIdentifier}
          onBack={() => {
            setPhoneResetIdentifier(null);
            setAuthScreen('login');
          }}
          onCompleted={async () => {
            await clearSession();
          }}
        />
      </SafeAreaView>
    );
  }

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
        {authScreen === 'forgot-password' ? (
          <ForgotPasswordScreen
            onBack={() => setAuthScreen('login')}
            onUseSmsCode={(identifier) => setPhoneResetIdentifier(identifier)}
          />
        ) : authScreen === 'appeal' ? (
          <AppealScreen onBack={() => setAuthScreen('login')} />
        ) : (
          <LoginScreen
            onForgotPassword={() => setAuthScreen('forgot-password')}
            onCantAccessAccount={() => setAuthScreen('appeal')}
          />
        )}
      </SafeAreaView>
    );
  }

  return (
    <RealtimeProvider>
      <View style={styles.shell}>
        <SafeAreaView style={styles.content} edges={['top', 'left', 'right']}>
          {tab === 'dashboard' && <DashboardScreen />}
          {tab === 'ai' && <AiTradingScreen />}
          {tab === 'brokers' && <BrokerScreen />}
          {tab === 'live' && <LiveAccountScreen />}
          {tab === 'account' && <AccountScreen onOpenPayments={() => setTab('payments')} />}
          {tab === 'payments' && <PaymentsScreen />}
        </SafeAreaView>
        <SafeAreaView
          style={styles.tabBar}
          edges={['bottom', 'left', 'right']}
          accessibilityRole="tablist"
        >
          <TabButton
            label="Home"
            active={tab === 'dashboard'}
            onPress={() => setTab('dashboard')}
          />
          <TabButton
            label="AI"
            active={tab === 'ai'}
            onPress={() => setTab('ai')}
          />
          <TabButton
            label="Activity"
            active={tab === 'live'}
            onPress={() => setTab('live')}
          />
          <TabButton
            label="Broker"
            active={tab === 'brokers'}
            onPress={() => setTab('brokers')}
          />
          <TabButton
            label="Account"
            active={tab === 'account' || tab === 'payments'}
            onPress={() => setTab('account')}
          />
        </SafeAreaView>
      </View>
    </RealtimeProvider>
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
  tabLabel: { color: '#6b7494', fontSize: 11 },
  tabLabelActive: { color: '#14b8a6', fontWeight: '700' },
});
