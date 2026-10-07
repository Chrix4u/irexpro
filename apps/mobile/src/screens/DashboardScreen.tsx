import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import type { OnboardingStatus } from '@irexpro/types';
import { api } from '../lib/api';
import {
  ActionButton,
  Banner,
  Card,
  SectionHeader,
  StatusPill,
  palette,
} from '../components/ui';

export default function DashboardScreen({
  onOpenProfile,
  onOpenEligibility,
  onOpenBroker,
}: {
  onOpenProfile: () => void;
  onOpenEligibility: () => void;
  onOpenBroker: () => void;
}) {
  const { width } = useWindowDimensions();
  const compact = width < 390;
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [brokerTransportConnected, setBrokerTransportConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [onboardingResult, brokerResult] = await Promise.allSettled([
      api.getOnboardingStatus(),
      api.listBrokerConnections(),
    ]);

    if (onboardingResult.status === 'fulfilled') {
      setOnboarding(onboardingResult.value);
      setError(null);
    } else {
      setError(
        onboardingResult.reason instanceof Error
          ? onboardingResult.reason.message
          : 'Failed to load onboarding status',
      );
    }

    if (brokerResult.status === 'fulfilled') {
      setBrokerTransportConnected(
        brokerResult.value.some((connection) => connection.status === 'CONNECTED'),
      );
    } else {
      setBrokerTransportConnected(null);
    }

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const effectiveBrokerConnected =
    brokerTransportConnected ?? onboarding?.brokerConnected ?? false;

  const brokerReadinessMismatch =
    onboarding !== null &&
    brokerTransportConnected !== null &&
    onboarding.brokerConnected !== brokerTransportConnected;

  const nextAction = useMemo(() => {
    if (!onboarding) return null;
    if (onboarding.nextStep === 'PROFILE') {
      return { label: 'Complete trader profile', action: onOpenProfile };
    }
    if (onboarding.nextStep === 'ELIGIBILITY') {
      return { label: 'Complete eligibility', action: onOpenEligibility };
    }
    if (onboarding.nextStep === 'BROKER_CONNECTION') {
      return {
        label: effectiveBrokerConnected
          ? 'Review broker readiness'
          : 'Connect broker',
        action: onOpenBroker,
      };
    }
    return null;
  }, [effectiveBrokerConnected, onOpenBroker, onOpenEligibility, onOpenProfile, onboarding]);

  const completedSteps = onboarding
    ? [
        onboarding.profileCompleted,
        onboarding.eligibilityCompleted,
        effectiveBrokerConnected,
      ].filter(Boolean).length
    : 0;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={palette.accent}
          colors={[palette.accent]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      <View style={styles.hero}>
        <View style={styles.heroGlow} />
        <Text style={styles.eyebrow}>IREXPRO · MOBILE</Text>
        <Text style={styles.title}>Trading command center</Text>
        <Text style={styles.subtitle}>
          Setup status, broker readiness and AI trading access in one place.
        </Text>

        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatValue}>{completedSteps}/3</Text>
            <Text style={styles.heroStatLabel}>Setup steps</Text>
          </View>
          <View style={styles.heroDivider} />
          <View style={styles.heroStat}>
            <Text
              style={[
                styles.heroStatValue,
                onboarding?.canStartTrading
                  ? styles.heroStatReady
                  : styles.heroStatPending,
              ]}
            >
              {onboarding?.canStartTrading ? 'READY' : 'CHECK'}
            </Text>
            <Text style={styles.heroStatLabel}>Trading gate</Text>
          </View>
        </View>
      </View>

      {error ? <Banner variant="error">{error}</Banner> : null}

      {brokerReadinessMismatch ? (
        <Banner variant="info">
          {brokerTransportConnected
            ? 'Broker transport is connected, but trading readiness has not reconciled yet. Trading remains blocked until the server readiness gate confirms it.'
            : 'Trading readiness still references a broker connection, but the live broker list is not currently connected. Refresh Broker before starting AI Trading.'}
        </Banner>
      ) : null}

      <Card style={styles.readinessCard}>
        <View
          style={[
            styles.readinessHeader,
            compact && styles.readinessHeaderCompact,
          ]}
        >
          <View style={styles.readinessHeaderCopy}>
            <Text style={styles.readinessTitle}>AI trading readiness</Text>
            <Text style={styles.readinessDescription}>
              Every gate is verified by the server. Mobile cannot bypass
              profile, eligibility, broker or model controls.
            </Text>
          </View>
          <View
            style={[
              styles.readinessStatusSlot,
              compact && styles.readinessStatusSlotCompact,
            ]}
          >
            <StatusPill
              status={
                loading
                  ? 'CHECKING'
                  : onboarding?.canStartTrading
                    ? 'READY'
                    : 'SETUP_REQUIRED'
              }
              tone={
                loading
                  ? 'neutral'
                  : onboarding?.canStartTrading
                    ? 'positive'
                    : 'warning'
              }
            />
          </View>
        </View>

        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={palette.accent} />
            <Text style={styles.muted}>Checking readiness…</Text>
          </View>
        ) : onboarding ? (
          <>
            <ReadinessRow
              index="01"
              label="Trader profile"
              complete={onboarding.profileCompleted}
              compact={compact}
            />
            <ReadinessRow
              index="02"
              label="Eligibility & disclosures"
              complete={onboarding.eligibilityCompleted}
              compact={compact}
            />
            <ReadinessRow
              index="03"
              label="Broker connection"
              complete={effectiveBrokerConnected}
              compact={compact}
            />
            <ReadinessRow
              index="04"
              label="Trading readiness"
              complete={onboarding.canStartTrading}
              compact={compact}
              last
            />

            {nextAction ? (
              <ActionButton
                label={nextAction.label}
                onPress={nextAction.action}
              />
            ) : (
              <View style={styles.readyPanel}>
                <Text style={styles.readyPanelTitle}>Setup gates complete</Text>
                <Text style={styles.readyCopy}>
                  Use the AI tab to manage server-approved AI Trading and view
                  live runtime status.
                </Text>
              </View>
            )}
          </>
        ) : null}
      </Card>

      <SectionHeader
        title="Account setup"
        description="Manage the prerequisites that control broker and AI access."
      />

      <View style={styles.actionGrid}>
        <QuickAction
          kicker="IDENTITY"
          title="Trader profile"
          description="Personal details and account identity."
          onPress={onOpenProfile}
        />
        <QuickAction
          kicker="COMPLIANCE"
          title="Eligibility"
          description="Adult-age, KYC and disclosures."
          onPress={onOpenEligibility}
        />
        <QuickAction
          kicker="EXECUTION"
          title="Broker"
          description="Connect, verify or reconnect an account."
          onPress={onOpenBroker}
        />
      </View>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

function ReadinessRow({
  index,
  label,
  complete,
  compact = false,
  last = false,
}: {
  index: string;
  label: string;
  complete: boolean;
  compact?: boolean;
  last?: boolean;
}) {
  return (
    <View
      style={[
        styles.statusRow,
        compact && styles.statusRowCompact,
        last && styles.statusRowLast,
      ]}
    >
      <View style={styles.statusLabelGroup}>
        <View style={[styles.stepDot, complete && styles.stepDotComplete]}>
          <Text style={[styles.stepDotText, complete && styles.stepDotTextComplete]}>
            {complete ? '✓' : index}
          </Text>
        </View>
        <Text style={styles.statusText}>{label}</Text>
      </View>
      <StatusPill
        status={complete ? 'COMPLETE' : 'PENDING'}
        tone={complete ? 'positive' : 'warning'}
      />
    </View>
  );
}

function QuickAction({
  kicker,
  title,
  description,
  onPress,
}: {
  kicker: string;
  title: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.quickCard}>
      <Text style={styles.quickKicker}>{kicker}</Text>
      <Text style={styles.quickTitle}>{title}</Text>
      <Text style={styles.quickDescription}>{description}</Text>
      <ActionButton label="Open" secondary onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.bg },
  container: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 26,
  },
  hero: {
    overflow: 'hidden',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1f6f69',
    backgroundColor: '#0d1d27',
    padding: 20,
    marginBottom: 16,
  },
  heroGlow: {
    position: 'absolute',
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: '#123e42',
    opacity: 0.7,
    top: -65,
    right: -45,
  },
  eyebrow: {
    color: '#5eead4',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  title: {
    fontSize: 27,
    fontWeight: '900',
    color: palette.text,
    marginTop: 8,
    maxWidth: 300,
  },
  subtitle: {
    color: palette.bodySoft,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 7,
    maxWidth: 330,
  },
  heroStats: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 14,
    backgroundColor: 'rgba(4, 15, 22, 0.55)',
    marginTop: 18,
    padding: 12,
  },
  heroStat: { flex: 1, gap: 3 },
  heroStatValue: { color: palette.text, fontSize: 17, fontWeight: '900' },
  heroStatReady: { color: '#5eead4' },
  heroStatPending: { color: '#fde68a' },
  heroStatLabel: { color: palette.helper, fontSize: 10, fontWeight: '700' },
  heroDivider: { width: 1, backgroundColor: '#22404a', marginHorizontal: 14 },
  readinessCard: { marginTop: 2 },
  readinessHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 4,
  },
  readinessHeaderCompact: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  readinessHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  readinessTitle: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22,
  },
  readinessDescription: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  readinessStatusSlot: {
    minHeight: 28,
    minWidth: 102,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    flexShrink: 0,
  },
  readinessStatusSlotCompact: {
    alignItems: 'flex-start',
    minWidth: 0,
  },
  loadingRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    marginTop: 16,
  },
  muted: { color: palette.muted, fontSize: 13 },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: palette.cardBorder,
  },
  statusRowCompact: {
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    rowGap: 8,
  },
  statusRowLast: { borderBottomWidth: 0 },
  statusLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.inputBorder,
    backgroundColor: palette.input,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotComplete: {
    borderColor: palette.success.border,
    backgroundColor: palette.success.background,
  },
  stepDotText: { color: palette.muted, fontSize: 9, fontWeight: '900' },
  stepDotTextComplete: { color: '#5eead4', fontSize: 13 },
  statusText: {
    color: palette.body,
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
    minWidth: 0,
    lineHeight: 18,
  },
  readyPanel: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.success.border,
    backgroundColor: palette.success.background,
    padding: 12,
    marginTop: 12,
  },
  readyPanelTitle: { color: '#5eead4', fontSize: 12, fontWeight: '900' },
  readyCopy: {
    color: palette.success.text,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  actionGrid: { gap: 10, marginTop: 12 },
  quickCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.cardBorder,
    backgroundColor: palette.card,
    padding: 15,
  },
  quickKicker: {
    color: palette.accent,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  quickTitle: { color: palette.text, fontSize: 16, fontWeight: '800', marginTop: 5 },
  quickDescription: {
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  bottomSpacer: { height: 12 },
});
