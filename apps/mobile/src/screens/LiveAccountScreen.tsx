/**
 * LiveAccountScreen — mobile Positions & Activity dashboard (Sprint 51 PR-8,
 * Directive §36/§38 — mobile phases M7/M8).
 *
 * Renders the SAME authenticated live-account surface the web consumes
 * (overview/positions/orders via the shared @irexpro/api-client module):
 * authoritative environment banner (§36 — never ambiguous), health tiles,
 * server-derived alerts, positions, and orders. All money/quantities stay
 * decimal strings (never floats). Realtime: live/stale indicator + event
 * driven refresh via RealtimeProvider (M10).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type {
  LiveAccountActivityPage,
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LiveActivityRowView,
  LiveOrderRowView,
  LiveOrderStatusFilter,
  LivePositionRowView,
  LiveReadinessView,
} from "@irexpro/types";
import type { TradingSessionView } from "@irexpro/types/execution";
import { api } from "../lib/api";
import { execution } from "../lib/execution";
import { liveAccount } from "../lib/live-account";
import { useRealtime } from "../context/realtime-context";
import {
  activityPresentation,
  aiExitActivityRows,
  alertSeverityColor,
  environmentBanner,
  manualCloseConfirmationMessage,
  manualClosePresentation,
  marginTiles,
  readinessBlockerRows,
  readinessDisplayRows,
  reconciliationSummary,
  sessionAuthorityPresentation,
  sortAlerts,
  summaryTiles,
} from "./live-account-screen.logic";

export default function LiveAccountScreen() {
  const [overview, setOverview] = useState<LiveAccountOverviewView | null>(
    null,
  );
  const [positions, setPositions] = useState<LiveAccountPositionsView | null>(
    null,
  );
  const [orders, setOrders] = useState<LiveAccountOrdersPage | null>(null);
  const [activity, setActivity] = useState<LiveAccountActivityPage | null>(null);
  const [orderFilter, setOrderFilter] = useState<LiveOrderStatusFilter>("ALL");
  // ── Trading session authority (Sprint 56 correction round 5) ──
  // The session mode/status/generation ARE the authoritative trading state
  // (the legacy live-trading flag is never shown as current state).
  const [session, setSession] = useState<TradingSessionView | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  // ── Trading readiness (October UAT hardening — WS5) ──
  // Six SEPARATED operating states from GET /live-account/readiness. Fails
  // CLOSED but independently: a readiness outage never breaks the dashboard
  // and the section says so honestly — states are never fabricated locally.
  const [readiness, setReadiness] = useState<LiveReadinessView | null>(null);
  const [readinessUnavailable, setReadinessUnavailable] = useState(false);
  // ── Manual per-position close (October UAT hardening — WS1) ──
  // Per-position pending state: the Set drives the disabled "Closing…"
  // button; the ref is the synchronous duplicate-tap guard (state updates
  // are async, the ref check is not).
  const closingTradeIdsRef = useRef<Set<string>>(new Set());
  const [closingTradeIds, setClosingTradeIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const {
    connected,
    stale,
    addListener,
    refresh: reconnectNow,
  } = useRealtime();

  const load = useCallback(
    async (filter: LiveOrderStatusFilter = orderFilter) => {
      // The session authority read fails CLOSED but independently: the
      // dashboard still renders when the session endpoint is unreachable,
      // and the session card says so honestly (no inferred mode).
      const loadSession = (async () => {
        try {
          const payload = await api.getActiveTradingSession();
          // The API uses an explicit { session } envelope so the normal
          // stopped state remains valid JSON instead of an empty 200 body.
          const activeSession = payload.session;
          const payloadOk =
            activeSession === null ||
            (typeof activeSession === "object" &&
              typeof activeSession.id === "string" &&
              typeof activeSession.executionMode === "string");
          if (payloadOk) {
            setSession(activeSession);
            setSessionUnavailable(false);
          } else {
            setSession(null);
            setSessionUnavailable(true);
          }
        } catch (err) {
          setSession(null);
          setSessionUnavailable(true);
        }
      })();
      // Readiness also fails CLOSED but independently (WS5): the dashboard
      // renders normally when the readiness endpoint is unreachable, and the
      // readiness card says so honestly (no inferred states).
      const loadReadiness = (async () => {
        try {
          const payload = await liveAccount.getReadiness();
          const payloadOk =
            !!payload &&
            typeof payload === "object" &&
            !!payload.paper &&
            !!payload.demo &&
            !!payload.brokerLiveCertified &&
            !!payload.model &&
            !!payload.liveTradingEnabled &&
            Array.isArray(payload.liveBlockers);
          if (payloadOk) {
            setReadiness(payload);
            setReadinessUnavailable(false);
          } else {
            setReadiness(null);
            setReadinessUnavailable(true);
          }
        } catch (err) {
          setReadiness(null);
          setReadinessUnavailable(true);
        }
      })();
      try {
        const [ov, pos, ord, act] = await Promise.all([
          liveAccount.getOverview(),
          liveAccount.getPositions(),
          liveAccount.getOrders(filter),
          liveAccount.getActivity(30, 0),
          loadSession,
          loadReadiness,
        ]);
        setOverview(ov);
        setPositions(pos);
        setOrders(ord);
        setActivity(act);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load live account",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [orderFilter],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // M10 — refresh on ANY server event in the realtime contract (order
  // lifecycle, reconciliation, broker connection, execution controls).
  useEffect(
    () =>
      addListener(() => {
        // Fire-and-forget: failures surface through the normal error state.
        void load();
      }),
    [addListener, load],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const changeFilter = useCallback(
    (filter: LiveOrderStatusFilter) => {
      setOrderFilter(filter);
      void load(filter);
    },
    [load],
  );

  // ── Manual per-position close (October UAT hardening — WS1) ──
  // Closes ONE position through the server execution domain (the SAME
  // domain as AI exits / Stop flatten / kill switch). Start/Stop AI Trading
  // semantics are untouched — this never pauses or stops a session.
  const closePosition = useCallback(
    async (position: LivePositionRowView) => {
      const tradeId = position.id;
      // Synchronous duplicate-tap guard: one in-flight close per position.
      if (closingTradeIdsRef.current.has(tradeId)) return;
      closingTradeIdsRef.current.add(tradeId);
      setClosingTradeIds(new Set(closingTradeIdsRef.current));
      try {
        const response = await execution.closePosition(tradeId);
        const presentation = manualClosePresentation(
          response.outcome,
          response.message,
          response.providerErrorClass,
        );
        Alert.alert(presentation.title, presentation.message);
      } catch (err) {
        Alert.alert(
          "Close failed",
          err instanceof Error
            ? err.message
            : "The close request failed. The position state is unchanged — check the Positions list.",
        );
      } finally {
        closingTradeIdsRef.current.delete(tradeId);
        setClosingTradeIds(new Set(closingTradeIdsRef.current));
        // Refresh after ANY outcome — the Positions list stays the
        // authoritative open-state surface.
        void load();
      }
    },
    [load],
  );

  const confirmClosePosition = useCallback(
    (position: LivePositionRowView) => {
      Alert.alert(
        "Close position",
        manualCloseConfirmationMessage(position),
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Close position",
            style: "destructive",
            onPress: () => void closePosition(position),
          },
        ],
      );
    },
    [closePosition],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#14b8a6" />
        <Text style={styles.muted}>Loading live account…</Text>
      </View>
    );
  }

  const banner = overview ? environmentBanner(overview.environment) : null;
  const tiles = overview ? summaryTiles(overview) : null;
  const alerts = overview ? sortAlerts(overview.alerts) : [];
  const sessionAuthority = sessionAuthorityPresentation(session);
  const exitActivity = aiExitActivityRows(activity?.activity ?? []).slice(0, 8);
  const recentActivity = (activity?.activity ?? []).slice(0, 10);
  // Production-LIVE completion round (audit P8): margin tiles + per-connection
  // reconciliation summary from the SAME overview payload the web renders.
  const margin = overview ? marginTiles(overview) : null;
  const reconciliations = overview
    ? overview.connections.map((connection) => ({
        connection,
        view: reconciliationSummary(connection, overview.reconciliationLoaded),
      }))
    : [];
  // WS5 — the six separated readiness rows + verbatim server blockers.
  const readinessRows = readiness ? readinessDisplayRows(readiness) : [];
  const blockerRows = readiness ? readinessBlockerRows(readiness) : [];

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#14b8a6"
        />
      }
    >
      <View style={styles.headerRow}>
        <Text style={styles.title}>Positions &amp; Activity</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            connected ? "Realtime connected" : "Reconnect realtime"
          }
          onPress={reconnectNow}
          style={styles.liveBadge}
        >
          <Text
            style={[
              styles.liveBadgeText,
              { color: connected ? "#047857" : stale ? "#b45309" : "#64748b" },
            ]}
          >
            {connected ? "● Live" : stale ? "○ Stale" : "○ Offline"}
          </Text>
        </Pressable>
      </View>

      {banner ? (
        <View
          style={[
            styles.banner,
            {
              borderColor: banner.borderColor,
              backgroundColor: banner.backgroundColor,
            },
          ]}
          accessibilityRole="summary"
          accessibilityLabel={`${banner.label} environment`}
        >
          <Text style={[styles.bannerText, { color: banner.textColor }]}>
            {banner.label}
          </Text>
          <Text style={[styles.bannerSub, { color: banner.textColor }]}>
            {overview && overview.hasConnections
              ? `${overview.connections.length} connection${overview.connections.length === 1 ? "" : "s"}`
              : "No broker connections yet"}
          </Text>
        </View>
      ) : null}

      {/* Trading session authority — the AUTHORITATIVE execution state
          (Sprint 56 correction round 5). The mode/status/generation come
          from the server session; the legacy live-trading flag is never
          rendered as the current trading state. */}
      <View
        style={styles.card}
        accessibilityLabel="Trading session authority"
      >
        <Text style={styles.cardTitle}>AI Trading state</Text>
        {sessionUnavailable ? (
          <Text style={styles.muted}>
            Session state unavailable from the server — the execution mode is
            not inferred locally. Pull to refresh.
          </Text>
        ) : (
          <View>
            <View style={styles.rowBetween}>
              <Text style={styles.sessionMode}>{sessionAuthority.modeLabel}</Text>
              <Text
                style={[
                  styles.sessionStatus,
                  {
                    color: sessionAuthority.executionBlocked
                      ? "#f59e0b"
                      : "#10b981",
                  },
                ]}
              >
                {sessionAuthority.statusLabel}
              </Text>
            </View>
            {session ? (
              <Text style={styles.mutedSmall}>
                Authority generation {session.authorityGeneration}
                {session.executionMode === "SEMI_AUTO"
                  ? " · confirmations are approved in the web workspace"
                  : ""}
              </Text>
            ) : null}
            {sessionAuthority.blockedReasons.map((reason) => (
              <Text key={reason} style={styles.mutedSmall}>
                • {reason}
              </Text>
            ))}
          </View>
        )}
      </View>

      {/* Trading readiness (October UAT hardening — WS5) — six SEPARATED
          status rows, never a bare "Verified". Each row carries its OWN
          truth: a DEMO validation never renders as LIVE-ready, a certified
          broker never implies the model is approved. Fails closed and
          independently — an outage renders an honest unavailable row, never
          fabricated states. */}
      <View style={styles.card} accessibilityLabel="Trading readiness">
        <Text style={styles.cardTitle}>Trading readiness</Text>
        {readinessUnavailable || !readiness ? (
          <Text style={styles.muted}>
            Readiness unavailable from the server — trading states are not
            inferred locally. Pull to refresh.
          </Text>
        ) : (
          <View style={styles.readinessList}>
            {readinessRows.map((row) => (
              <View
                key={row.key}
                style={styles.readinessRow}
                accessibilityLabel={`${row.label}: ${row.statusText}`}
              >
                <View style={styles.readinessRowCopy}>
                  <Text style={styles.readinessLabel}>{row.label}</Text>
                  {row.detail ? (
                    <Text style={styles.mutedSmall}>{row.detail}</Text>
                  ) : null}
                </View>
                <Text
                  style={[
                    styles.readinessStatus,
                    { color: row.met ? "#047857" : "#64748b" },
                  ]}
                >
                  {row.statusText}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* Real-money trading blockers — server messages VERBATIM, one plain
          row each, only when the server reports blockers. */}
      {blockerRows.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Real-money trading blockers</Text>
          {blockerRows.map((blocker, index) => (
            <View
              key={`${blocker.reasonCode}:${index}`}
              style={styles.blockerCard}
              accessibilityLabel={`Real-money trading blocker: ${blocker.message}`}
            >
              <Text style={styles.blockerMessage}>{blocker.message}</Text>
            </View>
          ))}
        </>
      ) : null}

      {error ? (
        <View
          style={styles.errorCard}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading live account"
            style={styles.retryButton}
            onPress={() => void load()}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {tiles ? (
        <View style={styles.tileGrid}>
          <View
            style={styles.tile}
            accessibilityLabel={`${tiles.openPositions} open positions`}
          >
            <Text style={styles.tileValue}>{tiles.openPositions}</Text>
            <Text style={styles.tileLabel}>Open positions</Text>
          </View>
          <View
            style={styles.tile}
            accessibilityLabel={`${tiles.workingOrders} working orders`}
          >
            <Text style={styles.tileValue}>{tiles.workingOrders}</Text>
            <Text style={styles.tileLabel}>Working orders</Text>
          </View>
          <View
            style={styles.tile}
            accessibilityLabel={`${tiles.reconciliationPending} orders pending reconciliation`}
          >
            <Text
              style={[
                styles.tileValue,
                tiles.reconciliationPending > 0 ? styles.tileWarn : null,
              ]}
            >
              {tiles.reconciliationPending}
            </Text>
            <Text style={styles.tileLabel}>Recon pending</Text>
          </View>
          <View
            style={styles.tile}
            accessibilityLabel={`${tiles.criticalAlerts} critical alerts`}
          >
            <Text
              style={[
                styles.tileValue,
                tiles.criticalAlerts > 0 ? styles.tileDanger : null,
              ]}
            >
              {tiles.criticalAlerts}
            </Text>
            <Text style={styles.tileLabel}>Critical</Text>
          </View>
        </View>
      ) : null}

      {margin ? (
        <>
          <Text style={styles.sectionTitle}>Account margin</Text>
          <View style={styles.tileGrid}>
            <View
              style={styles.tile}
              accessibilityLabel={
                margin.available
                  ? `Margin ${margin.margin} ${margin.currency ?? ""}`.trim()
                  : "Margin unavailable"
              }
            >
              <Text style={styles.moneyValue}>
                {margin.available
                  ? `${margin.margin}${margin.currency ? ` ${margin.currency}` : ""}`
                  : "—"}
              </Text>
              <Text style={styles.tileLabel}>Margin</Text>
            </View>
            <View
              style={styles.tile}
              accessibilityLabel={
                margin.available
                  ? `Free margin ${margin.freeMargin} ${margin.currency ?? ""}`.trim()
                  : "Free margin unavailable"
              }
            >
              <Text style={styles.moneyValue}>
                {margin.available
                  ? `${margin.freeMargin}${margin.currency ? ` ${margin.currency}` : ""}`
                  : "—"}
              </Text>
              <Text style={styles.tileLabel}>Free margin</Text>
            </View>
            <View
              style={styles.tile}
              accessibilityLabel={
                margin.available && margin.marginLevel !== null
                  ? `Margin level ${margin.marginLevel} percent`
                  : "Margin level not available"
              }
            >
              <Text style={styles.moneyValue}>
                {margin.available && margin.marginLevel !== null ? `${margin.marginLevel}%` : "—"}
              </Text>
              <Text style={styles.tileLabel}>Margin level</Text>
            </View>
          </View>
        </>
      ) : null}

      {reconciliations.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Reconciliation</Text>
          {reconciliations.map(({ connection, view }) => (
            <View
              key={connection.id}
              style={styles.card}
              accessibilityLabel={`Reconciliation for ${connection.displayName || connection.brokerName}: ${view.statusLabel}`}
            >
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>
                  {connection.displayName || connection.brokerName}
                </Text>
                <Text
                  style={[
                    styles.reconStatus,
                    {
                      color: view.unavailable ? "#b45309" : view.inSync ? "#047857" : "#be123c",
                    },
                  ]}
                >
                  {view.unavailable
                    ? "Status unavailable"
                    : view.inSync
                      ? "In sync"
                      : "Discrepancies open"}
                </Text>
              </View>
              <Text style={styles.muted}>
                Last run status: {view.statusLabel} · {view.lastRunLabel}
              </Text>
              <Text style={styles.mutedSmall}>{view.discrepancyLabel}</Text>
            </View>
          ))}
        </>
      ) : null}

      {alerts.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Alerts</Text>
          {alerts.map((alert) => (
            <View
              key={alert.key}
              style={[
                styles.alertCard,
                { borderLeftColor: alertSeverityColor(alert.severity) },
              ]}
              accessibilityLabel={`${alert.severity} alert: ${alert.message}`}
            >
              <View style={styles.rowBetween}>
                <Text
                  style={[
                    styles.alertSeverity,
                    { color: alertSeverityColor(alert.severity) },
                  ]}
                >
                  {alert.severity}
                </Text>
                {alert.brokerName ? (
                  <Text style={styles.mutedSmall}>{alert.brokerName}</Text>
                ) : null}
              </View>
              <Text style={styles.alertMessage}>{alert.message}</Text>
              {alert.action ? (
                <Text style={styles.mutedSmall}>{alert.action}</Text>
              ) : null}
            </View>
          ))}
        </>
      ) : null}

      <Text style={styles.sectionTitle}>AI exit monitoring</Text>
      <View style={styles.monitoringNote}>
        <Text style={styles.monitoringNoteTitle}>Server-authoritative exit status</Text>
        <Text style={styles.monitoringNoteText}>
          AI exit events below come from the server audit trail. “Processed” does not
          promise a confirmed close; the Positions list remains the authoritative view
          of what is still open.
        </Text>
      </View>
      {exitActivity.length > 0 ? (
        exitActivity.map((row: LiveActivityRowView) => {
          const presentation = activityPresentation(row.action);
          const toneColor =
            presentation.tone === "success"
              ? "#047857"
              : presentation.tone === "warning"
                ? "#b45309"
                : presentation.tone === "danger"
                  ? "#be123c"
                  : "#475569";
          return (
            <View
              key={row.id}
              style={styles.activityCard}
              accessibilityLabel={`${presentation.label}, ${new Date(
                row.createdAt,
              ).toLocaleString()}`}
            >
              <View style={styles.rowBetween}>
                <Text style={[styles.activityTitle, { color: toneColor }]}>
                  {presentation.label}
                </Text>
                <Text style={styles.mutedSmall}>
                  {new Date(row.createdAt).toLocaleString()}
                </Text>
              </View>
              <Text style={styles.activityDetail}>{presentation.detail}</Text>
              {row.severity !== "INFO" ? (
                <Text style={[styles.activitySeverity, { color: toneColor }]}>
                  {row.severity}
                </Text>
              ) : null}
            </View>
          );
        })
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>No AI exit activity recorded yet.</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Positions</Text>
      {positions && positions.positions.length > 0 ? (
        positions.positions.map((position: LivePositionRowView) => (
          <View
            key={position.id}
            style={styles.card}
            accessibilityLabel={`${position.instrument} ${position.direction} position, ${position.lotSize} lots`}
          >
            <View style={styles.rowBetween}>
              <View style={styles.rowWrap}>
                <Text
                  style={[
                    styles.directionBadge,
                    position.direction === "BUY"
                      ? styles.directionBuy
                      : styles.directionSell,
                  ]}
                >
                  {position.direction}
                </Text>
                <Text style={styles.cardTitle}>{position.instrument}</Text>
              </View>
              <Text style={styles.mutedSmall}>{position.environment}</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.muted}>{position.lotSize} lots</Text>
              <Text style={styles.mutedSmall}>
                {position.fillPrice
                  ? `@ ${position.fillPrice}`
                  : `req ${position.requestedEntryPrice}`}
              </Text>
            </View>
            {position.currentPrice || position.unrealisedPnl ? (
              <View style={styles.rowBetween}>
                <Text style={styles.mutedSmall}>
                  {position.currentPrice ? `Current ${position.currentPrice}` : "Current price —"}
                </Text>
                <Text style={styles.positionPnl}>
                  {position.unrealisedPnl && position.accountCurrency
                    ? `${position.accountCurrency} ${position.unrealisedPnl}`
                    : "P&L —"}
                </Text>
              </View>
            ) : null}
            <View style={styles.rowBetween}>
              <Text style={styles.mutedSmall}>SL {position.stopLoss}</Text>
              <Text style={styles.mutedSmall}>TP {position.takeProfit}</Text>
            </View>
            {position.brokerName ? (
              <Text style={styles.mutedSmall}>{position.brokerName}</Text>
            ) : null}
            {/* Manual per-position close (October UAT hardening — WS1).
                Only an OPEN position can be closed; a position pending
                reconciliation honestly reports the close as unavailable —
                reconciliation owns its final state. */}
            {position.status === "OPEN" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Close ${position.instrument} ${position.direction} position, ${position.lotSize} lots`}
                accessibilityState={{ disabled: closingTradeIds.has(position.id) }}
                disabled={closingTradeIds.has(position.id)}
                style={({ pressed }) => [
                  styles.closePositionButton,
                  closingTradeIds.has(position.id) &&
                    styles.closePositionButtonDisabled,
                  pressed &&
                    !closingTradeIds.has(position.id) &&
                    styles.closePositionButtonPressed,
                ]}
                onPress={() => confirmClosePosition(position)}
              >
                <Text style={styles.closePositionButtonText}>
                  {closingTradeIds.has(position.id)
                    ? "Closing…"
                    : "Close position"}
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.closeUnavailableText}>
                Close unavailable — reconciling
              </Text>
            )}
          </View>
        ))
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>No open positions.</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Orders</Text>
      <View style={styles.rowWrap}>
        {(["ALL", "WORKING", "HISTORY"] as const).map((filter) => (
          <Pressable
            key={filter}
            accessibilityRole="button"
            accessibilityLabel={`${filter} orders filter`}
            style={[
              styles.filterOption,
              orderFilter === filter && styles.filterOptionActive,
            ]}
            onPress={() => changeFilter(filter)}
          >
            <Text
              style={[
                styles.filterText,
                orderFilter === filter && styles.filterTextActive,
              ]}
            >
              {filter}
            </Text>
          </Pressable>
        ))}
      </View>
      {orders && orders.orders.length > 0 ? (
        orders.orders.map((order: LiveOrderRowView) => (
          <View
            key={order.id}
            style={styles.card}
            accessibilityLabel={`${order.instrument} ${order.status} ${order.orderKind} order`}
          >
            <View style={styles.rowBetween}>
              <View style={styles.rowWrap}>
                <Text
                  style={[
                    styles.directionBadge,
                    order.direction === "BUY"
                      ? styles.directionBuy
                      : styles.directionSell,
                  ]}
                >
                  {order.direction}
                </Text>
                <Text style={styles.cardTitle}>{order.instrument}</Text>
              </View>
              <Text style={styles.orderStatus}>{order.status}</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.muted}>
                {order.orderKind} · {order.requestedQuantity}
              </Text>
              <Text style={styles.mutedSmall}>
                {order.avgFillPrice
                  ? `avg ${order.avgFillPrice}`
                  : order.requestedPrice
                    ? `req ${order.requestedPrice}`
                    : "market"}
              </Text>
            </View>
            {order.rejectReason ? (
              <Text style={styles.errorTextSmall}>{order.rejectReason}</Text>
            ) : null}
            <Text style={styles.mutedSmall}>
              {order.submittedAt
                ? new Date(order.submittedAt).toLocaleString()
                : new Date(order.createdAt).toLocaleString()}
            </Text>
          </View>
        ))
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>No orders in this view.</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Recent activity</Text>
      {recentActivity.length > 0 ? (
        recentActivity.map((row: LiveActivityRowView) => {
          const presentation = activityPresentation(row.action);
          return (
            <View key={row.id} style={styles.activityCompactRow}>
              <View style={styles.activityCompactCopy}>
                <Text style={styles.activityCompactTitle}>
                  {presentation.label}
                </Text>
                <Text style={styles.mutedSmall}>
                  {new Date(row.createdAt).toLocaleString()}
                </Text>
              </View>
              <Text style={styles.activityCompactSeverity}>{row.severity}</Text>
            </View>
          );
        })
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>No recent activity.</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 48 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  title: { fontSize: 24, fontWeight: "700", color: "#0f172a" },
  liveBadge: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#ffffff",
  },
  liveBadgeText: { fontSize: 12, fontWeight: "700" },
  banner: {
    borderWidth: 2,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 2,
  },
  bannerText: { fontSize: 16, fontWeight: "800", letterSpacing: 1 },
  bannerSub: { fontSize: 12 },
  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  tile: {
    flexBasis: "48%",
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    padding: 12,
    gap: 2,
  },
  tileValue: { fontSize: 22, fontWeight: "700", color: "#0f172a" },
  tileLabel: { fontSize: 11, color: "#64748b" },
  tileWarn: { color: "#b45309" },
  tileDanger: { color: "#be123c" },
  moneyValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
    fontVariant: ["tabular-nums"],
  },
  reconStatus: { fontSize: 11, fontWeight: "800" },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#334155",
    marginTop: 20,
    marginBottom: 8,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    padding: 14,
    marginBottom: 10,
    gap: 6,
  },
  cardTitle: { fontSize: 15, fontWeight: "600", color: "#0f172a" },
  alertCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderLeftWidth: 4,
    padding: 12,
    marginBottom: 8,
    gap: 4,
  },
  alertSeverity: { fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  alertMessage: { fontSize: 14, color: "#0f172a" },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
  },
  directionBadge: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: "800",
    overflow: "hidden",
  },
  directionBuy: { backgroundColor: "#ccfbf1", color: "#134e4a" },
  directionSell: { backgroundColor: "#ffe4e6", color: "#9f1239" },
  orderStatus: { fontSize: 10, fontWeight: "700", color: "#475569" },
  muted: { color: "#64748b", fontSize: 13 },
  mutedSmall: { color: "#94a3b8", fontSize: 11 },
  positionPnl: { color: "#0f766e", fontSize: 11, fontWeight: "700" },
  sessionMode: { color: "#e2e8f0", fontSize: 14, fontWeight: "700" },
  sessionStatus: { fontSize: 12, fontWeight: "700" },
  filterOption: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  filterOptionActive: { borderColor: "#0d9488", backgroundColor: "#ccfbf1" },
  filterText: { color: "#475569", fontSize: 12, fontWeight: "600" },
  filterTextActive: { color: "#134e4a" },
  errorCard: {
    backgroundColor: "#fef2f2",
    borderColor: "#fecdd3",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 8,
  },
  errorText: { color: "#b91c1c", fontSize: 13 },
  errorTextSmall: { color: "#b91c1c", fontSize: 11 },
  monitoringNote: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#99f6e4",
    backgroundColor: "#f0fdfa",
    padding: 12,
    marginBottom: 10,
    gap: 4,
  },
  monitoringNoteTitle: {
    color: "#115e59",
    fontSize: 12,
    fontWeight: "800",
  },
  monitoringNoteText: {
    color: "#0f766e",
    fontSize: 11,
    lineHeight: 16,
  },
  activityCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    padding: 12,
    marginBottom: 8,
    gap: 5,
  },
  activityTitle: { fontSize: 13, fontWeight: "800" },
  activityDetail: { color: "#475569", fontSize: 12, lineHeight: 17 },
  activitySeverity: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
  activityCompactRow: {
    backgroundColor: "#ffffff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 7,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  activityCompactCopy: { flex: 1 },
  activityCompactTitle: { color: "#334155", fontSize: 12, fontWeight: "700" },
  activityCompactSeverity: { color: "#64748b", fontSize: 9, fontWeight: "800" },
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryButtonText: { color: "#b91c1c", fontWeight: "600", fontSize: 13 },
  // ── Manual per-position close (October UAT hardening — WS1) ──
  // Danger treatment mirrors the screen's destructive retry button.
  closePositionButton: {
    alignSelf: "flex-start",
    backgroundColor: "#fee2e2",
    borderColor: "#fecdd3",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 4,
  },
  closePositionButtonPressed: { backgroundColor: "#fecdd3" },
  closePositionButtonDisabled: { opacity: 0.6 },
  closePositionButtonText: {
    color: "#b91c1c",
    fontWeight: "600",
    fontSize: 13,
  },
  closeUnavailableText: { color: "#94a3b8", fontSize: 11 },
  // ── Trading readiness (October UAT hardening — WS5) ──
  readinessList: { gap: 10 },
  readinessRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  readinessRowCopy: { flex: 1, gap: 2 },
  readinessLabel: { color: "#334155", fontSize: 13, fontWeight: "600" },
  readinessStatus: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
    textAlign: "right",
  },
  blockerCard: {
    backgroundColor: "#fffbeb",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#fde68a",
    borderLeftWidth: 4,
    borderLeftColor: "#f59e0b",
    padding: 12,
    marginBottom: 8,
  },
  blockerMessage: { color: "#78350f", fontSize: 12, lineHeight: 17 },
});
