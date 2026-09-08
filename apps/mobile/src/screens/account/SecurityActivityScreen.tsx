import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SecurityEventView } from '@irexpro/types';
import {
  ActionButton,
  Banner,
  Card,
  SkeletonBlock,
  palette,
} from '@/components/ui';
import { api } from '@/lib/api';
import { accountSecurityError } from '@/lib/account-security';
import {
  formatRelativeTime,
  securityEventLabel,
  securityEventTone,
} from '@/lib/account-security-logic';

const PAGE_SIZE = 20;

type ActivityPhase = 'loading' | 'error' | 'ready';

/** Tone color tokens for the timeline dot + row edge. */
const TONE_COLORS: Record<'neutral' | 'warning' | 'danger', string> = {
  neutral: palette.dim,
  warning: palette.warningText,
  danger: palette.errorText,
};

/**
 * Security Activity sub-screen of the Security hub (Sprint 55 Phase J).
 *
 * Timeline of GET /auth/security-events (privacy-safe projection):
 * - Rows render ONLY what the API returns — id/action/createdAt/severity.
 *   IP addresses, device agents, and metadata are never present in the
 *   contract and are never fabricated here.
 * - Known actions map to friendly labels through the RN-free pure module;
 *   any unknown action renders the generic "Account security event" label.
 * - Pagination: "Load more" appends the next page (offset += 20) while
 *   hasMore is true; a refresh button in the header re-fetches page 0.
 * - All error copy is sanitized through accountSecurityError; the raw server
 *   message is never rendered.
 */
export default function SecurityActivityScreen({ onBack }: { onBack: () => void }) {
  const [events, setEvents] = useState<SecurityEventView[]>([]);
  const [phase, setPhase] = useState<ActivityPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const cancelledRef = useRef(false);

  const fetchInFlight = phase === 'loading' || loadingMore || refreshing;

  const loadFirstPage = useCallback(async (mode: 'initial' | 'refresh'): Promise<void> => {
    if (mode === 'initial') setPhase('loading');
    else setRefreshing(true);
    setLoadError(null);
    setActionError(null);
    try {
      const response = await api.listSecurityEvents({ limit: PAGE_SIZE, offset: 0 });
      if (cancelledRef.current) return;
      setEvents(response.events);
      setHasMore(response.hasMore);
      setPhase('ready');
    } catch (error) {
      if (cancelledRef.current) return;
      const copy = accountSecurityError(error);
      if (mode === 'initial') {
        setLoadError(copy);
        setPhase('error');
      } else {
        // Refresh failures keep the already-loaded timeline on screen.
        setActionError(copy);
      }
    } finally {
      if (!cancelledRef.current && mode === 'refresh') setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void loadFirstPage('initial');
    return () => {
      cancelledRef.current = true;
    };
  }, [loadFirstPage]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const response = await api.listSecurityEvents({
        limit: PAGE_SIZE,
        offset: events.length,
      });
      if (cancelledRef.current) return;
      setEvents((current) => [...current, ...response.events]);
      setHasMore(response.hasMore);
    } catch (error) {
      if (cancelledRef.current) return;
      // The loaded list stays visible; pressing "Load more" retries.
      setActionError(accountSecurityError(error));
    } finally {
      if (!cancelledRef.current) setLoadingMore(false);
    }
  }

  function renderRow(event: SecurityEventView, index: number): ReactNode {
    const label = securityEventLabel(event.action);
    const tone = securityEventTone(event.severity);
    const time = formatRelativeTime(event.createdAt, Date.now());
    return (
      <View
        key={event.id}
        style={[
          styles.eventRow,
          index === 0 ? styles.firstEventRow : null,
          { borderLeftColor: TONE_COLORS[tone] },
        ]}
        accessible
        accessibilityLabel={`${label}, ${time}`}
      >
        <View style={[styles.toneDot, { backgroundColor: TONE_COLORS[tone] }]} />
        <View style={styles.eventCopy}>
          <Text style={styles.eventLabel}>{label}</Text>
          <Text style={styles.eventTime}>{time}</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Security activity"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to security"
        onPress={onBack}
        style={styles.backButton}
      >
        <Text style={styles.backButtonText}>‹ Security</Text>
      </Pressable>

      <View style={styles.titleRow}>
        <Text style={styles.title}>Security Activity</Text>
        {phase === 'ready' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh security activity"
            accessibilityState={{ disabled: fetchInFlight, busy: refreshing }}
            onPress={() => void loadFirstPage('refresh')}
            style={[styles.refreshButton, fetchInFlight && styles.refreshDisabled]}
            disabled={fetchInFlight}
          >
            <Text style={styles.refreshButtonText}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.subtitle}>
        Recent security events on your account — sign-ins, password changes, and session
        activity recorded by the server.
      </Text>

      {phase === 'loading' ? (
        <Card>
          {[0, 1, 2, 3, 4].map((row) => (
            <View key={row} style={styles.skeletonRow}>
              <SkeletonBlock height={10} style={styles.skeletonDot} />
              <View style={styles.skeletonCopy}>
                <SkeletonBlock height={14} style={styles.skeletonLabel} />
                <SkeletonBlock height={10} style={styles.skeletonTime} />
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      {phase === 'error' && loadError ? (
        <>
          <Banner variant="error">{loadError}</Banner>
          <ActionButton label="Retry loading activity" onPress={() => void loadFirstPage('initial')} />
        </>
      ) : null}

      {phase === 'ready' ? (
        <>
          {actionError ? <Banner variant="error">{actionError}</Banner> : null}

          {events.length === 0 ? (
            <Card>
              <Text style={styles.emptyText}>No security activity yet.</Text>
              <Text style={styles.helper}>
                Sign-ins, password changes, and session events will appear here.
              </Text>
            </Card>
          ) : (
            <>
              <Card style={styles.flushCard}>
                {events.map((event, index) => renderRow(event, index))}
              </Card>

              {hasMore ? (
                <ActionButton
                  label="Load more"
                  busyLabel="Loading more…"
                  busy={loadingMore}
                  onPress={() => void loadMore()}
                  secondary
                  disabled={loadingMore || refreshing}
                />
              ) : (
                <Text style={styles.endText}>You&apos;ve reached the end.</Text>
              )}
            </>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  content: { padding: 20, paddingBottom: 40 },
  backButton: {
    minHeight: 46,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginTop: 8,
    marginBottom: 4,
  },
  backButtonText: { color: palette.accent, fontSize: 15, fontWeight: '600' },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 4,
  },
  title: { fontSize: 26, fontWeight: '800', color: palette.text },
  refreshButton: { minHeight: 46, justifyContent: 'center' },
  refreshDisabled: { opacity: 0.52 },
  refreshButtonText: { color: palette.accent, fontSize: 14, fontWeight: '700' },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 16 },
  flushCard: { padding: 0 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: palette.cardBorder,
    borderLeftWidth: 3,
    borderLeftColor: palette.dim,
  },
  firstEventRow: { borderTopWidth: 0 },
  toneDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  eventCopy: { flex: 1 },
  eventLabel: { color: palette.text, fontSize: 15, fontWeight: '700' },
  eventTime: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 3 },
  emptyText: { color: palette.body, fontSize: 15, fontWeight: '700' },
  helper: { color: palette.helper, fontSize: 12, lineHeight: 18, marginTop: 6 },
  endText: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 8,
  },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  skeletonDot: { width: 10, borderRadius: 5 },
  skeletonCopy: { flex: 1 },
  skeletonLabel: { width: 180 },
  skeletonTime: { width: 70, marginTop: 6 },
});
