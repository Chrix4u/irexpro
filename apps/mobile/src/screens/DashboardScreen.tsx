import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { OnboardingStatus } from '@irexpro/types';
import { api } from '../lib/api';
import { destinationForOnboardingStep } from './onboarding-screen.logic';
import { ActionButton, Card, SectionHeader, StatusPill, palette } from '../components/ui';

export default function DashboardScreen({
  onOpenProfile,
  onOpenEligibility,
  onOpenBroker,
}: {
  onOpenProfile: () => void;
  onOpenEligibility: () => void;
  onOpenBroker: () => void;
}) {
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.getOnboardingStatus();
        if (!cancelled) {
          setOnboarding(status);
          setError(null);
        }
      } catch (requestError) {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Failed to load onboarding status');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const nextAction = useMemo(() => {
    if (!onboarding) return null;
    const destination = destinationForOnboardingStep(onboarding.nextStep);
    if (destination === 'profile-onboarding') {
      return { label: 'Complete trader profile', action: onOpenProfile };
    }
    if (destination === 'eligibility-onboarding') {
      return { label: 'Complete eligibility', action: onOpenEligibility };
    }
    if (destination === 'brokers') {
      return { label: 'Connect broker', action: onOpenBroker };
    }
    return null;
  }, [onOpenBroker, onOpenEligibility, onOpenProfile, onboarding]);

  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>IREXPRO</Text>
      <Text style={styles.title}>Home</Text>
      <Text style={styles.subtitle}>Your setup and AI trading readiness at a glance.</Text>

      <Card>
        <SectionHeader
          title="Ready for AI Trading?"
          description="Readiness is verified by the server. The mobile app does not bypass profile, eligibility, broker or model gates."
          right={
            onboarding ? (
              <StatusPill
                status={onboarding.canStartTrading ? 'READY' : 'SETUP_REQUIRED'}
                tone={onboarding.canStartTrading ? 'positive' : 'warning'}
              />
            ) : undefined
          }
        />

        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={palette.accent} />
            <Text style={styles.muted}>Checking readiness…</Text>
          </View>
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : onboarding ? (
          <>
            <ReadinessRow label="Profile" complete={onboarding.profileCompleted} />
            <ReadinessRow label="Eligibility" complete={onboarding.eligibilityCompleted} />
            <ReadinessRow label="Broker" complete={onboarding.brokerConnected} />
            <ReadinessRow label="Trading readiness" complete={onboarding.canStartTrading} />
            {nextAction ? (
              <ActionButton label={nextAction.label} onPress={nextAction.action} />
            ) : (
              <Text style={styles.readyCopy}>
                Setup gates are complete. Use the AI tab to manage server-approved AI Trading.
              </Text>
            )}
          </>
        ) : null}
      </Card>

      <Card>
        <SectionHeader
          title="Mobile onboarding"
          description="Profile, adult-age/KYC readiness, jurisdiction disclosures and broker setup can now be completed from the native app."
        />
        <ActionButton label="Trader profile" secondary onPress={onOpenProfile} />
        <ActionButton label="Eligibility & disclosures" secondary onPress={onOpenEligibility} />
        <ActionButton label="Broker connections" secondary onPress={onOpenBroker} />
      </Card>
    </View>
  );
}

function ReadinessRow({ label, complete }: { label: string; complete: boolean }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusText}>{label}</Text>
      <StatusPill status={complete ? 'COMPLETE' : 'PENDING'} tone={complete ? 'positive' : 'warning'} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg, padding: 18 },
  eyebrow: { color: palette.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, marginTop: 8 },
  title: { fontSize: 27, fontWeight: '800', color: palette.text, marginTop: 6 },
  subtitle: { color: palette.muted, fontSize: 14, marginTop: 5, marginBottom: 18 },
  loadingRow: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 14 },
  muted: { color: palette.muted, fontSize: 13 },
  error: { color: palette.errorText, fontSize: 13, lineHeight: 19, marginTop: 12 },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: palette.cardBorder,
  },
  statusText: { color: palette.body, fontSize: 14, fontWeight: '600' },
  readyCopy: { color: palette.success.text, fontSize: 13, lineHeight: 19, marginTop: 14 },
});
