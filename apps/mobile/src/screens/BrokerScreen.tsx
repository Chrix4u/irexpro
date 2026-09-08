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
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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
  BrokerRegistryEntry,
  CreateBrokerConnectionRequest,
} from "@irexpro/types";
import { api } from "../lib/api";
import {
  buildConnectionRequest,
  credentialFields,
  isConnectableEntry,
  isLiveSelectable,
  keyCapabilityChips,
  routeLabel,
  statusPresentation,
} from "./broker-screen.logic";

const ENVIRONMENT_OPTIONS: ReadonlyArray<"DEMO" | "LIVE"> = ["DEMO", "LIVE"];

export default function BrokerScreen() {
  const [registry, setRegistry] = useState<BrokerRegistryEntry[]>([]);
  const [connections, setConnections] = useState<BrokerConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [connectTarget, setConnectTarget] =
    useState<BrokerRegistryEntry | null>(null);

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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const disconnect = useCallback(
    (connection: BrokerConnectionView) => {
      Alert.alert(
        "Disconnect broker",
        `Disconnect ${connection.brokerName} (${connection.accountType})?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Disconnect",
            style: "destructive",
            onPress: () => {
              void (async () => {
                try {
                  await api.disconnectBroker(connection.id);
                  await load();
                } catch (err) {
                  Alert.alert(
                    "Disconnect failed",
                    err instanceof Error ? err.message : "Unknown error",
                  );
                }
              })();
            },
          },
        ],
      );
    },
    [load],
  );

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
        <Text style={styles.title}>Brokers</Text>

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
          connections.map((connection) => (
            <View
              key={connection.id}
              style={styles.card}
              accessibilityLabel={`${connection.brokerName} ${connection.accountType} connection`}
            >
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>{connection.brokerName}</Text>
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
              <Text style={styles.muted}>
                {connection.accountId
                  ? `Account ${connection.accountId}`
                  : "Account pending"}
              </Text>
              <View style={styles.rowWrap}>
                <Text style={styles.chip}>{connection.status}</Text>
                <Text style={styles.chip}>
                  {connection.authorizationStatus}
                </Text>
                <Text style={styles.chip}>{connection.credentialStatus}</Text>
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
                accessibilityLabel={`Disconnect ${connection.brokerName}`}
                style={styles.secondaryButton}
                onPress={() => disconnect(connection)}
              >
                <Text style={styles.secondaryButtonText}>Disconnect</Text>
              </Pressable>
            </View>
          ))
        )}

        <Text style={styles.sectionTitle}>Broker catalog</Text>
        {registry.map((entry) => {
          const presentation = statusPresentation(entry.status);
          const connectable = isConnectableEntry(entry);
          return (
            <View
              key={entry.id}
              style={styles.card}
              accessibilityLabel={`${entry.name}, ${presentation.label}`}
            >
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>{entry.name}</Text>
                <Text
                  style={[
                    styles.statusBadge,
                    {
                      color: presentation.color,
                      borderColor: presentation.color,
                    },
                  ]}
                >
                  {presentation.label}
                </Text>
              </View>
              <Text style={styles.mutedSmall} numberOfLines={3}>
                {presentation.description}
              </Text>
              {entry.productionLiveVerification?.status !== "VERIFIED" ? (
                <Text style={styles.liveUnavailableText}>
                  LIVE unavailable — not production-verified
                </Text>
              ) : null}
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

      {connectTarget ? (
        <ConnectFlowModal
          entry={connectTarget}
          onClose={() => setConnectTarget(null)}
          onConnected={async () => {
            setConnectTarget(null);
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
  onClose,
  onConnected,
}: {
  entry: BrokerRegistryEntry;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
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
  } | null>(null);

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
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.title}>Connect {entry.name}</Text>

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
            onPress={onClose}
            disabled={busy !== null}
          >
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
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
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 12,
  },
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
    padding: 16,
    marginBottom: 12,
    gap: 8,
  },
  cardTitle: { fontSize: 16, fontWeight: "600", color: "#0f172a" },
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
  muted: { color: "#64748b", fontSize: 14 },
  mutedSmall: { color: "#94a3b8", fontSize: 12 },
  chip: {
    backgroundColor: "#f1f5f9",
    color: "#475569",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    overflow: "hidden",
  },
  routeChip: {
    backgroundColor: "#ecfdf5",
    color: "#047857",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    overflow: "hidden",
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
  },
  envBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "700",
    overflow: "hidden",
  },
  envDemo: { backgroundColor: "#fef3c7", color: "#92400e" },
  envLive: { backgroundColor: "#ffe4e6", color: "#9f1239" },
  liveUnavailableText: {
    color: "#b45309",
    fontSize: 12,
  },
  envOption: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
  },
  envOptionActive: { borderColor: "#0d9488", backgroundColor: "#ccfbf1" },
  envOptionText: { color: "#475569", fontSize: 13, fontWeight: "600" },
  envOptionTextActive: { color: "#134e4a" },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#334155",
    marginTop: 12,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#0f172a",
    backgroundColor: "#ffffff",
  },
  primaryButton: {
    backgroundColor: "#0d9488",
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 12,
    marginTop: 16,
  },
  primaryButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "700" },
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 8,
  },
  secondaryButtonText: { color: "#334155", fontSize: 14, fontWeight: "600" },
  buttonDisabled: { opacity: 0.6 },
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
  errorTextSmall: { color: "#b91c1c", fontSize: 12 },
  successText: { color: "#047857", fontSize: 13 },
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryButtonText: { color: "#b91c1c", fontWeight: "600", fontSize: 13 },
});
