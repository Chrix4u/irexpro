import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
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
import OnboardingProfileScreen from './src/screens/OnboardingProfileScreen';
import OnboardingEligibilityScreen from './src/screens/OnboardingEligibilityScreen';
import { parseBrokerOAuthHandoffLink } from './src/screens/broker-screen-oauth.logic';

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

type Tab =
  | 'dashboard'
  | 'profile-onboarding'
  | 'eligibility-onboarding'
  | 'ai'
  | 'brokers'
  | 'live'
  | 'account'
  | 'payments';

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
  const screenProgress = useRef(new Animated.Value(1)).current;
  const navigationBusy = useRef(false);
  const initialDeepLinkHandled = useRef(false);
  const [authScreen, setAuthScreen] = useState<AuthScreen>('login');
  const [phoneResetIdentifier, setPhoneResetIdentifier] = useState<string | null>(null);

  const navigateTab = useCallback((next: Tab) => {
    if (next === tab || navigationBusy.current) return;
    navigationBusy.current = true;
    Animated.timing(screenProgress, {
      toValue: 0,
      duration: 90,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      setTab(next);
      screenProgress.setValue(0);
      Animated.timing(screenProgress, {
        toValue: 1,
        duration: 190,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        navigationBusy.current = false;
      });
    });
  }, [screenProgress, tab]);

  useEffect(() => {
    if (!user || initialDeepLinkHandled.current) return;
    let cancelled = false;
    void Linking.getInitialURL().then((url) => {
      if (cancelled || !url || !parseBrokerOAuthHandoffLink(url)) return;
      initialDeepLinkHandled.current = true;
      navigateTab('brokers');
    });
    return () => {
      cancelled = true;
    };
  }, [navigateTab, user]);

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
          <Animated.View
            style={[
              styles.screenStage,
              {
                opacity: screenProgress,
                transform: [
                  {
                    translateY: screenProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [8, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            {tab === 'dashboard' && (
              <DashboardScreen
                onOpenProfile={() => navigateTab('profile-onboarding')}
                onOpenEligibility={() => navigateTab('eligibility-onboarding')}
                onOpenBroker={() => navigateTab('brokers')}
              />
            )}
            {tab === 'profile-onboarding' && (
              <OnboardingProfileScreen
                onContinue={() => navigateTab('eligibility-onboarding')}
                onBack={() => navigateTab('dashboard')}
              />
            )}
            {tab === 'eligibility-onboarding' && (
              <OnboardingEligibilityScreen
                onContinue={() => navigateTab('brokers')}
                onEditProfile={() => navigateTab('profile-onboarding')}
                onBack={() => navigateTab('dashboard')}
              />
            )}
            {tab === 'ai' && <AiTradingScreen />}
            {tab === 'brokers' && <BrokerScreen />}
            {tab === 'live' && <LiveAccountScreen />}
            {tab === 'account' && (
              <AccountScreen onOpenPayments={() => navigateTab('payments')} />
            )}
            {tab === 'payments' && <PaymentsScreen />}
          </Animated.View>
        </SafeAreaView>
        <SafeAreaView
          style={styles.tabBar}
          edges={['bottom', 'left', 'right']}
          accessibilityRole="tablist"
        >
          <TabButton
            label="Home"
            active={tab === 'dashboard'}
            onPress={() => navigateTab('dashboard')}
          />
          <TabButton
            label="AI"
            active={tab === 'ai'}
            onPress={() => navigateTab('ai')}
          />
          <TabButton
            label="Activity"
            active={tab === 'live'}
            onPress={() => navigateTab('live')}
          />
          <TabButton
            label="Broker"
            active={tab === 'brokers'}
            onPress={() => navigateTab('brokers')}
          />
          <TabButton
            label="Account"
            active={tab === 'account' || tab === 'payments'}
            onPress={() => navigateTab('account')}
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
  screenStage: { flex: 1 },
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
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: '#243049',
    backgroundColor: '#0d1426',
    paddingHorizontal: 8,
    paddingTop: 7,
    paddingBottom: 8,
  },
  tab: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: '#102c31',
    borderWidth: 1,
    borderColor: '#155e75',
  },
  tabLabel: { color: '#6b7494', fontSize: 10, fontWeight: '700' },
  tabLabelActive: { color: '#5eead4', fontWeight: '900' },
});
