/**
 * BrokerScreen — mobile broker catalog + connection flow (Sprint 51 PR-8,
 * Directive §AE/§AF/§AU — mobile phases M5/M6).
 *
 * The catalog ALWAYS comes from the server-authoritative registry
 * (GET /broker/registry → { catalogVersion, brokers }) — never a
 * client-side broker list. Entries without a live adapter are rendered
 * with honest status and are NOT connectable (fail-closed §AB).
 * Production-LIVE release-truth (Phase I): the environment selector
 * offers LIVE only for VERIFIED entries (isLiveSelectable); BETA/
 * UNVERIFIED providers are DEMO-only. Credentials are typed once, sent
 * through the encrypted broker-credential flow (test → create → connect),
 * and never rendered back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  BrokerConnectionView,
  BrokerOAuthAccount,
  BrokerOAuthAccountsResult,
  BrokerRegistryEntry,
  CreateBrokerConnectionRequest,
} from "@irexpro/types";
import { api } from "../lib/api";
import {
  brokerConnectionAction,
  buildConnectionRequest,
  credentialFields,
  isConnectableEntry,
  isLiveSelectable,
  keyCapabilityChips,
  routeLabel,
  statusPresentation,
  verificationLabelColor,
  verificationLabelForConnection,
  verificationLabelForEntry,
} from "./broker-screen.logic";
import {
  BROKER_OAUTH_AWAIT_TIMEOUT_MS,
  buildOAuthLinkRequest,
  isPendingBrokerOAuthContextFresh,
  oauthAccountOptions,
  parseBrokerOAuthHandoffLink,
} from "./broker-screen-oauth.logic";
import { ActionDialog, Banner, palette } from "../components/ui";
import {
  clearPendingBrokerOAuth,
  getPendingBrokerOAuth,
  savePendingBrokerOAuth,
} from "../lib/secure-storage";

const ENVIRONMENT_OPTIONS: ReadonlyArray<"DEMO" | "LIVE"> = ["DEMO", "LIVE"];

export default function BrokerScreen() {
  const [registry, setRegistry] = useState<BrokerRegistryEntry[]>([]);
  const [connections, setConnections] = useState<BrokerConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [connectTarget, setConnectTarget] =
    useState<BrokerRegistryEntry | null>(null);
  const [actionTarget, setActionTarget] = useState<BrokerConnectionView | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoredOAuth, setRestoredOAuth] = useState<{
    brokerId: string;
    result: BrokerOAuthAccountsResult;
  } | null>(null);
  const coldStartHandled = useRef(false);

  const load = useCallback(async () => {
    try {
      const [catalog, userConnections] = await Promise.all([
        api.getBrokerRegistry(),
        api.listBrokerConnections(),
      ]);
      setRegistry(catalog.brokers);
      setConnections(userConnections);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load broker data",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading || registry.length === 0 || coldStartHandled.current) return;
    let cancelled = false;

    void (async () => {
      const [initialUrl, pending] = await Promise.all([
        Linking.getInitialURL(),
        getPendingBrokerOAuth(),
      ]);
      if (cancelled || !initialUrl || !pending) return;

      const parsed = parseBrokerOAuthHandoffLink(initialUrl);
      if (!parsed) return;

      coldStartHandled.current = true;
      const contextFresh = isPendingBrokerOAuthContextFresh(pending.createdAt);
      const entry = registry.find((candidate) => candidate.id === pending.brokerId);

      if (!contextFresh || !entry || entry.authenticationType !== "OAUTH") {
        await clearPendingBrokerOAuth();
        if (!cancelled) {
          setNotice(
            "The saved broker authorization context expired or is no longer valid. Start Connect again.",
          );
        }
        return;
      }

      if ("error" in parsed) {
        await clearPendingBrokerOAuth();
        if (!cancelled) {
          setNotice(
            `Broker authorization was not completed (${parsed.error}). Start Connect again.`,
          );
        }
        return;
      }

      try {
        const result = await api.exchangeBrokerOAuthHandoff({
          handoffToken: parsed.token,
        });
        await clearPendingBrokerOAuth();
        if (cancelled) return;
        if (result.flowId !== pending.flowId) {
          setError("Broker authorization could not be matched to the saved mobile flow.");
          return;
        }
        setRestoredOAuth({ brokerId: pending.brokerId, result });
        setConnectTarget(entry);
        setNotice("Broker authorization restored after app relaunch. Choose an account to link.");
      } catch (requestError) {
        await clearPendingBrokerOAuth();
        if (!cancelled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Broker authorization could not be restored.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, registry]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const openConnectionAction = useCallback((connection: BrokerConnectionView) => {
    setActionError(null);
    setNotice(null);
    setActionTarget(connection);
  }, []);

  const closeConnectionAction = useCallback(() => {
    if (actionBusy) return;
    setActionTarget(null);
    setActionError(null);
  }, [actionBusy]);

  const confirmConnectionAction = useCallback(async () => {
    if (!actionTarget || actionBusy) return;

    const action = brokerConnectionAction(actionTarget.status);
    if (action === "WAIT") return;

    setActionBusy(true);
    setActionError(null);
    try {
      if (action === "DISCONNECT") {
        await api.disconnectBroker(actionTarget.id);
        setNotice(
          `${actionTarget.brokerName} disconnected. New AI exposure authority has been invalidated for this connection.`,
        );
      } else {
        await api.connectBroker(actionTarget.id);
        setNotice(`${actionTarget.brokerName} reconnect request completed.`);
      }

      await load();
      setActionTarget(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Broker action failed";

      try {
        const refreshed = await api.listBrokerConnections();
        setConnections(refreshed);
        const reconciled = refreshed.find(
          (connection) => connection.id === actionTarget.id,
        );

        const reconciledSuccess =
          (action === "DISCONNECT" &&
            reconciled?.status === "DISCONNECTED") ||
          (action === "RECONNECT" &&
            reconciled?.status === "CONNECTED");

        if (reconciledSuccess) {
          setActionError(null);
          setNotice(
            action === "DISCONNECT"
              ? `${actionTarget.brokerName} is confirmed disconnected.`
              : `${actionTarget.brokerName} is confirmed connected.`,
          );
          setActionTarget(null);
          return;
        }
      } catch {
        // Preserve the original action error; the user can retry/refresh.
      }

      setActionError(message);
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, actionTarget, load]);

  const actionIntent = actionTarget
    ? brokerConnectionAction(actionTarget.status)
    : null;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#14b8a6" />
        <Text style={styles.muted}>Loading broker catalog…</Text>
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
            onRefresh={onRefresh}
            tintColor="#14b8a6"
          />
        }
      >
        <Text style={styles.eyebrow}>EXECUTION CONNECTIVITY</Text>
        <Text style={styles.title}>Broker connections</Text>
        <Text style={styles.screenSubtitle}>
          Connect, verify, disconnect or reconnect broker accounts without bypassing server trading gates.
        </Text>

        {notice ? <Banner variant="success">{notice}</Banner> : null}

        {error ? (
          <View
            style={styles.errorCard}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading brokers"
              style={styles.retryButton}
              onPress={() => void load()}
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Your connections</Text>
        {connections.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.muted}>
              No broker connections yet. Pick a broker below to get started.
            </Text>
          </View>
        ) : (
          connections.map((connection) => {
            // Fixed six-label verification taxonomy (Sprint 56 round 5):
            // joined with the registry by brokerId; a missing join degrades
            // fail-closed — never a simple "Live" claim.
            const verificationLabel = verificationLabelForConnection(
              connection,
              registry.find((entry) => entry.id === connection.brokerId) ?? null,
            );
            const connectionAction = brokerConnectionAction(connection.status);
            return (
            <View
              key={connection.id}
              style={styles.card}
              accessibilityLabel={`${connection.brokerName} ${connection.accountType} connection`}
            >
              <View style={styles.cardIdentityHeader}>
                <Text style={styles.cardTitle} numberOfLines={3} ellipsizeMode="tail">
                  {connection.brokerName}
                </Text>
                <View style={styles.badgeRow}>
                  <Text
                    style={[
                      styles.envBadge,
                      connection.accountType === "LIVE"
                        ? styles.envLive
                        : styles.envDemo,
                    ]}
                  >
                    {connection.accountType}
                  </Text>
                </View>
              </View>
              <Text
                style={[
                  styles.verificationLabel,
                  { color: verificationLabelColor(verificationLabel) },
                ]}
              >
                {verificationLabel}
              </Text>
              <Text style={styles.muted}>
                {connection.accountId
                  ? `Account ${connection.accountId}`
                  : "Account pending"}
              </Text>
              {connection.logicalAccountKey ? (
                <Text style={styles.mutedSmall} numberOfLines={1} ellipsizeMode="middle">
                  Logical account {connection.logicalAccountKey}
                </Text>
              ) : null}
              <View style={styles.rowWrap}>
                <Text
                  style={[
                    styles.chip,
                    connection.status === "CONNECTED"
                      ? styles.chipPositive
                      : connection.status === "ERROR"
                        ? styles.chipDanger
                        : styles.chipNeutral,
                  ]}
                >
                  {connection.status}
                </Text>
                <Text
                  style={[
                    styles.chip,
                    connection.authorizationStatus === "ACTIVE"
                      ? styles.chipPositive
                      : styles.chipNeutral,
                  ]}
                >
                  {connection.authorizationStatus}
                </Text>
                <Text
                  style={[
                    styles.chip,
                    connection.credentialStatus === "VERIFIED"
                      ? styles.chipPositive
                      : styles.chipNeutral,
                  ]}
                >
                  {connection.credentialStatus}
                </Text>
                {connection.lastSyncAt ? (
                  <Text style={styles.mutedSmall}>
                    Synced {new Date(connection.lastSyncAt).toLocaleString()}
                  </Text>
                ) : null}
              </View>
              {connection.lastErrorMessage ? (
                <Text style={styles.errorTextSmall} numberOfLines={2}>
                  {connection.lastErrorMessage}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${connectionAction === "DISCONNECT" ? "Disconnect" : "Reconnect"} ${connection.brokerName}`}
                disabled={connectionAction === "WAIT"}
                style={[
                  connectionAction === "DISCONNECT"
                    ? styles.dangerButton
                    : styles.secondaryButton,
                  connectionAction === "WAIT" && styles.buttonDisabled,
                ]}
                onPress={() => openConnectionAction(connection)}
              >
                <Text
                  style={
                    connectionAction === "DISCONNECT"
                      ? styles.dangerButtonText
                      : styles.secondaryButtonText
                  }
                >
                  {connectionAction === "DISCONNECT"
                    ? "Disconnect"
                    : connectionAction === "WAIT"
                      ? "Connecting…"
                      : "Reconnect"}
                </Text>
              </Pressable>
            </View>
            );
          })
        )}

        <Text style={styles.sectionTitle}>Broker catalog</Text>
        {registry.map((entry) => {
          const presentation = statusPresentation(entry.status);
          const connectable = isConnectableEntry(entry);
          // Fixed taxonomy label — e.g. an UNVERIFIED BETA provider is
          // 'Production LIVE Unverified', never simply "Live".
          const verificationLabel = verificationLabelForEntry(entry);
          return (
            <View
              key={entry.id}
              style={styles.card}
              accessibilityLabel={`${entry.name}, ${presentation.label}`}
            >
              <View style={styles.cardIdentityHeader}>
                <Text style={styles.cardTitle} numberOfLines={3} ellipsizeMode="tail">
                  {entry.name}
                </Text>
                <View style={styles.badgeRow}>
                  <Text
                    style={[
                      styles.statusBadge,
                      {
                        color: presentation.color,
                        borderColor: presentation.color,
                      },
                    ]}
                    numberOfLines={2}
                    ellipsizeMode="tail"
                  >
                    {presentation.label}
                  </Text>
                </View>
              </View>
              <Text style={styles.mutedSmall} numberOfLines={3}>
                {presentation.description}
              </Text>
              <Text
                style={[
                  styles.verificationLabel,
                  { color: verificationLabelColor(verificationLabel) },
                ]}
              >
                {verificationLabel}
              </Text>
              <View style={styles.rowWrap}>
                {keyCapabilityChips(entry).map((chip) => (
                  <Text key={chip} style={styles.chip}>
                    {chip}
                  </Text>
                ))}
                {entry.connectionRoutes.map((route) => (
                  <Text key={route} style={styles.routeChip}>
                    {routeLabel(route)}
                  </Text>
                ))}
              </View>
              {connectable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Connect ${entry.name}`}
                  style={styles.primaryButton}
                  onPress={() => setConnectTarget(entry)}
                >
                  <Text style={styles.primaryButtonText}>Connect</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <ActionDialog
        visible={Boolean(actionTarget && actionIntent !== "WAIT")}
        kicker={actionIntent === "DISCONNECT" ? "BROKER SAFETY" : "BROKER CONNECTION"}
        title={
          actionIntent === "DISCONNECT"
            ? "Disconnect broker?"
            : "Reconnect broker?"
        }
        message={
          actionTarget
            ? actionIntent === "DISCONNECT"
              ? `Disconnect ${actionTarget.brokerName} ${actionTarget.accountType} account ${actionTarget.accountId ?? ""}?`
              : `Reconnect ${actionTarget.brokerName} ${actionTarget.accountType} account ${actionTarget.accountId ?? ""}?`
            : ""
        }
        detailLines={
          actionIntent === "DISCONNECT"
            ? [
                "New AI exposure authority for this connection will be invalidated.",
                "Open broker positions are not assumed closed by a broker disconnect.",
                "The saved connection remains available so you can reconnect later.",
              ]
            : [
                "The server reuses the saved encrypted credential set; secrets are never displayed in the app.",
                "Provider connectivity and authorization checks run again before the connection becomes usable.",
                "Trading remains blocked unless every current server-side gate passes.",
              ]
        }
        confirmLabel={actionIntent === "DISCONNECT" ? "Disconnect" : "Reconnect"}
        cancelLabel="Cancel"
        busy={actionBusy}
        danger={actionIntent === "DISCONNECT"}
        status={
          actionError
            ? { tone: "error", message: actionError }
            : null
        }
        onCancel={closeConnectionAction}
        onConfirm={() => void confirmConnectionAction()}
      />

      {connectTarget ? (
        <ConnectFlowModal
          entry={connectTarget}
          restoredOAuthResult={
            restoredOAuth?.brokerId === connectTarget.id ? restoredOAuth.result : null
          }
          onClose={() => {
            setConnectTarget(null);
            setRestoredOAuth(null);
          }}
          onConnected={async () => {
            setConnectTarget(null);
            setRestoredOAuth(null);
            await load();
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

/** Test → create → connect flow (§AE). Secrets are cleared after submit. */
function ConnectFlowModal({
  entry,
  restoredOAuthResult,
  onClose,
  onConnected,
}: {
  entry: BrokerRegistryEntry;
  restoredOAuthResult?: BrokerOAuthAccountsResult | null;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const isOAuthBroker = entry.authenticationType === "OAUTH";
  const fields = credentialFields(entry.authenticationType);
  // Environment truth (Phase I): options derive STRICTLY from the entry's
  // declared environments, with LIVE additionally gated by isLiveSelectable
  // (server VERIFIED production-LIVE evidence). BETA/UNVERIFIED providers
  // only ever offer DEMO here; no hard-coded broker exceptions.
  const supportedEnvs = ENVIRONMENT_OPTIONS.filter(
    (env) =>
      entry.environments.includes(env) &&
      (env !== "LIVE" || isLiveSelectable(entry)),
  );
  const [environment, setEnvironment] = useState<"DEMO" | "LIVE">(
    supportedEnvs[0] ?? "DEMO",
  );
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "create" | "connect" | null>(null);
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(
    restoredOAuthResult
      ? { ok: true, message: "Authorization restored — choose an account to link." }
      : null,
  );

  // ── cTrader OAuth flow state (Sprint 56 correction round 2 / architect
  // finding 4) — replaces the credential form for OAUTH brokers. The
  // authorization happens in the EXTERNAL system browser against a
  // SERVER-assigned HTTPS callback; the app never sees the cTrader
  // password, the authorization code, or any provider token. The server
  // returns via the deep link `irexpro://broker/oauth/handoff?token=…`
  // carrying ONLY the opaque one-time handoff token.
  const [oauthBusy, setOauthBusy] = useState<
    "start" | "complete" | "link" | null
  >(null);
  const [oauthFlowId, setOauthFlowId] = useState<string | null>(
    restoredOAuthResult?.flowId ?? null,
  );
  const [oauthAwaitingReturn, setOauthAwaitingReturn] = useState(false);
  const [oauthAccounts, setOauthAccounts] = useState<
    BrokerOAuthAccount[] | null
  >(restoredOAuthResult?.accounts ?? null);

  const closeFlow = useCallback(() => {
    if (isOAuthBroker) {
      void clearPendingBrokerOAuth();
    }
    onClose();
  }, [isOAuthBroker, onClose]);

  const handoffOAuth = useCallback(
    async (flowId: string, handoffToken: string) => {
      setOauthBusy("complete");
      setOauthAwaitingReturn(false);
      try {
        // The handoff token is self-contained (user-bound, single-use) —
        // the response carries the AUTHORITATIVE flowId used for the
        // subsequent link, plus sanitized accounts (no token material).
        const result = await api.exchangeBrokerOAuthHandoff({
          handoffToken,
        });
        await clearPendingBrokerOAuth();
        if (result.flowId !== flowId) {
          setOauthFlowId(null);
          setOauthAccounts(null);
          setFeedback({
            ok: false,
            message: "Authorization return did not match the active broker flow. Start Connect again.",
          });
          return;
        }
        setOauthFlowId(result.flowId);
        setOauthAccounts(result.accounts);
        setFeedback({
          ok: true,
          message: "Authorized — choose an account to link.",
        });
      } catch (err) {
        await clearPendingBrokerOAuth();
        // Clean the flow state for THIS attempt only — a newly started
        // authorization must not be clobbered by a stale handoff failure.
        setOauthFlowId((current) => (current === flowId ? null : current));
        setFeedback({
          ok: false,
          message:
            err instanceof Error ? err.message : "Authorization failed",
        });
      } finally {
        setOauthBusy(null);
      }
    },
    [],
  );

  // Deep-link subscription: only while awaiting the browser return. The
  // ONLY accepted completion is the server handoff redirect
  // (irexpro://broker/oauth/handoff?token=… / ?error=…). Unrelated deep
  // links are ignored (never treated as OAuth completions).
  useEffect(() => {
    if (!isOAuthBroker || !oauthAwaitingReturn || !oauthFlowId) return;
    const flowId = oauthFlowId;
    const subscription = Linking.addEventListener("url", ({ url }) => {
      const parsed = parseBrokerOAuthHandoffLink(url);
      if (!parsed) return;
      if ("token" in parsed) {
        void handoffOAuth(flowId, parsed.token);
        return;
      }
      // ?error=<reason> — the server reported failure/cancel to the app.
      setOauthAwaitingReturn(false);
      setOauthFlowId((current) => (current === flowId ? null : current));
      void clearPendingBrokerOAuth();
      setFeedback({
        ok: false,
        message: `Authorization was not completed (${parsed.error}). Tap Connect to try again.`,
      });
    });
    return () => subscription.remove();
  }, [isOAuthBroker, oauthAwaitingReturn, oauthFlowId, handoffOAuth]);

  // Watchdog: if no browser return is received within the wait window,
  // clear the awaiting state with honest feedback. No API call — the
  // server-side flow TTL governs the real expiry (fail closed there).
  useEffect(() => {
    if (!isOAuthBroker || !oauthAwaitingReturn) return;
    const timer = setTimeout(() => {
      setOauthAwaitingReturn(false);
      setOauthFlowId(null);
      void clearPendingBrokerOAuth();
      setFeedback({
        ok: false,
        message:
          "The authorization window timed out — no browser return was received.",
      });
    }, BROKER_OAUTH_AWAIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isOAuthBroker, oauthAwaitingReturn]);

  const startOAuth = useCallback(async () => {
    setFeedback(null);
    setOauthBusy("start");
    try {
      // Channel "mobile" claims a server-assigned HTTPS callback slot —
      // the app custom scheme is never the OAuth callback (finding 4).
      const start = await api.startBrokerOAuth(entry.id, {
        channel: "mobile",
      });
      await savePendingBrokerOAuth({
        brokerId: entry.id,
        flowId: start.flowId,
        createdAt: new Date().toISOString(),
      });
      setOauthFlowId(start.flowId);
      setOauthAwaitingReturn(true);
      await Linking.openURL(start.authorizationUrl);
      setFeedback({
        ok: true,
        message:
          "Complete the authorization in your browser, then return to the app.",
      });
    } catch (err) {
      await clearPendingBrokerOAuth();
      setOauthFlowId(null);
      setOauthAwaitingReturn(false);
      setFeedback({
        ok: false,
        message: err instanceof Error ? err.message : "Authorization failed",
      });
    } finally {
      setOauthBusy(null);
    }
  }, [entry.id]);

  const linkOAuthAccount = useCallback(
    async (account: BrokerOAuthAccount) => {
      if (!oauthFlowId) return;
      setOauthBusy("link");
      try {
        await api.linkBrokerOAuth(
          buildOAuthLinkRequest(oauthFlowId, account),
        );
        await clearPendingBrokerOAuth();
        setFeedback({ ok: true, message: "Account linked" });
        await onConnected();
      } catch (err) {
        setFeedback({
          ok: false,
          message: err instanceof Error ? err.message : "Linking failed",
        });
      } finally {
        setOauthBusy(null);
      }
    },
    [oauthFlowId, onConnected],
  );

  const submit = async () => {
    const requestOrError = buildConnectionRequest(
      entry,
      environment,
      accountId,
      apiKey,
    );
    if ("error" in requestOrError) {
      setFeedback({ ok: false, message: requestOrError.error });
      return;
    }
    const body: CreateBrokerConnectionRequest = {
      ...requestOrError,
      ...(fields.serverUrl && serverUrl.trim().length > 0
        ? { serverUrl: serverUrl.trim() }
        : {}),
    };
    try {
      setBusy("test");
      const testResult = await api.testBrokerCredentials(body);
      setBusy(null);
      if (!testResult.success) {
        setFeedback({
          ok: false,
          message: testResult.errorMessage ?? "Credential test failed",
        });
        return;
      }
      setFeedback({ ok: true, message: "Credentials verified" });

      setBusy("create");
      const created = await api.createBrokerConnection(body);
      setBusy(null);

      setBusy("connect");
      await api.connectBroker(created.id);
      setBusy(null);

      setApiKey("");
      setFeedback({ ok: true, message: "Connected" });
      await onConnected();
    } catch (err) {
      setBusy(null);
      setFeedback({
        ok: false,
        message: err instanceof Error ? err.message : "Connection flow failed",
      });
    }
  };

  return (
    <Modal
      visible
      animationType="slide"
      transparent={false}
      onRequestClose={closeFlow}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.title}>Connect {entry.name}</Text>

          {isOAuthBroker ? (
            /* ── cTrader OAuth connection flow (architect finding 4):
             * external consent on a SERVER-assigned HTTPS callback +
             * server-side code exchange + one-time handoff token deep link
             * + account discovery + encrypted linking. NO credential
             * inputs — and never the cTrader password, authorization code,
             * or any provider token. ── */
            <>
              <Text style={styles.sectionHint}>
                Authorize iRexPro with your cTrader ID. The consent screen
                opens in your browser — we never see your password. Your
                accounts are discovered automatically after authorization.
              </Text>

              {feedback ? (
                <Text
                  style={feedback.ok ? styles.successText : styles.errorText}
                  accessibilityLiveRegion="polite"
                >
                  {feedback.message}
                </Text>
              ) : null}

              {oauthAccounts === null ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Authorize with cTrader ID"
                    style={[
                      styles.primaryButton,
                      oauthBusy ? styles.buttonDisabled : null,
                    ]}
                    disabled={oauthBusy !== null}
                    onPress={() => void startOAuth()}
                  >
                    {oauthBusy === "start" ? (
                      <ActivityIndicator color="#ffffff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>
                        Authorize with cTrader ID
                      </Text>
                    )}
                  </Pressable>
                  {oauthBusy === "complete" ? (
                    <View style={styles.rowWrap}>
                      <ActivityIndicator size="small" />
                      <Text style={styles.mutedText}>
                        Completing authorization…
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : (
                <>
                  <Text style={styles.label}>Choose an account</Text>
                  {oauthAccountOptions(oauthAccounts).map((option) => (
                    <View
                      key={option.account.ctidTraderAccountId}
                      style={[
                        styles.accountOption,
                        option.selectable ? null : styles.accountOptionDisabled,
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.accountOptionTitle}>
                          {option.account.brokerTitleShort ?? "cTrader"} ·{" "}
                          {option.account.isLive ? "LIVE" : "DEMO"}
                        </Text>
                        <Text style={styles.mutedText}>
                          Account {option.account.ctidTraderAccountId}
                          {option.account.traderLogin !== undefined
                            ? ` · login ${option.account.traderLogin}`
                            : ""}
                        </Text>
                        {option.note ? (
                          <Text style={styles.mutedText}>{option.note}</Text>
                        ) : null}
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Link account ${option.account.ctidTraderAccountId}`}
                        style={[
                          styles.smallButton,
                          option.selectable ? null : styles.buttonDisabled,
                        ]}
                        disabled={!option.selectable || oauthBusy !== null}
                        onPress={() => void linkOAuthAccount(option.account)}
                      >
                        {oauthBusy === "link" &&
                        option.selectable ? (
                          <ActivityIndicator size="small" color="#ffffff" />
                        ) : (
                          <Text style={styles.primaryButtonText}>
                            {option.selectable ? "Link" : "N/A"}
                          </Text>
                        )}
                      </Pressable>
                    </View>
                  ))}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Start a new authorization"
                    style={styles.secondaryButton}
                    disabled={oauthBusy !== null}
                    onPress={() => {
                      setOauthAccounts(null);
                      setOauthFlowId(null);
                      setOauthAwaitingReturn(false);
                      setFeedback(null);
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>
                      Start a new authorization
                    </Text>
                  </Pressable>
                </>
              )}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel broker connection"
                style={styles.secondaryButton}
                onPress={closeFlow}
                disabled={oauthBusy !== null}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.label}>Environment</Text>
              <View style={styles.rowWrap}>
                {supportedEnvs.map((env) => (
                  <Pressable
                    key={env}
                    accessibilityRole="button"
                    accessibilityLabel={`${env} environment`}
                    style={[
                      styles.envOption,
                      environment === env && styles.envOptionActive,
                    ]}
                    onPress={() => setEnvironment(env)}
                  >
                    <Text
                      style={[
                        styles.envOptionText,
                        environment === env && styles.envOptionTextActive,
                      ]}
                    >
                      {env}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>Account ID</Text>
              <TextInput
                accessibilityLabel="Broker account ID"
                style={styles.input}
                value={accountId}
                onChangeText={setAccountId}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="e.g. 101-004-1234567-001"
              />

              {fields.apiKey ? (
                <>
                  <Text style={styles.label}>API token</Text>
                  <TextInput
                    accessibilityLabel="Broker API token"
                    style={styles.input}
                    value={apiKey}
                    onChangeText={setApiKey}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Personal access token"
                  />
                </>
              ) : null}

              {fields.serverUrl ? (
                <>
                  <Text style={styles.label}>Server URL (optional)</Text>
                  <TextInput
                    accessibilityLabel="Broker server URL"
                    style={styles.input}
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="https://"
                  />
                </>
              ) : null}

              {feedback ? (
                <Text
                  style={feedback.ok ? styles.successText : styles.errorText}
                  accessibilityLiveRegion="polite"
                >
                  {feedback.message}
                </Text>
              ) : null}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Test and connect broker"
                style={[styles.primaryButton, busy ? styles.buttonDisabled : null]}
                disabled={busy !== null}
                onPress={() => void submit()}
              >
                {busy ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Test & connect</Text>
                )}
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel broker connection"
                style={styles.secondaryButton}
                onPress={closeFlow}
                disabled={busy !== null}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.bg },
  scrollContent: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 64 },
  eyebrow: { color: palette.accent, fontSize: 9, fontWeight: "900", letterSpacing: 1.15, marginBottom: 6 },
  screenSubtitle: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: -2, marginBottom: 16 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
    backgroundColor: palette.bg,
  },
  title: {
    fontSize: 26,
    fontWeight: "900",
    color: palette.text,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: palette.text,
    marginTop: 20,
    marginBottom: 10,
  },
  card: {
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    backgroundColor: palette.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.cardBorder,
    padding: 16,
    marginBottom: 12,
    gap: 9,
  },
  cardIdentityHeader: {
    width: "100%",
    minWidth: 0,
    gap: 8,
  },
  badgeRow: {
    width: "100%",
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 6,
  },
  cardTitle: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "800",
    color: palette.text,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
    minWidth: 0,
  },
  rowWrap: {
    width: "100%",
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
  },
  muted: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  mutedSmall: { color: palette.helper, fontSize: 11, lineHeight: 17 },
  chip: {
    backgroundColor: palette.input,
    color: palette.bodySoft,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 10,
    fontWeight: "800",
    overflow: "hidden",
  },
  chipPositive: { backgroundColor: "#0d2928", color: "#5eead4" },
  chipNeutral: { backgroundColor: "#18233b", color: "#b9c3dd" },
  chipDanger: { backgroundColor: "#3b171c", color: "#fecaca" },
  routeChip: {
    backgroundColor: "#0d2928",
    color: "#5eead4",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    overflow: "hidden",
  },
  statusBadge: {
    flexShrink: 1,
    maxWidth: "48%",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "700",
    textAlign: "center",
    overflow: "hidden",
  },
  envBadge: {
    maxWidth: "100%",
    flexShrink: 1,
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "900",
    overflow: "hidden",
  },
  envDemo: { backgroundColor: "#291f0b", color: "#fde68a" },
  envLive: { backgroundColor: "#3b171c", color: "#fecaca" },
  verificationLabel: {
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
  },
  envOption: {
    borderWidth: 1,
    borderColor: palette.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
  },
  envOptionActive: { borderColor: palette.accent, backgroundColor: "#0d2928" },
  envOptionText: { color: palette.muted, fontSize: 13, fontWeight: "700" },
  envOptionTextActive: { color: "#5eead4" },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: palette.body,
    marginTop: 12,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: palette.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: palette.inputText,
    backgroundColor: palette.input,
  },
  primaryButton: {
    backgroundColor: palette.accent,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 12,
    marginTop: 16,
  },
  primaryButtonText: { color: palette.accentText, fontSize: 14, fontWeight: "900" },
  secondaryButton: {
    borderWidth: 1,
    borderColor: palette.inputBorder,
    backgroundColor: palette.secondaryButton,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 8,
  },
  secondaryButtonText: { color: palette.body, fontSize: 13, fontWeight: "800" },
  dangerButton: {
    borderWidth: 1,
    borderColor: palette.danger.border,
    backgroundColor: palette.danger.background,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 8,
  },
  dangerButtonText: { color: palette.danger.text, fontSize: 13, fontWeight: "900" },
  buttonDisabled: { opacity: 0.6 },
  // ── cTrader OAuth flow (Sprint 56 correction round 1 / audit point 6) ──
  sectionHint: { color: palette.muted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  mutedText: { color: palette.helper, fontSize: 12, marginTop: 2 },
  accountOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.cardBorder,
    borderRadius: 10,
    backgroundColor: palette.input,
    marginBottom: 8,
  },
  accountOptionDisabled: { opacity: 0.6 },
  accountOptionTitle: { fontSize: 15, fontWeight: "700", color: palette.text },
  smallButton: {
    backgroundColor: palette.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  errorCard: {
    backgroundColor: palette.error.background,
    borderColor: palette.error.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 8,
  },
  errorText: { color: palette.error.text, fontSize: 13 },
  errorTextSmall: { color: palette.errorText, fontSize: 12 },
  successText: { color: palette.success.text, fontSize: 13 },
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: palette.danger.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryButtonText: { color: palette.danger.text, fontWeight: "800", fontSize: 13 },
});
