import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { BrokerConnectionView } from "@irexpro/types";
import type {
  TradingSessionView,
  UserCapitalAllocationView,
} from "@irexpro/types/execution";
import { api } from "../lib/api";
import {
  describeStopSummary,
  isAutomationRunning,
  isBrokerExecutionReady,
  pinnedBrokerId,
  startExecutionModeFor,
} from "./ai-trading-screen.logic";

type BusyAction = "ALLOCATE" | "START" | "STOP" | null;

function brokerLabel(connection: BrokerConnectionView): string {
  return connection.displayName?.trim() || connection.brokerName;
}

function money(value: string | null | undefined, currency: string | null | undefined): string {
  if (!value) return "—";
  return currency ? `${currency} ${value}` : value;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function AiTradingScreen() {
  const [connections, setConnections] = useState<BrokerConnectionView[]>([]);
  const [session, setSession] = useState<TradingSessionView | null>(null);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string | null>(null);
  const selectedBrokerIdRef = useRef<string | null>(null);
  const [allocation, setAllocation] = useState<UserCapitalAllocationView | null>(null);
  const [allocationAmount, setAllocationAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  const automationOn = isAutomationRunning(session);

  const selectedBroker = useMemo(
    () =>
      connections.find((connection) => connection.id === selectedBrokerId) ??
      null,
    [connections, selectedBrokerId],
  );

  const selectableConnections = useMemo(() => {
    if (session) {
      return connections.filter(
        (connection) => connection.id === session.brokerConnectionId,
      );
    }
    return connections.filter((connection) => connection.status === "CONNECTED");
  }, [connections, session]);

  const loadAllocation = useCallback(async (brokerConnectionId: string | null) => {
    if (!brokerConnectionId) {
      setAllocation(null);
      setAllocationAmount("");
      return;
    }

    try {
      const next = await api.getCapitalAllocation(brokerConnectionId);
      setAllocation(next);
      setAllocationAmount(next.allocatedCapital ?? "");
    } catch (requestError) {
      setAllocation(null);
      setAllocationAmount("");
      setError(
        safeMessage(requestError, "Failed to load AI capital allocation"),
      );
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [userConnections, activeSession] = await Promise.all([
        api.listBrokerConnections(),
        api.getActiveTradingSession(),
      ]);

      setConnections(userConnections);
      setSession(activeSession.session);

      const nextBrokerId = pinnedBrokerId(
        userConnections,
        activeSession.session,
        selectedBrokerIdRef.current,
      );
      selectedBrokerIdRef.current = nextBrokerId;
      setSelectedBrokerId(nextBrokerId);
      setError(null);

      await loadAllocation(nextBrokerId);
    } catch (requestError) {
      setError(safeMessage(requestError, "Failed to load AI Trading"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadAllocation]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const chooseBroker = useCallback(
    (connectionId: string) => {
      if (automationOn) {
        Alert.alert(
          "AI Trading is running",
          "Stop AI Trading before switching broker accounts.",
        );
        return;
      }

      selectedBrokerIdRef.current = connectionId;
      setSelectedBrokerId(connectionId);
      setError(null);
      void loadAllocation(connectionId);
    },
    [automationOn, loadAllocation],
  );

  const saveAllocation = useCallback(async () => {
    if (!selectedBroker) {
      Alert.alert("Broker required", "Connect and select a broker account first.");
      return;
    }
    if (automationOn) {
      Alert.alert(
        "AI Trading is running",
        "Stop AI Trading before changing the capital allocation.",
      );
      return;
    }

    const amount = allocationAmount.trim();
    if (!/^\d+(?:\.\d+)?$/.test(amount) || /^0+(?:\.0+)?$/.test(amount)) {
      Alert.alert(
        "Enter a valid amount",
        "Use a positive decimal amount without currency symbols.",
      );
      return;
    }

    setBusy("ALLOCATE");
    setError(null);
    try {
      const next = await api.setCapitalAllocation({
        brokerConnectionId: selectedBroker.id,
        amount,
      });
      setAllocation(next);
      setAllocationAmount(next.allocatedCapital ?? amount);
      Alert.alert(
        "Capital allocated",
        `${money(next.allocatedCapital, next.accountCurrency)} is available to AI Trading subject to server protections and committed exposure.`,
      );
    } catch (requestError) {
      const message = safeMessage(requestError, "Failed to save capital allocation");
      setError(message);
      Alert.alert("Allocation failed", message);
    } finally {
      setBusy(null);
    }
  }, [allocationAmount, automationOn, selectedBroker]);

  const startTrading = useCallback(async () => {
    if (!selectedBroker || !allocation?.hasAllocation || !allocation.allocatedCapital) {
      return;
    }

    setBusy("START");
    setError(null);
    try {
      await api.startTradingSession({
        brokerConnectionId: selectedBroker.id,
        executionMode: startExecutionModeFor(selectedBroker),
      });
      Alert.alert(
        "AI Trading started",
        selectedBroker.brokerId === "paper-broker"
          ? "AI Trading is running in the internal paper simulator."
          : selectedBroker.accountType === "DEMO"
            ? "AI Trading is running against this broker\'s DEMO environment. No live funds are used."
            : "AI Trading is running for this verified live account.",
      );
      await load();
    } catch (requestError) {
      const message = safeMessage(requestError, "Failed to start AI Trading");
      setError(message);
      Alert.alert("Start failed", message);
    } finally {
      setBusy(null);
    }
  }, [allocation, load, selectedBroker]);

  const stopTrading = useCallback(async () => {
    if (!session) {
      Alert.alert("Already stopped", "AI Trading is already stopped.");
      return;
    }

    setBusy("STOP");
    setError(null);
    try {
      const result = await api.stopTradingSession(session.id);
      const presentation = describeStopSummary(result);
      Alert.alert(presentation.title, presentation.message);
      await load();
    } catch (requestError) {
      const message = safeMessage(requestError, "Failed to stop AI Trading");
      setError(message);
      Alert.alert(
        "Stop failed",
        message +
          "\n\nCheck Positions & Activity before assuming any AI-opened position is closed.",
      );
    } finally {
      setBusy(null);
    }
  }, [load, session]);

  const requestAutomationAction = useCallback(() => {
    if (automationOn) {
      Alert.alert(
        "Stop AI Trading and close AI positions?",
        "Confirming stops new AI trading first, then immediately requests closure of every currently open position that iRexPro can prove was opened by the AI. Broker market conditions determine the actual exit price. Unverified closures remain clearly reported for follow-up.",
        [
          { text: "Keep AI Trading Running", style: "cancel" },
          {
            text: "Stop & Close AI Positions",
            style: "destructive",
            onPress: () => void stopTrading(),
          },
        ],
      );
      return;
    }

    if (!selectedBroker) {
      Alert.alert(
        "Broker required",
        "Connect and select a broker account before starting AI Trading.",
      );
      return;
    }

    if (!isBrokerExecutionReady(selectedBroker)) {
      Alert.alert(
        "Broker not ready",
        "This broker account must be CONNECTED with ACTIVE authorization before AI Trading can start.",
      );
      return;
    }

    if (!allocation?.hasAllocation || !allocation.allocatedCapital) {
      Alert.alert(
        "Allocate capital first",
        "Choose how much broker capital the AI may use before starting AI Trading.",
      );
      return;
    }

    Alert.alert(
      "Start AI Trading?",
      `Broker: ${brokerLabel(selectedBroker)} (${selectedBroker.accountType})\nAI allocation: ${money(
        allocation.allocatedCapital,
        allocation.accountCurrency,
      )}\n\nOnce started, the AI may open, manage and close positions automatically within this allocation and the server-enforced protections until you stop AI Trading.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start AI Trading",
          onPress: () => void startTrading(),
        },
      ],
    );
  }, [
    allocation,
    automationOn,
    selectedBroker,
    startTrading,
    stopTrading,
  ]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#14b8a6" />
        <Text style={styles.muted}>Loading AI Trading…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor="#14b8a6"
          />
        }
      >
        <View style={styles.hero}>
          <View style={styles.heroCopy}>
            <Text style={styles.eyebrow}>NOVICE AI TRADER</Text>
            <Text style={styles.title}>AI Trading</Text>
            <Text style={styles.subtitle}>
              Connect your broker, allocate capital, then start or stop the AI.
            </Text>
          </View>
          <View
            style={[
              styles.stateBadge,
              automationOn ? styles.stateRunning : styles.stateStopped,
            ]}
            accessibilityLabel={automationOn ? "AI Trading running" : "AI Trading stopped"}
          >
            <Text
              style={[
                styles.stateBadgeText,
                automationOn ? styles.stateRunningText : styles.stateStoppedText,
              ]}
            >
              {automationOn ? "RUNNING" : "STOPPED"}
            </Text>
          </View>
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
              style={styles.retryButton}
              onPress={() => void load()}
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardKicker}>1 · BROKER ACCOUNT</Text>
          {selectableConnections.length === 0 ? (
            <>
              <Text style={styles.cardTitle}>No connected broker</Text>
              <Text style={styles.muted}>
                Open the Broker tab and connect an account before using AI Trading.
              </Text>
            </>
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.brokerOptions}
              >
                {selectableConnections.map((connection) => {
                  const selected = connection.id === selectedBrokerId;
                  return (
                    <Pressable
                      key={connection.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: automationOn }}
                      accessibilityLabel={`Select ${brokerLabel(connection)} ${connection.accountType}`}
                      disabled={automationOn}
                      onPress={() => chooseBroker(connection.id)}
                      style={[
                        styles.brokerOption,
                        selected && styles.brokerOptionSelected,
                        automationOn && styles.disabled,
                      ]}
                    >
                      <Text
                        style={[
                          styles.brokerOptionTitle,
                          selected && styles.brokerOptionTitleSelected,
                        ]}
                      >
                        {brokerLabel(connection)}
                      </Text>
                      <Text style={styles.brokerOptionMeta}>
                        {connection.accountType} · {connection.status}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {selectedBroker ? (
                <View style={styles.detailGrid}>
                  <View style={styles.detailCell}>
                    <Text style={styles.detailLabel}>Environment</Text>
                    <Text style={styles.detailValue}>{selectedBroker.accountType}</Text>
                  </View>
                  <View style={styles.detailCell}>
                    <Text style={styles.detailLabel}>Authorization</Text>
                    <Text
                      style={[
                        styles.detailValue,
                        isBrokerExecutionReady(selectedBroker)
                          ? styles.goodText
                          : styles.warnText,
                      ]}
                    >
                      {selectedBroker.authorizationStatus}
                    </Text>
                  </View>
                </View>
              ) : null}
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardKicker}>2 · AI CAPITAL ALLOCATION</Text>
          <View style={styles.inputRow}>
            <TextInput
              accessibilityLabel="AI capital allocation amount"
              value={allocationAmount}
              onChangeText={setAllocationAmount}
              editable={!automationOn && busy === null && !!selectedBroker}
              keyboardType="decimal-pad"
              placeholder={allocation?.brokerEquity ?? "0.00"}
              placeholderTextColor="#65718e"
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Allocate capital"
              disabled={automationOn || busy !== null || !selectedBroker}
              onPress={() => void saveAllocation()}
              style={[
                styles.smallPrimaryButton,
                (automationOn || busy !== null || !selectedBroker) && styles.disabled,
              ]}
            >
              {busy === "ALLOCATE" ? (
                <ActivityIndicator color="#042f2e" size="small" />
              ) : (
                <Text style={styles.smallPrimaryButtonText}>Allocate</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.moneyGrid}>
            <View style={styles.moneyCell}>
              <Text style={styles.detailLabel}>Broker equity</Text>
              <Text style={styles.moneyValue}>
                {money(allocation?.brokerEquity, allocation?.accountCurrency)}
              </Text>
            </View>
            <View style={styles.moneyCell}>
              <Text style={styles.detailLabel}>Allocated</Text>
              <Text style={styles.moneyValue}>
                {money(allocation?.allocatedCapital, allocation?.accountCurrency)}
              </Text>
            </View>
            <View style={styles.moneyCell}>
              <Text style={styles.detailLabel}>Committed</Text>
              <Text style={styles.moneyValue}>
                {money(allocation?.committedCapital, allocation?.accountCurrency)}
              </Text>
            </View>
            <View style={styles.moneyCell}>
              <Text style={styles.detailLabel}>Available</Text>
              <Text style={styles.moneyValue}>
                {money(allocation?.availableCapital, allocation?.accountCurrency)}
              </Text>
            </View>
          </View>

          <Text style={styles.hint}>
            Allocation is stored against this exact broker account. It cannot be changed while AI Trading is running.
          </Text>
        </View>

        <View style={[styles.card, automationOn && styles.runningCard]}>
          <Text style={styles.cardKicker}>3 · AI TRADING</Text>
          <View style={styles.rowBetween}>
            <View style={styles.actionCopy}>
              <Text style={styles.cardTitle}>
                {automationOn ? "AI Trading is running" : "AI Trading is stopped"}
              </Text>
              <Text style={styles.muted}>
                {automationOn
                  ? "The AI may open and manage positions within your allocation. Stop requires confirmation and closes AI-opened positions."
                  : "The AI cannot create new positions while stopped."}
              </Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={automationOn ? "Stop AI Trading" : "Start AI Trading"}
            disabled={busy !== null || (!automationOn && !selectedBroker)}
            onPress={requestAutomationAction}
            style={[
              styles.actionButton,
              automationOn ? styles.stopButton : styles.startButton,
              (busy !== null || (!automationOn && !selectedBroker)) && styles.disabled,
            ]}
          >
            {busy === "START" || busy === "STOP" ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.actionButtonText}>
                {automationOn ? "Stop AI Trading" : "Start AI Trading"}
              </Text>
            )}
          </Pressable>

          {session ? (
            <Text style={styles.sessionMeta}>
              Session {session.status} · {session.executionMode} · authority generation {session.authorityGeneration}
            </Text>
          ) : null}
        </View>

        <View style={styles.truthCard}>
          <Text style={styles.truthTitle}>Execution truth</Text>
          <Text style={styles.truthText}>
            Start/Stop state comes from the server trading session. Stopping revokes new AI exposure before requesting closure of AI-opened positions. Any closure the broker cannot prove is shown as unresolved instead of being presented as closed.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: {
    flex: 1,
    backgroundColor: "#0b1020",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  scrollContent: {
    backgroundColor: "#0b1020",
    padding: 16,
    paddingBottom: 44,
  },
  hero: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
    marginTop: 6,
    marginBottom: 16,
  },
  heroCopy: { flex: 1 },
  eyebrow: {
    color: "#5eead4",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.6,
    marginBottom: 5,
  },
  title: { color: "#f8fafc", fontSize: 28, fontWeight: "800" },
  subtitle: {
    color: "#94a3b8",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  stateBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 20,
  },
  stateRunning: { backgroundColor: "#052e2b", borderColor: "#14b8a6" },
  stateStopped: { backgroundColor: "#161d31", borderColor: "#3b4865" },
  stateBadgeText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  stateRunningText: { color: "#5eead4" },
  stateStoppedText: { color: "#a8b3cf" },
  card: {
    backgroundColor: "#11182a",
    borderWidth: 1,
    borderColor: "#26324b",
    borderRadius: 16,
    padding: 15,
    marginBottom: 12,
    gap: 10,
  },
  runningCard: { borderColor: "#0f766e" },
  cardKicker: {
    color: "#6ee7d8",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  cardTitle: { color: "#f1f5f9", fontSize: 16, fontWeight: "700" },
  muted: { color: "#94a3b8", fontSize: 13, lineHeight: 19 },
  brokerOptions: { gap: 8, paddingVertical: 2 },
  brokerOption: {
    minWidth: 150,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#33415f",
    backgroundColor: "#0d1424",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  brokerOptionSelected: {
    borderColor: "#14b8a6",
    backgroundColor: "#0b2728",
  },
  brokerOptionTitle: { color: "#cbd5e1", fontSize: 13, fontWeight: "700" },
  brokerOptionTitleSelected: { color: "#5eead4" },
  brokerOptionMeta: { color: "#7f8ba8", fontSize: 10, marginTop: 3 },
  detailGrid: { flexDirection: "row", gap: 8 },
  detailCell: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: "#0c1322",
    padding: 10,
  },
  detailLabel: {
    color: "#7f8ba8",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  detailValue: { color: "#e2e8f0", fontSize: 12, fontWeight: "700", marginTop: 3 },
  goodText: { color: "#5eead4" },
  warnText: { color: "#fbbf24" },
  inputRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    backgroundColor: "#0c1322",
    borderWidth: 1,
    borderColor: "#33415f",
    borderRadius: 10,
    color: "#f8fafc",
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
  },
  smallPrimaryButton: {
    minWidth: 86,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: "#2dd4bf",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  smallPrimaryButtonText: { color: "#042f2e", fontSize: 12, fontWeight: "800" },
  moneyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  moneyCell: {
    flexBasis: "48%",
    flexGrow: 1,
    backgroundColor: "#0c1322",
    borderRadius: 10,
    padding: 10,
  },
  moneyValue: { color: "#f8fafc", fontSize: 14, fontWeight: "700", marginTop: 4 },
  hint: { color: "#7f8ba8", fontSize: 11, lineHeight: 16 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between" },
  actionCopy: { flex: 1 },
  actionButton: {
    minHeight: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  startButton: { backgroundColor: "#0d9488" },
  stopButton: { backgroundColor: "#be123c" },
  actionButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  sessionMeta: {
    color: "#77839f",
    fontSize: 10,
    textAlign: "center",
  },
  truthCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#243049",
    backgroundColor: "#0d1424",
    padding: 14,
  },
  truthTitle: { color: "#cbd5e1", fontSize: 12, fontWeight: "800", marginBottom: 5 },
  truthText: { color: "#7f8ba8", fontSize: 11, lineHeight: 17 },
  errorCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#7f1d1d",
    backgroundColor: "#2b1118",
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  errorText: { color: "#fecaca", fontSize: 12, lineHeight: 18 },
  retryButton: {
    alignSelf: "flex-start",
    borderRadius: 8,
    backgroundColor: "#3b1620",
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  retryButtonText: { color: "#fecaca", fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.48 },
});
