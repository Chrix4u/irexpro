import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { useAuth } from '@/context/auth-context';
import { api } from '../lib/api';
import type { OnboardingStatus } from '@irexpro/types';

/**
 * Mobile dashboard — novice AI-first flow.
 *
 * Keeps eligibility and broker readiness visible without exposing strategy,
 * risk-parameter, or execution-mode configuration to novice users.
 */
export default function DashboardScreen() {
  const { user } = useAuth();
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await api.getOnboardingStatus();
        if (!cancelled) setOnboarding(status);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load onboarding status');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Home</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Welcome back</Text>
        <Text style={styles.muted}>{user ? user.email ?? user.phone ?? 'Trader' : 'Not signed in'}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Ready for AI Trading?</Text>
        {loading ? (
          <ActivityIndicator color="#14b8a6" />
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : onboarding ? (
          <View>
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>{onboarding.profileCompleted ? '✅' : '⬜'} Profile</Text>
              <Text style={onboarding.profileCompleted ? styles.doneText : styles.pendingText}>
                {onboarding.profileCompleted ? 'Done' : 'Pending'}
              </Text>
            </View>
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>{onboarding.eligibilityCompleted ? '✅' : '⬜'} Eligibility</Text>
              <Text style={onboarding.eligibilityCompleted ? styles.doneText : styles.pendingText}>
                {onboarding.eligibilityCompleted ? 'Done' : 'Pending'}
              </Text>
            </View>
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>{onboarding.brokerConnected ? '✅' : '⬜'} Broker</Text>
              <Text style={onboarding.brokerConnected ? styles.doneText : styles.pendingText}>
                {onboarding.brokerConnected ? 'Connected' : 'Pending'}
              </Text>
            </View>
            <View style={[styles.statusRow, { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#243049' }]}>
              <Text style={styles.cardTitle}>Can start AI Trading</Text>
              <Text style={onboarding.canStartTrading ? styles.doneText : styles.pendingText}>
                {onboarding.canStartTrading ? 'Yes' : 'No'}
              </Text>
            </View>
            {!onboarding.canStartTrading && onboarding.missingSteps.length > 0 && (
              <Text style={styles.muted}>
                Next step: {onboarding.nextStep.replace(/_/g, ' ').toLowerCase()}
              </Text>
            )}
            <Text style={[styles.muted, { marginTop: 8, fontSize: 12 }]}>
              Complete any missing profile or eligibility step on the web, then use the Broker and AI tabs here.
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1020', padding: 20 },
  title: { fontSize: 24, fontWeight: '700', color: '#e8edff', marginTop: 12, marginBottom: 12 },
  card: { backgroundColor: '#131a2e', borderColor: '#243049', borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#e8edff', marginBottom: 6 },
  muted: { color: '#9aa7c7', fontSize: 14, lineHeight: 20 },
  errorText: { color: '#ef4444', fontSize: 14 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  statusText: { color: '#e8edff', fontSize: 14 },
  doneText: { color: '#10b981', fontSize: 13, fontWeight: '600' },
  pendingText: { color: '#f59e0b', fontSize: 13, fontWeight: '600' },
});
