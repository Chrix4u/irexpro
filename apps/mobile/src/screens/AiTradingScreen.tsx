import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  AiAutomationRuntimeStatusView,
  ExecutionConfirmationView,
  TradingSessionView,
  UserCapitalAllocationView,
} from "@irexpro/types/execution";
import { api } from "../lib/api";
import { ActionDialog, Banner } from "../components/ui";
import {
  describeStopSummary,
  isAutomationRunning,
  isBrokerExecutionReady,
  pinnedBrokerId,
  startExecutionModeFor,
} from "./ai-trading-screen.logic";

type BusyAction = "ALLOCATE" | "START" | "STOP" | null;

type AiActionDialog =
  | {
      kind: "START";
      title: string;
      message: string;
      detailLines: string[];
      confirmLabel: string;
      danger?: false;
    }
  | {
      kind: "STOP";
      title: string;
      message: string;
      detailLines: string[];
      confirmLabel: string;
      danger: true;
    }
  | {
      kind: "ORDER";
      title: string;
      message: string;
      detailLines: string[];
      confirmLabel: string;
      confirmation: ExecutionConfirmationView;
    };

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

function formatConfidence(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function formatRuntimeTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function modelModeLabel(value: string | null | undefined): string {
  if (!value) return "Unknown";
  if (value === "heuristic_placeholder") return "Heuristic scaffold";
  if (value === "trained_xgboost_mtf") return "Trained MTF XGBoost";
  if (value === "trained_xgboost" || value === "real") return "Trained XGBoost";
  return value.replaceAll("_", " ");
}

function runtimeReasonLabel(value: string | null | undefined): string {
  if (!value) return "Waiting for the first market scan.";
  const labels: Record<string, string> = {
    confidence_below_threshold:
      "Market setup did not meet the confidence threshold.",
    confidence_threshold_passed:
      "Signal passed the confidence threshold and was published.",
    market_data_unchanged:
      "No new market-data revision was available, so no duplicate signal was published.",
    scheduler_integration_disabled: "AI scheduler integration is disabled.",
    model_not_approved_for_live:
      "Current AI model is not yet approved for live-money automation.",
    MarketDataError:
      "Market data is unavailable or invalid; this scan was skipped.",
    research_uat_replay_budget_exhausted:
      "Research PAPER replay completed its bounded market steps without an eligible signal.",
    uat_workflow_probe_published:
      "Synthetic Research PAPER workflow probe published; the model did not pass the normal confidence gate.",
  };
  return labels[value] ?? value.replaceAll("_", " ");
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
  const [notice, setNotice] = useState<
    { variant: "success" | "info" | "error"; message: string } | null
  >(null);
  const [runtime, setRuntime] = useState<AiAutomationRuntimeStatusView | null>(null);
  const [runtimeWarning, setRuntimeWarning] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<ExecutionConfirmationView[]>([]);
  const [confirmationsWarning, setConfirmationsWarning] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<AiActionDialog | null>(null);

  const automationOn = isAutomationRunning(session);

  const selectedBroker = useMemo(
    () =>
      connections.find((connection) => connection.id === selectedBrokerId) ??
      null,
    [connections, selectedBrokerId],
  );

  const sessionBroker = useMemo(
    () =>
      session
        ? connections.find(
            (connection) => connection.id === session.brokerConnectionId,
          ) ?? null
        : null,
    [connections, session],
  );

  const connectedAlternatives = useMemo(
    () =>
      connections.filter(
        (connection) =>
          connection.status === "CONNECTED" &&
          connection.id !== session?.brokerConnectionId,
      ),
    [connections, session],
  );

  const sessionBrokerDisconnected =
    Boolean(sessionBroker) && sessionBroker?.status !== "CONNECTED";

  const selectableConnections = useMemo(() => {
    if (session) {
      const bound = connections.find(
        (connection) => connection.id === session.brokerConnectionId,
      );
      return bound
        ? [bound, ...connectedAlternatives]
        : connectedAlternatives;
    }
    return connections.filter((connection) => connection.status === "CONNECTED");
  }, [connectedAlternatives, connections, session]);

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

  const loadRuntime = useCallback(async (activeSession: TradingSessionView | null) => {
    if (!activeSession) {
      setRuntime(null);
      setRuntimeWarning(null);
      return;
    }

    try {
      const next = await api.getAutomationRuntimeStatus(activeSession.id);
      setRuntime(next);
      setRuntimeWarning(null);
    } catch {
      setRuntime(null);
      setRuntimeWarning(
        "AI Trading is running, but the AI engine runtime status could not be verified yet. Start/Stop controls remain governed by the server trading session.",
      );
    }
  }, []);

  const loadConfirmations = useCallback(async (activeSession: TradingSessionView | null) => {
    if (!activeSession || activeSession.executionMode !== "SEMI_AUTO") {
      setConfirmations([]);
      setConfirmationsWarning(null);
      return;
    }

    try {
      const payload = await api.listPendingExecutionConfirmations();
      setConfirmations(payload.confirmations);
      setConfirmationsWarning(null);
    } catch {
      setConfirmations([]);
      setConfirmationsWarning(
        "Pending SEMI_AUTO confirmations could not be loaded from the server. No order has been approved locally.",
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

      await Promise.all([
        loadAllocation(nextBrokerId),
        loadRuntime(activeSession.session),
        loadConfirmations(activeSession.session),
      ]);
    } catch (requestError) {
      setError(safeMessage(requestError, "Failed to load AI Trading"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadAllocation, loadConfirmations, loadRuntime]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      void loadRuntime(session);
    }, 8000);
    return () => clearInterval(timer);
  }, [loadRuntime, session]);

  useEffect(() => {
    if (!session || session.executionMode !== "SEMI_AUTO") return;
    const timer = setInterval(() => {
      void loadConfirmations(session);
    }, 5000);
    return () => clearInterval(timer);
  }, [loadConfirmations, session]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const chooseBroker = useCallback(
    (connectionId: string) => {
      if (automationOn) {
        setNotice({
          variant: "info",
          message: "AI Trading is running. Stop AI Trading before switching broker accounts.",
        });
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
      setNotice({
        variant: "info",
        message: "Broker required. Connect and select a broker account first.",
      });
      return;
    }
    if (automationOn) {
      setNotice({
        variant: "info",
        message: "AI Trading is running. Stop it before changing the capital allocation.",
      });
      return;
    }

    const amount = allocationAmount.trim();
    if (!/^\d+(?:\.\d+)?$/.test(amount) || /^0+(?:\.0+)?$/.test(amount)) {
      setNotice({
        variant: "info",
        message: "Enter a positive decimal amount without currency symbols.",
      });
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
      setNotice({
        variant: "success",
        message: `${money(next.allocatedCapital, next.accountCurrency)} is available to AI Trading, subject to server protections and committed exposure.`,
      });
    } catch (requestError) {
      const message = safeMessage(requestError, "Failed to save capital allocation");
      setError(message);
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
    setNotice(null);
    try {
      await api.startTradingSession({
        brokerConnectionId: selectedBroker.id,
        executionMode: startExecutionModeFor(selectedBroker),
      });
      setNotice({
        variant: "success",
        message:
          selectedBroker.brokerId === "paper-broker"
            ? "AI Trading is running in the internal paper simulator."
            : selectedBroker.accountType === "DEMO"
              ? "AI Trading is running against this broker's DEMO environment. No live funds are used."
              : "AI Trading is running for this verified live account.",
      });
      await load();
    } catch (requestError) {
      const message = safeMessage(requestError, "Failed to start AI Trading");
      setError(message);
    } finally {
      setBusy(null);
    }
  }, [allocation, load, selectedBroker]);

  const stopTrading = useCallback(async () => {
    if (!session) {
      setNotice({ variant: "info", message: "AI Trading is already stopped." });
      return;
    }

    setBusy("STOP");
    setError(null);
    setNotice(null);
    try {
      const result = await api.stopTradingSession(session.id);
      const presentation = describeStopSummary(result);
      setNotice({
        variant: "info",
        message: `${presentation.title}: ${presentation.message}`,
      });
      await load();
    } catch (requestError) {
      const message = safeMessage(requestError, "Failed to stop AI Trading");
      setError(
        message +
          " Check Positions & Activity before assuming any AI-opened position is closed.",
      );
    } finally {
      setBusy(null);
    }
  }, [load, session]);

  const confirmPendingOrder = useCallback(
    async (confirmation: ExecutionConfirmationView) => {
      if (!session || confirmingId) return;
      setConfirmingId(confirmation.id);
      setConfirmationsWarning(null);
      try {
        const result = await api.confirmExecutionConfirmation(confirmation.id);
        if (result.status === "CONSUMED") {
          setNotice({
            variant: "success",
            message: `${confirmation.direction} ${confirmation.instrument} · ${confirmation.quantity} was accepted for the exact bound server order payload. Final execution still depends on current server/broker protections.`,
          });
        }
        await Promise.all([
          loadConfirmations(session),
          loadRuntime(session),
        ]);
      } catch (requestError) {
        const message = safeMessage(
          requestError,
          "The server rejected this order confirmation.",
        );
        setConfirmationsWarning(
          message +
            " No approval has been assumed. Refresh AI Trading to verify the server state.",
        );
        await loadConfirmations(session);
      } finally {
        setConfirmingId(null);
      }
    },
    [confirmingId, loadConfirmations, loadRuntime, session],
  );

  const requestOrderConfirmation = useCallback(
    (confirmation: ExecutionConfirmationView) => {
      if (confirmingId) return;
      setActionDialog({
        kind: "ORDER",
        title: "Confirm this AI order?",
        message: `${confirmation.direction} ${confirmation.instrument} · ${confirmation.quantity}`,
        detailLines: [
          `Stop loss: ${confirmation.stopLoss ?? "—"} · Take profit: ${confirmation.takeProfit ?? "—"}`,
          `Expires: ${formatRuntimeTime(confirmation.expiresAt)}`,
          `Payload digest: ${confirmation.orderPayloadDigest}`,
          "This approval is one-time and bound to this exact server order payload.",
        ],
        confirmLabel: "Confirm order",
        confirmation,
      });
    },
    [confirmingId],
  );

  const requestAutomationAction = useCallback(() => {
    if (automationOn) {
      setActionDialog({
        kind: "STOP",
        title: "Stop AI Trading and close AI positions?",
        message:
          "New AI exposure will be stopped first, then iRexPro will request closure of every open position it can prove was opened by the AI.",
        detailLines: [
          "Broker market conditions determine each actual exit price.",
          "Unverified closures remain visible for follow-up rather than being presented as closed.",
          "Manual or externally opened positions are not included in the AI-owned close request.",
        ],
        confirmLabel: "Stop & close AI positions",
        danger: true,
      });
      return;
    }

    if (!selectedBroker) {
      setNotice({
        variant: "info",
        message: "Broker required. Connect and select a broker account before starting AI Trading.",
      });
      return;
    }

    if (!isBrokerExecutionReady(selectedBroker)) {
      setNotice({
        variant: "info",
        message:
          "Broker not ready. This account must be CONNECTED with ACTIVE authorization before AI Trading can start.",
      });
      return;
    }

    if (!allocation?.hasAllocation || !allocation.allocatedCapital) {
      setNotice({
        variant: "info",
        message: "Allocate capital first. Choose how much broker capital the AI may use before starting.",
      });
      return;
    }

    setActionDialog({
      kind: "START",
      title: "Start AI Trading?",
      message:
        "The AI may open, manage and close positions automatically until you stop it, within the capital allocation and server-enforced protections.",
      detailLines: [
        `Broker: ${brokerLabel(selectedBroker)} (${selectedBroker.accountType})`,
        `AI allocation: ${money(allocation.allocatedCapital, allocation.accountCurrency)}`,
        "Risk checks remain server-authoritative for every order.",
      ],
      confirmLabel: "Start AI Trading",
    });
  }, [
    allocation,
    automationOn,
    selectedBroker,
    startTrading,
    stopTrading,
  ]);

  const confirmActionDialog = useCallback(async () => {
    const current = actionDialog;
    if (!current) return;
    setActionDialog(null);
    if (current.kind === "START") {
      await startTrading();
      return;
    }
    if (current.kind === "STOP") {
      await stopTrading();
      return;
    }
    await confirmPendingOrder(current.confirmation);
  }, [actionDialog, confirmPendingOrder, startTrading, stopTrading]);

  const actionDialogBusy =
    actionDialog == null
      ? false
      : actionDialog.kind === "START"
        ? busy === "START"
        : actionDialog.kind === "STOP"
          ? busy === "STOP"
          : confirmingId === actionDialog.confirmation.id;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#14b8a6" />
        <Text style={styles.muted}>Loading AI Trading…</Text>
      </View>
    );
  }

  return (
    <>
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

        {notice ? <Banner variant={notice.variant}>{notice.message}</Banner> : null}

        {sessionBrokerDisconnected ? (
          <View style={styles.sessionBindingWarning} accessibilityRole="alert">
            <Text style={styles.sessionBindingWarningTitle}>
              Active AI session broker is disconnected
            </Text>
            <Text style={styles.sessionBindingWarningText}>
              This AI session is still bound to {sessionBroker ? brokerLabel(sessionBroker) : "its original broker"}.
              {connectedAlternatives.length > 0
                ? ` ${connectedAlternatives.length} other connected broker account${connectedAlternatives.length === 1 ? "" : "s"} ${connectedAlternatives.length === 1 ? "is" : "are"} available, but iRexPro will not silently move an active trading session to another account. Stop AI Trading first, then select the connected broker.`
                : " Reconnect that broker or stop AI Trading before selecting another account."}
            </Text>
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
                        {session?.brokerConnectionId === connection.id
                          ? "SESSION"
                          : "AVAILABLE"}{" · "}
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
                    <Text style={styles.detailLabel}>Connection</Text>
                    <Text
                      style={[
                        styles.detailValue,
                        selectedBroker.status === "CONNECTED"
                          ? styles.goodText
                          : styles.warnText,
                      ]}
                    >
                      {selectedBroker.status}
                    </Text>
                  </View>
                  <View style={styles.detailCell}>
                    <Text style={styles.detailLabel}>Authorization</Text>
                    <Text style={styles.detailValue}>
                      {selectedBroker.authorizationStatus}
                    </Text>
                  </View>
                  <View style={styles.detailCell}>
                    <Text style={styles.detailLabel}>AI readiness</Text>
                    <Text
                      style={[
                        styles.detailValue,
                        isBrokerExecutionReady(selectedBroker)
                          ? styles.goodText
                          : styles.warnText,
                      ]}
                    >
                      {isBrokerExecutionReady(selectedBroker)
                        ? "READY"
                        : "AUTHORIZATION REQUIRED"}
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

        {session?.executionMode === "SEMI_AUTO" ? (
          <View style={[styles.card, styles.confirmationCard]}>
            <View style={styles.runtimeHeader}>
              <View style={styles.runtimeHeaderCopy}>
                <Text style={styles.cardKicker}>SEMI-AUTO CONFIRMATIONS</Text>
                <Text style={styles.cardTitle}>
                  Pending orders · {confirmations.length}
                </Text>
              </View>
            </View>

            <Text style={styles.muted}>
              Every order below was queued by the server and is bound to an exact
              one-time payload. Confirming relays approval only; final execution
              remains subject to current risk, authority and broker checks.
            </Text>

            {confirmationsWarning ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.runtimeWarningText}>{confirmationsWarning}</Text>
              </View>
            ) : null}

            {confirmations.length > 0 ? (
              confirmations.map((confirmation) => (
                <View key={confirmation.id} style={styles.confirmationItem}>
                  <View style={styles.runtimeHeader}>
                    <View style={styles.runtimeHeaderCopy}>
                      <Text style={styles.confirmationInstrument}>
                        {confirmation.direction} {confirmation.instrument}
                      </Text>
                      <Text style={styles.runtimeSubvalue}>
                        {confirmation.quantity} · expires{" "}
                        {formatRuntimeTime(confirmation.expiresAt)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.detailGrid}>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>Stop loss</Text>
                      <Text style={styles.detailValue}>
                        {confirmation.stopLoss ?? "—"}
                      </Text>
                    </View>
                    <View style={styles.detailCell}>
                      <Text style={styles.detailLabel}>Take profit</Text>
                      <Text style={styles.detailValue}>
                        {confirmation.takeProfit ?? "—"}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.detailLabel}>Bound payload digest</Text>
                  <Text selectable style={styles.payloadDigest}>
                    {confirmation.orderPayloadDigest}
                  </Text>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm ${confirmation.direction} ${confirmation.instrument} order`}
                    disabled={confirmingId !== null}
                    onPress={() => requestOrderConfirmation(confirmation)}
                    style={[
                      styles.confirmButton,
                      confirmingId !== null && styles.disabled,
                    ]}
                  >
                    {confirmingId === confirmation.id ? (
                      <ActivityIndicator color="#042f2e" size="small" />
                    ) : (
                      <Text style={styles.confirmButtonText}>Confirm exact order</Text>
                    )}
                  </Pressable>
                </View>
              ))
            ) : (
              <Text style={styles.hint}>
                No server-queued confirmations are pending.
              </Text>
            )}
          </View>
        ) : null}

        {runtimeWarning ? (
          <View style={styles.runtimeWarningCard} accessibilityRole="alert">
            <Text style={styles.runtimeWarningTitle}>AI runtime status unavailable</Text>
            <Text style={styles.runtimeWarningText}>{runtimeWarning}</Text>
          </View>
        ) : null}

        {automationOn && runtime ? (
          <View style={[styles.card, styles.runtimeCard]}>
            <View style={styles.runtimeHeader}>
              <View style={styles.runtimeHeaderCopy}>
                <Text style={styles.cardKicker}>AI RUNTIME</Text>
                <Text style={styles.cardTitle}>
                  {runtime.research_uat ? "Research PAPER UAT" : "Automation runtime"}
                </Text>
              </View>
              <View
                style={[
                  styles.runtimeBadge,
                  runtime.active ? styles.runtimeBadgeActive : styles.runtimeBadgeIdle,
                ]}
              >
                <Text
                  style={[
                    styles.runtimeBadgeText,
                    runtime.active ? styles.runtimeBadgeTextActive : styles.runtimeBadgeTextIdle,
                  ]}
                >
                  {runtime.active ? "ACTIVE" : "IDLE"}
                </Text>
              </View>
            </View>

            {runtime.research_uat ? (
              <View style={styles.researchBanner}>
                <Text style={styles.researchBannerTitle}>RESEARCH PAPER</Text>
                <Text style={styles.researchBannerText}>
                  Simulated execution only. Model promotion gates remain unchanged.
                </Text>
              </View>
            ) : null}

            <View style={styles.confidencePanel}>
              <View>
                <Text style={styles.detailLabel}>
                  {runtime.last_decision === "NO_NEW_MARKET_DATA"
                    ? "Last evaluated confidence"
                    : "AI confidence"}
                </Text>
                <Text style={styles.confidenceValue}>
                  {formatConfidence(runtime.last_confidence_score)}
                </Text>
              </View>
              <View style={styles.confidenceGate}>
                <Text style={styles.detailLabel}>Gate</Text>
                <Text style={styles.confidenceGateValue}>
                  {formatConfidence(runtime.confidence_threshold)}
                </Text>
              </View>
            </View>

            <Text style={styles.runtimeReason}>
              {runtimeReasonLabel(runtime.last_reason)}
            </Text>

            <View style={styles.runtimeGrid}>
              <View style={styles.runtimeCell}>
                <Text style={styles.detailLabel}>Model</Text>
                <Text style={styles.runtimeValue}>
                  {runtime.model_version ?? "Awaiting model"}
                </Text>
                <Text style={styles.runtimeSubvalue}>
                  {modelModeLabel(runtime.model_mode)} ·{" "}
                  {runtime.model_loaded === true
                    ? "loaded"
                    : runtime.model_loaded === false
                      ? "not loaded"
                      : "load state unknown"}
                </Text>
              </View>
              <View style={styles.runtimeCell}>
                <Text style={styles.detailLabel}>Last decision</Text>
                <Text style={styles.runtimeValue}>
                  {runtime.last_decision?.replaceAll("_", " ") ?? "WAITING"}
                </Text>
                <Text style={styles.runtimeSubvalue}>
                  {runtime.instruments.length
                    ? runtime.instruments.join(", ")
                    : "No instruments reported"}
                </Text>
              </View>
              <View style={styles.runtimeCell}>
                <Text style={styles.detailLabel}>Timeframe / scan</Text>
                <Text style={styles.runtimeValue}>
                  {runtime.timeframe ?? "MTF"} ·{" "}
                  {runtime.interval_seconds != null
                    ? `${runtime.interval_seconds}s`
                    : "interval —"}
                </Text>
                <Text style={styles.runtimeSubvalue}>
                  Next {formatRuntimeTime(runtime.next_run_at)}
                </Text>
              </View>
              <View style={styles.runtimeCell}>
                <Text style={styles.detailLabel}>Market timestamp</Text>
                <Text style={styles.runtimeValue}>
                  {formatRuntimeTime(runtime.last_market_data_at)}
                </Text>
                <Text style={styles.runtimeSubvalue}>
                  Last close {runtime.last_market_data_close ?? "—"}
                </Text>
              </View>
              <View style={styles.runtimeCell}>
                <Text style={styles.detailLabel}>Replay steps</Text>
                <Text style={styles.runtimeValue}>
                  {runtime.replay_steps_total ?? 0}
                </Text>
                <Text style={styles.runtimeSubvalue}>
                  Last cycle {runtime.replay_steps_last_cycle ?? 0}
                </Text>
              </View>
              <View style={styles.runtimeCell}>
                <Text style={styles.detailLabel}>Executions / signals</Text>
                <Text style={styles.runtimeValue}>
                  {runtime.executions_succeeded_total ?? 0} /{" "}
                  {runtime.signals_published_total ?? 0}
                </Text>
                <Text style={styles.runtimeSubvalue}>
                  Downstream rejected {runtime.downstream_rejected_total ?? 0}
                </Text>
              </View>
            </View>

            <Text style={styles.sessionMeta}>
              Last scan {formatRuntimeTime(runtime.last_run_at)}
            </Text>
          </View>
        ) : automationOn && !runtimeWarning ? (
          <View style={styles.card}>
            <Text style={styles.cardKicker}>AI RUNTIME</Text>
            <Text style={styles.muted}>Waiting for runtime status…</Text>
          </View>
        ) : null}

        <View style={styles.truthCard}>
          <Text style={styles.truthTitle}>Execution truth</Text>
          <Text style={styles.truthText}>
            Start/Stop state comes from the server trading session. Stopping revokes new AI exposure before requesting closure of AI-opened positions. Any closure the broker cannot prove is shown as unresolved instead of being presented as closed.
          </Text>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
      <ActionDialog
        visible={actionDialog != null}
        kicker={
          actionDialog?.kind === "ORDER"
            ? "SEMI-AUTO ORDER"
            : actionDialog?.kind === "STOP"
              ? "AI TRADING SAFETY"
              : "AI TRADING"
        }
        title={actionDialog?.title ?? ""}
        message={actionDialog?.message ?? ""}
        detailLines={actionDialog?.detailLines ?? []}
        confirmLabel={actionDialog?.confirmLabel ?? "Confirm"}
        cancelLabel={actionDialog?.kind === "STOP" ? "Keep running" : "Cancel"}
        onConfirm={() => void confirmActionDialog()}
        onCancel={() => {
          if (!actionDialogBusy) setActionDialog(null);
        }}
        busy={actionDialogBusy}
        danger={actionDialog?.kind === "STOP" && actionDialog.danger === true}
      />
    </>
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
  confirmationCard: { borderColor: "#6d28d9" },
  confirmationItem: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#413060",
    backgroundColor: "#0c1322",
    padding: 12,
    gap: 10,
  },
  confirmationInstrument: { color: "#e9d5ff", fontSize: 14, fontWeight: "800" },
  inlineWarning: {
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#854d0e",
    backgroundColor: "#271a08",
    padding: 9,
  },
  payloadDigest: {
    color: "#a8b3cf",
    fontSize: 9,
    lineHeight: 14,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  confirmButton: {
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: "#c4b5fd",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  confirmButtonText: { color: "#2e1065", fontSize: 12, fontWeight: "900" },
  runtimeWarningCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#854d0e",
    backgroundColor: "#271a08",
    padding: 12,
    marginBottom: 12,
    gap: 4,
  },
  runtimeWarningTitle: { color: "#fde68a", fontSize: 12, fontWeight: "800" },
  runtimeWarningText: { color: "#fcd34d", fontSize: 11, lineHeight: 17 },
  runtimeCard: { borderColor: "#155e75" },
  runtimeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  runtimeHeaderCopy: { flex: 1, gap: 4 },
  runtimeBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  runtimeBadgeActive: { borderColor: "#14b8a6", backgroundColor: "#052e2b" },
  runtimeBadgeIdle: { borderColor: "#475569", backgroundColor: "#172033" },
  runtimeBadgeText: { fontSize: 9, fontWeight: "900", letterSpacing: 0.8 },
  runtimeBadgeTextActive: { color: "#5eead4" },
  runtimeBadgeTextIdle: { color: "#cbd5e1" },
  researchBanner: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#a16207",
    backgroundColor: "#2a1d06",
    padding: 10,
    gap: 2,
  },
  researchBannerTitle: { color: "#fde68a", fontSize: 10, fontWeight: "900" },
  researchBannerText: { color: "#d6b95a", fontSize: 10, lineHeight: 15 },
  confidencePanel: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderRadius: 12,
    backgroundColor: "#0c1322",
    padding: 12,
  },
  confidenceValue: { color: "#5eead4", fontSize: 27, fontWeight: "900", marginTop: 3 },
  confidenceGate: { alignItems: "flex-end" },
  confidenceGateValue: { color: "#f8fafc", fontSize: 16, fontWeight: "800", marginTop: 3 },
  runtimeReason: { color: "#cbd5e1", fontSize: 12, lineHeight: 18 },
  runtimeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  runtimeCell: {
    flexBasis: "48%",
    flexGrow: 1,
    borderRadius: 10,
    backgroundColor: "#0c1322",
    padding: 10,
    minWidth: 140,
  },
  runtimeValue: { color: "#e2e8f0", fontSize: 12, fontWeight: "700", marginTop: 3 },
  runtimeSubvalue: { color: "#7f8ba8", fontSize: 10, lineHeight: 15, marginTop: 2 },
  sessionBindingWarning: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#a16207",
    backgroundColor: "#2a1d06",
    padding: 13,
    marginBottom: 12,
    gap: 5,
  },
  sessionBindingWarningTitle: {
    color: "#fde68a",
    fontSize: 12,
    fontWeight: "900",
  },
  sessionBindingWarningText: {
    color: "#d6b95a",
    fontSize: 11,
    lineHeight: 17,
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
