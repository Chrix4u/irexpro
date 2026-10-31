'use client';

import { useState, FormEvent, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { DashboardShell, Card, Button, Input, Alert, Badge, EmptyState } from '@/components/ui';
import { ConfirmDialog } from '@/components/notifications/ConfirmDialog';
import { useNotification } from '@/hooks/useNotification';
import { mapApiError } from '@/lib/error-mapping';
import { api } from '@/lib/api';
import { IREXPRO_BROKER_OAUTH_FLOW_KEY } from '@/lib/broker-oauth-flow';
import { deriveProviderCertificationState, formatEnumLabel, isBrokerConnectionRuntimeReady } from '@irexpro/types';
import { connectionVerificationLabel } from '@/lib/trader-session';
import type {
  SupportedBroker,
  BrokerConnectionView,
  BrokerTestResult,
  BrokerRegistryEntry,
  DirectMt5PairingView,
  DirectMt5ConnectionHealthView,
} from '@irexpro/types';

/**
 * Onboarding step 3: Broker connection.
 *
 * Lists supported brokers (Paper Broker recommended first). Lets the user:
 *   - Enter credentials
 *   - Test credentials (POST /broker/connections/test — no persistence)
 *   - Create connection (POST /broker/connections — encrypts + saves)
 *   - Connect/disconnect existing connections
 *
 * Credentials are NEVER shown after save. The backend response DTO excludes
 * all credential fields.
 *
 * UX-4: Premium visual redesign — mini-card connection rows, premium empty
 * state, security alert, and sectioned new-connection form. Business logic,
 * API calls, ConfirmDialog, and notifications unchanged.
 */
type BrokerAction =
  | 'testing'
  | 'saving'
  | 'pairing'
  | 'refreshing-mt5'
  | 'revoking-mt5'
  | 'connecting'
  | 'disconnecting'
  | 'deleting';

type Mt5ConnectionMethod = 'DIRECT' | 'METAAPI';
type DirectMt5Environment = 'DEMO' | 'LIVE';
type DirectMt5BridgeSetup = 'READY' | 'NEED_WINDOWS';

const DIRECT_MT5_WINDOWS_INSTALLER_URL =
  'https://github.com/Chrix4u/irexpro/releases/download/mt5-connector-v0.2.0/iRexPro-MT5-Connector-Setup.exe';

/** Connectable statuses per the registry's status-honesty rules (§AB). */
const REGISTRY_CONNECTABLE_STATUSES: readonly string[] = ['SUPPORTED', 'BETA'];

export default function OnboardingBrokerPage() {
  const router = useRouter();
  const { user, logout, restoring } = useAuth();
  const userId = user?.id;
  const notify = useNotification();
  const [action, setAction] = useState<BrokerAction | null>(null);
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(null);
  const loading = action !== null;
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
    tone: 'danger' | 'warning';
  }>({
    open: false,
    title: '',
    description: '',
    confirmLabel: '',
    onConfirm: () => {},
    tone: 'danger',
  });

  const [supportedBrokers, setSupportedBrokers] = useState<SupportedBroker[]>([]);
  const [registryEntries, setRegistryEntries] = useState<BrokerRegistryEntry[]>([]);
  const [connections, setConnections] = useState<BrokerConnectionView[]>([]);

  const [selectedBrokerId, setSelectedBrokerId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [testResult, setTestResult] = useState<BrokerTestResult | null>(null);
  const [mt5ConnectionMethod, setMt5ConnectionMethod] = useState<Mt5ConnectionMethod>('DIRECT');
  const [directMt5Environment, setDirectMt5Environment] = useState<DirectMt5Environment>('DEMO');
  const [directMt5BridgeSetup, setDirectMt5BridgeSetup] = useState<DirectMt5BridgeSetup>('READY');
  const [directMt5ConnectionId, setDirectMt5ConnectionId] = useState<string | null>(null);
  const [directMt5Pairing, setDirectMt5Pairing] = useState<DirectMt5PairingView | null>(null);
  const [directMt5Health, setDirectMt5Health] = useState<DirectMt5ConnectionHealthView | null>(null);

  useEffect(() => {
    if (restoring || !userId) return;

    let cancelled = false;
    (async () => {
      try {
        const [brokers, conns, registry] = await Promise.all([
          api.listSupportedBrokers(),
          api.listBrokerConnections(),
          // Directive §AU — the server-authoritative catalog drives the
          // connection model (OAuth vs credentials) and alias availability.
          api.listBrokerRegistry().catch(() => null),
        ]);
        if (cancelled) return;
        setSupportedBrokers(brokers);
        setConnections(conns);
        if (registry) {
          setRegistryEntries(registry.brokers);
          const selectable = registry.brokers.filter((e) => e.adapterAvailable);
          if (selectable.length > 0) setSelectedBrokerId(selectable[0].id);
        } else if (brokers.length > 0) {
          setSelectedBrokerId(brokers[0].brokerId);
        }
      } catch (err) {
        if (!cancelled) {
          const message = mapApiError(err).message;
          setError(message);
          notify.error(message);
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [notify, restoring, userId]);

  useEffect(() => {
    if (!user || !directMt5ConnectionId) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const health = await api.getDirectMt5ConnectionHealth(directMt5ConnectionId);
        if (!cancelled) setDirectMt5Health(health);
      } catch {
        // Polling is best-effort. Explicit refresh/pair/revoke actions surface
        // their own errors; a transient poll failure must not invent health.
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [directMt5ConnectionId, user]);

  if (restoring) {
    return <div style={{ padding: '3rem' }}><p className="muted">Restoring session…</p></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '600px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">You need to log in to complete your onboarding.</p>
          <Link href="/login" className="btn btn--primary mt-4" style={{ display: 'inline-block' }}>Go to login</Link>
        </Card>
      </div>
    );
  }

  if (fetching) {
    return (
      <DashboardShell user={user} onLogout={logout} activeRoute="/onboarding/broker">
        <Card title="Broker connection"><p className="muted">Loading broker data…</p></Card>
      </DashboardShell>
    );
  }

  const activeConnection = connections.find((c) => c.status === 'CONNECTED');

  function revealConnection(connectionId: string) {
    // React must first paint the refreshed connection list. Two animation frames
    // make the hand-off deterministic without a timeout or stale DOM guess.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const connectButton = document.getElementById(`broker-connect-${connectionId}`);
        const connectionCard = document.getElementById(`broker-connection-${connectionId}`);
        const target = connectButton ?? connectionCard;
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (connectButton instanceof HTMLElement) {
          connectButton.focus({ preventScroll: true });
        }
      });
    });
  }

  async function handleTest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setTestResult(null);
    if (!selectedBrokerId || !accountId) {
      const message = 'Please select a broker and enter your account ID.';
      setError(message);
      notify.warning(message);
      return;
    }
    setAction('testing');
    notify.info('Testing broker credentials...');
    try {
      const result = await api.testBrokerCredentials({
        brokerId: selectedBrokerId,
        accountType: 'DEMO',
        accountId,
        apiKey: apiKey || undefined,
        apiSecret: apiSecret || undefined,
      });
      setTestResult(result);
      if (result.success) {
        setError(null);
        notify.success('Broker connection test passed.');
      } else {
        const message = result.errorMessage
          ? `Broker connection test failed: ${result.errorMessage}`
          : 'The broker connection test failed. Please check your credentials.';
        setError(message);
        notify.error(message);
      }
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selectedBrokerId || !accountId) {
      const message = 'Please select a broker and enter your account ID.';
      setError(message);
      notify.warning(message);
      return;
    }
    setAction('saving');
    try {
      const created = await api.createBrokerConnection({
        brokerId: selectedBrokerId,
        accountType: 'DEMO',
        accountId,
        apiKey: apiKey || undefined,
        apiSecret: apiSecret || undefined,
        displayName: displayName || undefined,
      });
      // Clear credential fields — never show them again after save.
      setApiKey('');
      setApiSecret('');
      setTestResult(null);
      // Refresh first so the exact saved connection and Connect button exist in
      // the DOM before moving the user to the next step.
      const conns = await api.listBrokerConnections();
      setConnections(conns);
      setError(null);
      notify.success(`Broker connection saved. Next: connect ${created.brokerName}.`);
      revealConnection(created.id);
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
    }
  }

  async function refreshDirectMt5Health(connectionId = directMt5ConnectionId) {
    if (!connectionId) return;
    setAction('refreshing-mt5');
    try {
      const health = await api.getDirectMt5ConnectionHealth(connectionId);
      setDirectMt5Health(health);
      setError(null);
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
    }
  }

  async function handleDirectMt5Pairing(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d+$/.test(accountId.trim())) {
      const message = 'Enter the numeric MT5 account login shown in your terminal.';
      setError(message);
      notify.warning(message);
      return;
    }

    setAction('pairing');
    try {
      const directEntry = registryEntries.find((entry) => entry.id === 'direct-mt5') ?? null;
      const certificationState =
        directEntry?.certificationState ?? deriveProviderCertificationState(directEntry?.productionLiveVerification);
      if (directMt5Environment === 'LIVE' && certificationState !== 'CERTIFIED') {
        const message =
          'Direct MT5 LIVE certification is still pending. LIVE pairing remains locked until current certification evidence is approved.';
        setError(message);
        notify.warning(message);
        return;
      }
      const created = await api.createBrokerConnection({
        brokerId: 'direct-mt5',
        accountType: directMt5Environment,
        accountId: accountId.trim(),
        displayName: displayName.trim() || undefined,
      });
      const pairing = await api.createDirectMt5Pairing(created.id);
      setDirectMt5ConnectionId(created.id);
      setDirectMt5Pairing(pairing);
      setDirectMt5Health(null);
      setApiKey('');
      setApiSecret('');
      setTestResult(null);
      setConnections(await api.listBrokerConnections());
      notify.success('Direct MT5 pairing code created. Enter it in the iRexPro MT5 Connector.');
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
    }
  }

  async function handleRegenerateDirectMt5Pairing() {
    if (!directMt5ConnectionId) return;
    setAction('pairing');
    try {
      const pairing = await api.createDirectMt5Pairing(directMt5ConnectionId);
      setDirectMt5Pairing(pairing);
      setDirectMt5Health(null);
      setError(null);
      notify.success('A new Direct MT5 pairing code was created.');
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
    }
  }

  async function handleRevokeDirectMt5() {
    if (!directMt5ConnectionId) return;
    setAction('revoking-mt5');
    try {
      await api.revokeDirectMt5Connector(directMt5ConnectionId);
      setDirectMt5Pairing(null);
      setDirectMt5Health(await api.getDirectMt5ConnectionHealth(directMt5ConnectionId));
      setError(null);
      notify.success('Direct MT5 connector revoked.');
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
    }
  }

  async function handleConnect(connectionId: string) {
    setError(null);
    setAction('connecting');
    setPendingConnectionId(connectionId);
    try {
      await api.connectBroker(connectionId);
      const conns = await api.listBrokerConnections();
      setConnections(conns);
      setError(null);
      notify.success('Broker connected.');
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
      setPendingConnectionId(null);
    }
  }

  function openDisconnectDialog(connectionId: string) {
    setConfirmDialog({
      open: true,
      title: 'Disconnect broker?',
      description:
        'Automated trading will remain unavailable until a broker is reconnected.',
      confirmLabel: 'Disconnect',
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, open: false }));
        void handleDisconnect(connectionId);
      },
      tone: 'danger',
    });
  }

  function openDeleteDialog(connectionId: string) {
    setConfirmDialog({
      open: true,
      title: 'Delete broker connection?',
      description:
        'This will permanently remove the broker connection. This action cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, open: false }));
        void handleDelete(connectionId);
      },
      tone: 'danger',
    });
  }

  async function handleDisconnect(connectionId: string) {
    setError(null);
    setAction('disconnecting');
    setPendingConnectionId(connectionId);
    try {
      await api.disconnectBroker(connectionId);
      const conns = await api.listBrokerConnections();
      setConnections(conns);
      setError(null);
      notify.success('Broker disconnected.');
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
      setPendingConnectionId(null);
    }
  }

  async function handleDelete(connectionId: string) {
    setError(null);
    setAction('deleting');
    setPendingConnectionId(connectionId);
    try {
      await api.request<void>(`/broker/connections/${connectionId}`, { method: 'DELETE' });
      const conns = await api.listBrokerConnections();
      setConnections(conns);
      setError(null);
      notify.success('Broker connection deleted.');
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
    } finally {
      setAction(null);
      setPendingConnectionId(null);
    }
  }

  /**
   * cTrader-family OAuth connection flow (Sprint 56 correction — audit
   * point 6): start the server-side flow, keep the flowId locally for the
   * external-browser round trip, then redirect the user to the official
   * id.ctrader.com consent screen. iRexPro never sees cTrader passwords —
   * only the OAuth authorization code comes back via the registered
   * redirect (handled on /onboarding/broker/callback).
   */
  async function handleAuthorizeOAuth() {
    setError(null);
    if (!selectedBrokerId) return;
    setAction('saving');
    try {
      const start = await api.startBrokerOAuth(selectedBrokerId);
      sessionStorage.setItem(IREXPRO_BROKER_OAUTH_FLOW_KEY, start.flowId);
      window.location.assign(start.authorizationUrl);
    } catch (err) {
      const message = mapApiError(err).message;
      setError(message);
      notify.error(message);
      setAction(null);
    }
  }

  function statusVariant(status: BrokerConnectionView['status']): 'success' | 'error' | 'warning' | 'info' {
    if (status === 'CONNECTED') return 'success';
    if (status === 'ERROR') return 'error';
    if (status === 'DISCONNECTED') return 'warning';
    return 'info';
  }

  /**
   * Verification label from the fixed six-label taxonomy, joined with the
   * server registry by brokerId. A missing entry degrades fail-closed — an
   * UNVERIFIED BETA provider is NEVER labeled simply "Live".
   */
  function connectionLabelVariant(
    label: ReturnType<typeof connectionVerificationLabel>['label'],
  ): 'success' | 'error' | 'warning' | 'info' {
    if (label === 'Production LIVE Verified') return 'success';
    if (label === 'Production LIVE Unverified' || label === 'execution disabled') return 'error';
    return 'warning';
  }

  // Server-authoritative connection model (Directive §AU): the registry
  // decides OAuth vs credentials. Fallback to the summary list when the
  // registry is unreachable (offline-tolerant, same as before).
  const selectedRegistryEntry = registryEntries.find((e) => e.id === selectedBrokerId);
  const directMt5RegistryEntry = registryEntries.find((e) => e.id === 'direct-mt5') ?? null;
  const directMt5CertificationState =
    directMt5RegistryEntry?.certificationState ??
    deriveProviderCertificationState(directMt5RegistryEntry?.productionLiveVerification);
  const directMt5LiveCertified =
    directMt5RegistryEntry?.adapterAvailable === true &&
    directMt5RegistryEntry.environments.includes('LIVE') &&
    directMt5CertificationState === 'CERTIFIED';
  const selectedIsOAuth = selectedRegistryEntry?.authenticationType === 'OAUTH';
  const selectedIsMt5 = selectedBrokerId === 'metatrader5';
  const selectedIsDirectMt5 = selectedBrokerId === 'direct-mt5' || (selectedIsMt5 && mt5ConnectionMethod === 'DIRECT');
  const selectedConnectionReadiness = selectedRegistryEntry?.connectionReadiness;
  const selectedConnectionReady = isBrokerConnectionRuntimeReady(selectedRegistryEntry);

  function switchToDirectMt5() {
    setMt5ConnectionMethod('DIRECT');
    if (registryEntries.some((entry) => entry.id === 'direct-mt5' && entry.adapterAvailable)) {
      setSelectedBrokerId('direct-mt5');
    }
    setDirectMt5Environment('DEMO');
    setDirectMt5ConnectionId(null);
    setDirectMt5Pairing(null);
    setDirectMt5Health(null);
    setTestResult(null);
  }

  function switchToMetaApi() {
    setMt5ConnectionMethod('METAAPI');
    if (registryEntries.some((entry) => entry.id === 'metatrader5' && entry.adapterAvailable)) {
      setSelectedBrokerId('metatrader5');
    }
    setDirectMt5ConnectionId(null);
    setDirectMt5Pairing(null);
    setDirectMt5Health(null);
    setTestResult(null);
  }

  function registryEntryForConnection(connection: BrokerConnectionView): BrokerRegistryEntry | null {
    return registryEntries.find((entry) => entry.id === connection.brokerId) ?? null;
  }

  function connectionRuntimeReady(connection: BrokerConnectionView): boolean {
    return isBrokerConnectionRuntimeReady(registryEntryForConnection(connection));
  }

  function connectionRuntimeMessage(connection: BrokerConnectionView): string | null {
    return registryEntryForConnection(connection)?.connectionReadiness?.message ?? null;
  }
  function directMt5UiState(): string {
    if (!directMt5ConnectionId) return 'NOT_CREATED';
    if (!directMt5Health) return directMt5Pairing ? 'PAIRING' : 'CONNECTED_NOT_READY';
    if (directMt5Health.executionReady) return 'READY';
    if (directMt5Health.reason === 'HEARTBEAT_STALE') return 'STALE';
    if (directMt5Health.reason === 'TRADING_DISABLED') return 'TRADING_DISABLED';
    if (directMt5Health.state === 'SUSPENDED') return 'SUSPENDED';
    if (directMt5Health.state === 'REVOKED') return 'REVOKED';
    if (directMt5Health.state === 'PAIRING') return 'PAIRING';
    return 'CONNECTED_NOT_READY';
  }

  const selectableEntries = registryEntries.filter(
    (e) =>
      e.adapterAvailable &&
      REGISTRY_CONNECTABLE_STATUSES.includes(e.status) &&
      e.environments.includes('DEMO'),
  );

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/onboarding/broker">
      <main className="workspace-page broker-onboarding-page" data-testid="broker-onboarding-workspace">
      {/* Premium page header — secure, enterprise-grade tone */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <Badge variant="info">Step 3 of 3</Badge>
        </div>
        <h1 style={{ marginBottom: 'var(--space-2)' }}>Broker connection</h1>
        <p className="muted" style={{ maxWidth: '640px', lineHeight: 1.6 }}>
          Securely link your broker account to enable trading. Credentials are encrypted
          with AES-256-GCM before storage and are never returned in API responses or logs.
        </p>
      </div>

      {activeConnection && (
        <Alert variant="success">
          <div className="broker-complete-alert">
            <div>
              ✅ A broker is connected ({activeConnection.brokerName}). Onboarding is complete!
            </div>
            <div className="broker-complete-alert__action">
              <Button variant="secondary" size="sm" onClick={() => router.push('/dashboard')}>
                Go to dashboard
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      {/* ── Existing connections ──────────────────────────────────────────── */}
      <Card>
        <h2 className="card__title">Existing connections</h2>
        <p className="card__subtitle">
          Manage your linked broker accounts. Disconnect a connection before deleting it.
        </p>

        {connections.length === 0 ? (
          <EmptyState
            icon="🔌"
            title="No broker connections yet"
            description="Create your first broker connection below — Paper Broker is recommended for testing."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {connections.map((conn) => (
              <div
                id={`broker-connection-${conn.id}`}
                key={conn.id}
                style={{
                  padding: 'var(--space-4)',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-tint)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  transition: 'border-color var(--transition-fast), background var(--transition-fast)',
                }}
              >
                <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      marginBottom: 'var(--space-1)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong style={{ fontSize: '0.95rem', color: 'var(--text)' }}>{conn.brokerName}</strong>
                    {conn.displayName && <span className="muted text-sm">— {conn.displayName}</span>}
                    <Badge variant={statusVariant(conn.status)}>{formatEnumLabel(conn.status)}</Badge>
                    {(() => {
                      // Fixed-taxonomy verification label (Sprint 56 round 5);
                      // the live-trading flag is NOT the current trading state.
                      const verification = connectionVerificationLabel(
                        {
                          accountType: conn.accountType,
                          authorizationStatus: conn.authorizationStatus,
                          providerBrokerIdentity: conn.providerBrokerIdentity ?? null,
                          logicalAccountKey: conn.logicalAccountKey ?? null,
                        },
                        registryEntries.find((entry) => entry.id === conn.brokerId) ?? null,
                      );
                      return (
                        <Badge variant={connectionLabelVariant(verification.label)}>
                          {verification.label}
                        </Badge>
                      );
                    })()}
                  </div>
                  <div
                    className="text-sm muted"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', wordBreak: 'break-all' }}
                  >
                    Account: {conn.accountId ?? '(not set)'}
                  </div>
                  {conn.logicalAccountKey && (
                    <div className="text-sm muted" style={{ fontSize: '0.8rem' }}>
                      Logical account key: {conn.logicalAccountKey}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
                    <Badge variant={conn.authorizationStatus === 'ACTIVE' ? 'success' : 'info'}>
                      Auth: {formatEnumLabel(conn.authorizationStatus)}
                    </Badge>
                    <Badge variant={conn.credentialStatus === 'VERIFIED' ? 'success' : 'warning'}>
                      Credential: {formatEnumLabel(conn.credentialStatus)}
                    </Badge>
                  </div>
                  {!connectionRuntimeReady(conn) && (
                    <div className="text-sm" style={{ color: 'var(--warning)', marginTop: 'var(--space-2)' }}>
                      {connectionRuntimeMessage(conn) ?? 'Broker reconnection is awaiting platform configuration.'}
                    </div>
                  )}
                  {conn.lastErrorMessage && (
                    <div className="text-sm" style={{ color: 'var(--error)', marginTop: 'var(--space-2)' }}>
                      Last error: {conn.lastErrorMessage}
                    </div>
                  )}
                  {conn.lastHealthCheckAt && (
                    <div className="text-sm muted" style={{ marginTop: 'var(--space-1)' }}>
                      Last health check: {new Date(conn.lastHealthCheckAt).toLocaleString()}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {conn.status === 'CONNECTED' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openDisconnectDialog(conn.id)}
                      disabled={loading}
                      loading={action === 'disconnecting' && pendingConnectionId === conn.id}
                    >
                      {action === 'disconnecting' && pendingConnectionId === conn.id ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  ) : (
                    <Button
                      id={`broker-connect-${conn.id}`}
                      variant="primary"
                      size="sm"
                      onClick={() => handleConnect(conn.id)}
                      disabled={loading || !connectionRuntimeReady(conn)}
                      loading={action === 'connecting' && pendingConnectionId === conn.id}
                    >
                      {!connectionRuntimeReady(conn)
                        ? 'Platform setup required'
                        : action === 'connecting' && pendingConnectionId === conn.id
                          ? 'Connecting…'
                          : 'Connect'}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openDeleteDialog(conn.id)}
                    disabled={loading}
                    loading={action === 'deleting' && pendingConnectionId === conn.id}
                  >
                    {action === 'deleting' && pendingConnectionId === conn.id ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Connect a new broker ──────────────────────────────────────────── */}
      <Card>
        <h2 className="card__title">Connect a new broker</h2>
        <p className="card__subtitle">
          Paper Broker is recommended for your first connection — it is simulated and safest.
        </p>

        <form onSubmit={selectedIsDirectMt5 ? handleDirectMt5Pairing : handleCreate} className="onboarding-form">
          <div className="input-group">
            <label className="input-label" htmlFor="broker-select">Broker</label>
            <select
              id="broker-select"
              className="input"
              value={selectedBrokerId}
              onChange={(e) => {
                setSelectedBrokerId(e.target.value);
                setMt5ConnectionMethod('DIRECT');
                setDirectMt5Environment('DEMO');
                setDirectMt5ConnectionId(null);
                setDirectMt5Pairing(null);
                setDirectMt5Health(null);
                setTestResult(null);
              }}
              disabled={loading}
            >
              {selectableEntries.length > 0
                ? selectableEntries.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                      {e.status === 'BETA' ? ' (Beta)' : ''}
                      {!isBrokerConnectionRuntimeReady(e) ? ' — Setup required' : ''}
                    </option>
                  ))
                : supportedBrokers.map((b) => (
                    <option key={b.brokerId} value={b.brokerId}>{b.brokerName}</option>
                  ))}
            </select>
            <p className="helper-text">
              {selectedIsOAuth
                ? 'cTrader-family brokers connect through OAuth authorization — no API keys to paste.'
                : selectedIsDirectMt5
                  ? 'Direct MT5 is recommended: pair an already logged-in Windows MT5 terminal without sharing its password.'
                  : selectedIsMt5
                    ? 'Choose Direct Connector for the subscription-free native route or MetaApi for the optional hosted route.'
                    : 'Paper Broker requires no API credentials — just an account ID.'}
            </p>
          </div>

          {selectedIsOAuth ? (
            /* ── cTrader OAuth connection flow (Sprint 56 correction — audit
             * point 6): external consent, server-side code exchange, account
             * discovery + linking. No cTrader password is ever captured. ── */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <Alert variant="info">
                <span style={{ flex: 1 }}>
                  🔐 You will be redirected to the official cTrader ID consent screen to
                  authorize iRexPro. We never see your cTrader password — the connection is
                  authorized with a one-time code, and your trading accounts are discovered
                  automatically. Tokens are encrypted (AES-256-GCM) on our servers.
                </span>
              </Alert>
              {selectedRegistryEntry?.status === 'BETA' && (
                <Alert variant="warning">
                  <span style={{ flex: 1 }}>
                    Beta integration — platform compatibility is contract-tested; production-LIVE
                    verification is pending operator evidence (DEMO accounts only for now).
                  </span>
                </Alert>
              )}
              {!selectedConnectionReady && (
                <Alert variant="warning">
                  <span style={{ flex: 1 }}>
                    {selectedConnectionReadiness?.message ??
                      'Broker authorization is awaiting platform configuration.'}
                  </span>
                </Alert>
              )}
              <Button
                type="button"
                variant="primary"
                onClick={handleAuthorizeOAuth}
                disabled={loading || !selectedConnectionReady}
                loading={action === 'saving'}
              >
                {action === 'saving'
                  ? 'Starting authorization…'
                  : selectedConnectionReady
                    ? 'Authorize with cTrader ID'
                    : 'cTrader authorization unavailable'}
              </Button>
            </div>
          ) : selectedIsDirectMt5 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <div>
                <div className="input-label" style={{ marginBottom: 'var(--space-2)' }}>Connection method</div>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <Button type="button" variant="primary" onClick={switchToDirectMt5}>
                    Direct Connector (recommended)
                  </Button>
                  <Button type="button" variant="secondary" onClick={switchToMetaApi}>
                    MT5 via MetaApi (optional)
                  </Button>
                </div>
              </div>

              <Alert variant="info">
                <span style={{ flex: 1 }}>
                  <strong>Connect from any device.</strong> Set up and control iRexPro from your phone or web portal.
                  The Windows PC or VPS is only the MT5 execution bridge, so you do not need to sit at that machine to manage trading.
                </span>
              </Alert>

              <div>
                <div className="input-label" style={{ marginBottom: 'var(--space-2)' }}>Where will MetaTrader 5 run?</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--space-2)' }}>
                  <Button
                    type="button"
                    variant={directMt5BridgeSetup === 'READY' ? 'primary' : 'secondary'}
                    aria-pressed={directMt5BridgeSetup === 'READY'}
                    onClick={() => setDirectMt5BridgeSetup('READY')}
                  >
                    I already have MT5 running on Windows
                  </Button>
                  <Button
                    type="button"
                    variant={directMt5BridgeSetup === 'NEED_WINDOWS' ? 'primary' : 'secondary'}
                    aria-pressed={directMt5BridgeSetup === 'NEED_WINDOWS'}
                    onClick={() => setDirectMt5BridgeSetup('NEED_WINDOWS')}
                  >
                    I need a Windows PC/VPS for MT5
                  </Button>
                </div>
              </div>

              {directMt5BridgeSetup === 'NEED_WINDOWS' ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-4)',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-tint)',
                  }}
                >
                  <strong>Set up the MT5 execution bridge</strong>
                  <p className="helper-text" style={{ margin: 0 }}>
                    Use a Windows 10/11 PC or Windows VPS that you control. This machine hosts the MT5 desktop terminal only;
                    your normal iRexPro controls remain on your phone or web browser.
                  </p>
                  <ol className="text-sm" style={{ margin: 0, paddingLeft: '1.25rem', lineHeight: 1.8 }}>
                    <li>Install your broker&apos;s MetaTrader 5 desktop terminal and log into the account you want iRexPro to use.</li>
                    <li>Enable automated/algo trading in MT5 and keep that Windows machine or VPS online whenever Direct MT5 trading is active.</li>
                    <li>Install the iRexPro Direct MT5 Connector on the same Windows machine.</li>
                    <li>Return here, choose “I already have MT5 running on Windows”, then create the pairing code.</li>
                  </ol>
                  <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                    <Link
                      href={DIRECT_MT5_WINDOWS_INSTALLER_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm"
                    >
                      Download Windows connector
                    </Link>
                    <span className="helper-text">A Windows VPS is optional; a Windows PC that stays online also works.</span>
                  </div>
                </div>
              ) : (
                <>
                  <Alert variant="info">
                    <span style={{ flex: 1 }}>
                      🔐 Direct MT5 runs beside the MT5 terminal already logged in on your Windows PC or VPS.
                      We never ask for your MT5 password, investor password, API key, or broker secret.
                    </span>
                  </Alert>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    <Link
                      href={DIRECT_MT5_WINDOWS_INSTALLER_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm"
                    >
                      Download Windows connector
                    </Link>
                    <p className="helper-text" style={{ margin: 0 }}>
                      Install Direct MT5 protocol v2 on the same Windows PC or VPS as MetaTrader 5.
                      If you used an earlier connector, install this version and generate a new pairing code to re-pair.
                    </p>
                  </div>

                  <div className="input-group">
                <label className="input-label" htmlFor="direct-mt5-environment">MT5 environment</label>
                <select
                  id="direct-mt5-environment"
                  className="input"
                  value={directMt5Environment}
                  onChange={(event) => setDirectMt5Environment(event.target.value as DirectMt5Environment)}
                  disabled={loading || Boolean(directMt5ConnectionId)}
                >
                  <option value="DEMO">DEMO — available</option>
                  <option value="LIVE" disabled={!directMt5LiveCertified}>
                    LIVE — {directMt5LiveCertified ? 'certified' : 'certification pending'}
                  </option>
                </select>
              </div>

              {!directMt5LiveCertified ? (
                <Alert variant="warning">
                  <span style={{ flex: 1 }}>
                    LIVE certification pending — native LIVE capability is implemented, but new LIVE connections remain
                    locked until the real-money canary produces current CERTIFIED evidence. DEMO remains available now.
                  </span>
                </Alert>
              ) : (
                <Alert variant="success">
                  <span style={{ flex: 1 }}>
                    Direct MT5 LIVE is currently certified by server-side evidence. LIVE pairing is available,
                    but trading still remains subject to account authorization and risk controls.
                  </span>
                </Alert>
              )}

              {!directMt5ConnectionId ? (
                <div className="onboarding-form">
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)' }}>
                    <Input
                      label="MT5 account login"
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                      disabled={loading}
                      placeholder="e.g. 113392789"
                      inputMode="numeric"
                      required
                    />
                    <Input
                      label="Display name (optional)"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      disabled={loading}
                      placeholder={directMt5Environment === 'LIVE' ? 'My MT5 live' : 'My MT5 demo'}
                    />
                  </div>
                  <p className="helper-text">
                    Use the exact numeric login shown inside MT5. Pairing fails closed if the connector sees a different account.
                  </p>
                  <Button type="submit" variant="primary" disabled={loading} loading={action === 'pairing'}>
                    {action === 'pairing'
                      ? 'Creating pairing…'
                      : `Create ${directMt5Environment} connection & pairing code`}
                  </Button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <strong>Direct MT5 status</strong>
                    <Badge variant={directMt5Health?.executionReady ? 'success' : 'warning'}>
                      {formatEnumLabel(directMt5UiState())}
                    </Badge>
                  </div>

                  {directMt5Pairing && (
                    <div style={{ padding: 'var(--space-4)', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-md)', background: 'var(--surface-tint)' }}>
                      <div className="text-sm muted">Pairing code</div>
                      <code data-testid="direct-mt5-pairing-code" style={{ display: 'block', fontSize: '1.8rem', fontWeight: 700, letterSpacing: '0.16em', margin: 'var(--space-2) 0' }}>
                        {directMt5Pairing.pairingCode}
                      </code>
                      <div className="text-sm muted">Expires {new Date(directMt5Pairing.expiresAt).toLocaleString()}</div>
                    </div>
                  )}

                  <ol className="text-sm" style={{ margin: 0, paddingLeft: '1.25rem', lineHeight: 1.8 }}>
                    <li>Keep MetaTrader 5 open and logged into the {directMt5Environment} account {accountId} on Windows.</li>
                    <li>Run the iRexPro MT5 Connector on that same Windows PC or VPS.</li>
                    <li>Enter the pairing code above. The connector reads the MT5 login and broker server locally.</li>
                    <li>Wait for this page to show Ready. Pairing alone never enables LIVE trading.</li>
                  </ol>

                  {directMt5Health && (
                    <div className="text-sm" style={{ lineHeight: 1.7 }}>
                      <div>Connector: <strong>{formatEnumLabel(directMt5Health.state)}</strong></div>
                      <div>Reason: {formatEnumLabel(directMt5Health.reason)}</div>
                      {directMt5Health.accountLogin && <div>MT5 login: {directMt5Health.accountLogin}</div>}
                      {directMt5Health.brokerServer && <div>Broker server: {directMt5Health.brokerServer}</div>}
                      {directMt5Health.lastHeartbeatAt && (
                        <div>Last heartbeat: {new Date(directMt5Health.lastHeartbeatAt).toLocaleString()}</div>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <Button type="button" variant="secondary" onClick={() => void refreshDirectMt5Health()} disabled={loading}>
                      {action === 'refreshing-mt5' ? 'Refreshing…' : 'Refresh status'}
                    </Button>
                    {!directMt5Health?.executionReady && (
                      <Button type="button" variant="secondary" onClick={() => void handleRegenerateDirectMt5Pairing()} disabled={loading}>
                        {action === 'pairing' ? 'Generating…' : 'Generate new pairing code'}
                      </Button>
                    )}
                    <Button type="button" variant="ghost" onClick={() => void handleRevokeDirectMt5()} disabled={loading}>
                      {action === 'revoking-mt5' ? 'Revoking…' : 'Revoke connector'}
                    </Button>
                  </div>
                </div>
              )}
                </>
              )}
            </div>
          ) : (
            <>
              {selectedIsMt5 && (
                <div style={{ marginBottom: 'var(--space-4)' }}>
                  <div className="input-label" style={{ marginBottom: 'var(--space-2)' }}>Connection method</div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <Button type="button" variant="secondary" onClick={switchToDirectMt5}>
                      Direct Connector (recommended)
                    </Button>
                    <Button type="button" variant="primary" onClick={switchToMetaApi}>
                      MT5 via MetaApi (optional)
                    </Button>
                  </div>
                  <Alert variant="warning">
                    MetaApi is the optional hosted route and may require a separate MetaApi subscription. Direct Connector is the recommended subscription-free path.
                  </Alert>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)' }}>
                <Input label="Account ID" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={loading} placeholder="Your broker account ID" required />
                <Input label="Display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={loading} placeholder="My demo account" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)' }}>
                <Input label="API key (optional for paper broker)" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={loading} placeholder="••••••••" />
                <Input label="API secret (optional for paper broker)" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} disabled={loading} placeholder="••••••••" />
              </div>

              {/* Security note (info alert) */}
              <Alert variant="info">
                <span style={{ flex: 1 }}>
                  🔒 Credentials are encrypted (AES-256-GCM) before storage. They are NEVER returned in API responses or logs.
                </span>
              </Alert>

              {testResult && (
                <Alert variant={testResult.success ? 'success' : 'error'}>
                  <span style={{ flex: 1 }}>
                    {testResult.success
                      ? `✅ Test succeeded! Account ID: ${testResult.accountId ?? '(confirmed)'}`
                      : `❌ Test failed: ${testResult.errorMessage ?? 'unknown error'}`}
                  </span>
                </Alert>
              )}

              <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleTest}
                  disabled={loading}
                  loading={action === 'testing'}
                >
                  {action === 'testing' ? 'Testing…' : 'Test credentials'}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={loading}
                  loading={action === 'saving'}
                >
                  {action === 'saving' ? 'Saving…' : 'Save connection'}
                </Button>
              </div>
            </>
          )}
        </form>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-4)', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <Link href="/onboarding/risk" className="text-sm">← Risk profile</Link>
          <Link href="/dashboard" className="text-sm">Back to dashboard →</Link>
        </div>
      </Card>

      </main>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmLabel={confirmDialog.confirmLabel}
        tone={confirmDialog.tone}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
      />
    </DashboardShell>
  );
}