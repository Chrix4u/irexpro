/**
 * LiveAccountScreen — mobile Live Account dashboard (Sprint 51 PR-8,
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
  LiveAccountOrdersPage,
  LiveAccountOverviewView,
  LiveAccountPositionsView,
  LiveOrderRowView,
  LiveOrderStatusFilter,
  LivePositionRowView,
} from "@irexpro/types";
import { liveAccount } from "../lib/live-account";
import { useRealtime } from "../context/realtime-context";
import {
  alertSeverityColor,
  environmentBanner,
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
  const [orderFilter, setOrderFilter] = useState<LiveOrderStatusFilter>("ALL");
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
      try {
        const [ov, pos, ord] = await Promise.all([
          liveAccount.getOverview(),
          liveAccount.getPositions(),
          liveAccount.getOrders(filter),
        ]);
        setOverview(ov);
        setPositions(pos);
        setOrders(ord);
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
        <Text style={styles.title}>Live Account</Text>
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
            <View style={styles.rowBetween}>
              <Text style={styles.mutedSmall}>SL {position.stopLoss}</Text>
              <Text style={styles.mutedSmall}>TP {position.takeProfit}</Text>
            </View>
            {position.brokerName ? (
              <Text style={styles.mutedSmall}>{position.brokerName}</Text>
            ) : null}
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
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryButtonText: { color: "#b91c1c", fontWeight: "600", fontSize: 13 },
});
