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
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
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
} from "@irexpro/types";
import type { TradeExecutionView, TradingSessionView } from "@irexpro/types/execution";
import { api } from "../lib/api";
import { ActionDialog, Banner } from "../components/ui";
import { liveAccount } from "../lib/live-account";
import { execution } from "../lib/execution";
import { useRealtime } from "../context/realtime-context";
import {
  activityPresentation,
  aiExitActivityRows,
  alertSeverityColor,
  environmentBanner,
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
  const [closedExecutions, setClosedExecutions] = useState<TradeExecutionView[]>([]);
  const [orderFilter, setOrderFilter] = useState<LiveOrderStatusFilter>("ALL");
  // ── Trading session authority (Sprint 56 correction round 5) ──
  // The session mode/status/generation ARE the authoritative trading state
  // (the legacy live-trading flag is never shown as current state).
  const [session, setSession] = useState<TradingSessionView | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionNotice, setActionNotice] = useState<
    { variant: "success" | "info"; message: string } | null
  >(null);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [closingAllPositions, setClosingAllPositions] = useState(false);
  const [closeDialog, setCloseDialog] = useState<
    | { kind: "single"; position: LivePositionRowView }
    | { kind: "all"; count: number }
    | null
  >(null);
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
      try {
        const [ov, pos, ord, act, closed] = await Promise.all([
          liveAccount.getOverview(),
          liveAccount.getPositions(),
          liveAccount.getOrders(filter),
          liveAccount.getActivity(30, 0),
          execution.listClosedExecutions(20),
          loadSession,
        ]);
        setOverview(ov);
        setPositions(pos);
        setOrders(ord);
        setActivity(act);
        setClosedExecutions(closed);
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

  const closePosition = useCallback(
    async (position: LivePositionRowView) => {
      if (closingPositionId || closingAllPositions) return;
      setClosingPositionId(position.id);
      setError(null);
      setActionNotice(null);
      try {
        const result = await api.closePosition(position.id);
        setActionNotice(
          result.status === "CLOSED"
            ? {
                variant: "success",
                message: `${position.instrument} ${position.direction} is confirmed closed by the execution service.`,
              }
            : {
                variant: "info",
                message: `${position.instrument} is now ${result.status}. The row remains authoritative until reconciliation confirms the broker state.`,
              },
        );
        await load();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to close position";
        setError(
          message +
            " The position has not been assumed closed. Refresh Positions & Activity to verify its authoritative server state.",
        );
      } finally {
        setClosingPositionId(null);
      }
    },
    [closingAllPositions, closingPositionId, load],
  );

  const requestClosePosition = useCallback(
    (position: LivePositionRowView) => {
      if (closingPositionId || closingAllPositions) return;
      setCloseDialog({ kind: "single", position });
    },
    [closingAllPositions, closingPositionId],
  );

  const closeAllPositions = useCallback(async () => {
    if (
      !positions ||
      positions.positions.length === 0 ||
      closingPositionId ||
      closingAllPositions
    ) {
      return;
    }

    setClosingAllPositions(true);
    setError(null);
    setActionNotice(null);
    try {
      const results = await api.closeAllAiPositions();
      const closedCount = results.filter((result) => result.closed).length;
      const unresolved = results.filter((result) => !result.closed);
      if (unresolved.length === 0) {
        setActionNotice({
          variant: "success",
          message: `Confirmed closed: ${closedCount} position${closedCount === 1 ? "" : "s"}.`,
        });
      } else {
        const statusSummary = unresolved
          .slice(0, 3)
          .map((result) => `${result.tradeId.slice(0, 8)}… · ${result.status}`)
          .join(" · ");
        setActionNotice({
          variant: "info",
          message: `${closedCount} confirmed closed; ${unresolved.length} unresolved. ${statusSummary}. Refresh until the server confirms the final broker state.`,
        });
      }
      await load();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to close AI positions";
      setError(
        message +
          " No position is assumed closed. Refresh Positions & Activity to verify the authoritative server state.",
      );
    } finally {
      setClosingAllPositions(false);
    }
  }, [closingAllPositions, closingPositionId, load, positions]);

  const requestCloseAllPositions = useCallback(() => {
    const count = positions?.positions.length ?? 0;
    if (count === 0 || closingPositionId || closingAllPositions) return;
    setCloseDialog({ kind: "all", count });
  }, [closingAllPositions, closingPositionId, positions]);

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

  async function confirmCloseDialog(): Promise<void> {
    const current = closeDialog;
    if (!current) return;
    setCloseDialog(null);
    if (current.kind === "single") {
      await closePosition(current.position);
      return;
    }
    await closeAllPositions();
  }

  const closeDialogBusy = closingAllPositions || closingPositionId !== null;

  return (
    <>
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
                  ? " · pending confirmations are handled in AI Trading"
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

      {actionNotice ? (
        <Banner variant={actionNotice.variant}>{actionNotice.message}</Banner>
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

      <View style={styles.sectionHeadingRow}>
        <Text style={styles.sectionTitle}>Positions</Text>
        {positions && positions.positions.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close all AI-opened positions"
            disabled={closingAllPositions || closingPositionId !== null}
            onPress={requestCloseAllPositions}
            style={[
              styles.closeAllButton,
              (closingAllPositions || closingPositionId !== null) && styles.disabledControl,
            ]}
          >
            {closingAllPositions ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <Text style={styles.closeAllButtonText}>Close all</Text>
            )}
          </Pressable>
        ) : null}
      </View>
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Close ${position.instrument} position`}
              disabled={
                closingAllPositions ||
                (closingPositionId !== null && closingPositionId !== position.id)
              }
              onPress={() => requestClosePosition(position)}
              style={[
                styles.closePositionButton,
                (closingAllPositions ||
                  (closingPositionId !== null && closingPositionId !== position.id)) &&
                  styles.disabledControl,
              ]}
            >
              {closingPositionId === position.id ? (
                <ActivityIndicator color="#be123c" size="small" />
              ) : (
                <Text style={styles.closePositionButtonText}>Close position</Text>
              )}
            </Pressable>
          </View>
        ))
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>No open positions.</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Closed Trades & Realized P&L</Text>
      {closedExecutions.length > 0 ? (
        closedExecutions.map((trade) => {
          const realisedLabel =
            trade.realisedPnl && trade.accountCurrency
              ? `${trade.accountCurrency} ${trade.realisedPnl}`
              : "Realized P&L —";
          const pnlTone =
            trade.realisedPnl?.startsWith("-") === true
              ? styles.realisedNegative
              : styles.realisedPositive;

          return (
            <View
              key={trade.id}
              style={styles.card}
              accessibilityLabel={`Closed ${trade.instrument} ${trade.direction} trade`}
            >
              <View style={styles.rowBetween}>
                <View style={styles.rowWrap}>
                  <Text
                    style={[
                      styles.directionBadge,
                      trade.direction === "BUY"
                        ? styles.directionBuy
                        : styles.directionSell,
                    ]}
                  >
                    {trade.direction}
                  </Text>
                  <Text style={styles.cardTitle}>{trade.instrument}</Text>
                </View>
                <Text style={[styles.realisedPnl, pnlTone]}>{realisedLabel}</Text>
              </View>

              <View style={styles.tradeEconomicsGrid}>
                <View style={styles.tradeEconomicsCell}>
                  <Text style={styles.mutedSmall}>Entry</Text>
                  <Text style={styles.tradeEconomicsValue}>
                    {trade.fillPrice ?? trade.requestedEntryPrice}
                  </Text>
                </View>
                <View style={styles.tradeEconomicsCell}>
                  <Text style={styles.mutedSmall}>Exit</Text>
                  <Text style={styles.tradeEconomicsValue}>{trade.exitPrice ?? "—"}</Text>
                </View>
                <View style={styles.tradeEconomicsCell}>
                  <Text style={styles.mutedSmall}>Commission</Text>
                  <Text style={styles.tradeEconomicsValue}>
                    {trade.commission && trade.accountCurrency
                      ? `${trade.accountCurrency} ${trade.commission}`
                      : "—"}
                  </Text>
                </View>
                <View style={styles.tradeEconomicsCell}>
                  <Text style={styles.mutedSmall}>Swap</Text>
                  <Text style={styles.tradeEconomicsValue}>
                    {trade.swap && trade.accountCurrency
                      ? `${trade.accountCurrency} ${trade.swap}`
                      : "—"}
                  </Text>
                </View>
              </View>

              <View style={styles.rowBetween}>
                <Text style={styles.mutedSmall}>
                  {trade.closeReason
                    ? trade.closeReason.replaceAll("_", " ")
                    : "Close reason —"}
                </Text>
                <Text style={styles.mutedSmall}>{trade.lotSize} lots</Text>
              </View>
              <Text style={styles.mutedSmall}>
                Opened {trade.openedAt ? new Date(trade.openedAt).toLocaleString() : "—"}
              </Text>
              <Text style={styles.mutedSmall}>
                Closed {trade.closedAt ? new Date(trade.closedAt).toLocaleString() : "—"}
              </Text>
            </View>
          );
        })
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>No closed trades recorded yet.</Text>
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
      <ActionDialog
        visible={closeDialog != null}
        kicker="RISK-REDUCING ACTION"
        title={
          closeDialog?.kind === "single"
            ? "Close this position?"
            : "Close all AI-opened positions?"
        }
        message={
          closeDialog?.kind === "single"
            ? `${closeDialog.position.instrument} ${closeDialog.position.direction} · ${closeDialog.position.lotSize} lots`
            : `Visible AI-opened positions: ${closeDialog?.count ?? 0}`
        }
        detailLines={
          closeDialog?.kind === "single"
            ? [
                "Closure is requested immediately through the execution service.",
                "The broker-confirmed exit price may differ from the currently displayed market mark.",
                "The position remains shown until the server confirms the authoritative state.",
              ]
            : [
                "Only positions the server can prove were opened by iRexPro are included.",
                "Broker/manual positions without AI provenance are not swept.",
                "Any unresolved broker closure remains visible for reconciliation.",
              ]
        }
        confirmLabel={
          closeDialog?.kind === "single"
            ? "Close position"
            : "Close all AI positions"
        }
        cancelLabel={closeDialog?.kind === "single" ? "Keep open" : "Cancel"}
        onConfirm={() => void confirmCloseDialog()}
        onCancel={() => {
          if (!closeDialogBusy) setCloseDialog(null);
        }}
        busy={closeDialogBusy}
        danger
      />
    </>
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
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#334155",
    marginTop: 20,
    marginBottom: 8,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  closeAllButton: {
    marginTop: 12,
    borderRadius: 9,
    backgroundColor: "#be123c",
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 84,
    alignItems: "center",
  },
  closeAllButtonText: { color: "#ffffff", fontSize: 12, fontWeight: "800" },
  closePositionButton: {
    marginTop: 4,
    alignSelf: "flex-start",
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#fecdd3",
    backgroundColor: "#fff1f2",
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 118,
    alignItems: "center",
  },
  closePositionButtonText: { color: "#be123c", fontSize: 12, fontWeight: "800" },
  disabledControl: { opacity: 0.45 },
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
  realisedPnl: { fontSize: 12, fontWeight: "800" },
  realisedPositive: { color: "#047857" },
  realisedNegative: { color: "#be123c" },
  tradeEconomicsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 2,
  },
  tradeEconomicsCell: {
    flexBasis: "48%",
    borderRadius: 8,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  tradeEconomicsValue: { color: "#0f172a", fontSize: 12, fontWeight: "700" },
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
});
