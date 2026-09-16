'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatEnumLabel } from '@irexpro/types';
import type { BrokerRegistryEntry } from '@irexpro/types';
import type { AiCopilotView } from '@irexpro/types/ai-copilot';
import type { AiDecisionExplorerView, AiDecisionOutcome } from '@irexpro/types/ai-decision-explorer';
import type { TradeExecutionView } from '@irexpro/types/execution';
import type { ExecutionConfirmationView } from '@irexpro/types/execution';
import type { MarketCandleView, MarketIntelligenceView } from '@irexpro/types/market-intelligence';
import type { RiskIntelligenceView } from '@irexpro/types/risk-intelligence';
import type { StrategyLabView } from '@irexpro/types/strategy-lab';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { loadAiCopilot } from '@/lib/ai-copilot';
import { loadAiDecisionExplorer } from '@/lib/ai-decision-explorer';
import { api } from '@/lib/api';
import { loadMarketIntelligence } from '@/lib/market-intelligence';
import { loadStrategyLab } from '@/lib/strategy-lab';
import {
  changeSessionExecutionMode,
  confirmPendingConfirmation,
  connectionVerificationLabel,
  EXECUTION_MODES,
  executionBlockedReasons,
  formatExpiryCountdown,
  loadPendingExecutionConfirmations,
  type ExecutionMode,
} from '@/lib/trader-session';
import { loadTraderExecutionSnapshot, type TraderExecutionSnapshot } from '@/lib/trader-execution';
import { loadTraderRiskIntelligence } from '@/lib/trader-risk-intelligence';
import {
  loadTraderTerminalStatus,
  type TraderTerminalStatus,
  type TradingSessionStatusView,
  type TradingSessionView,
} from '@/lib/trader-terminal-status';

function sessionBadgeVariant(
  status: TradingSessionStatusView,
): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'PAUSED') return 'warning';
  if (status === 'SUSPENDED_RISK_LIMIT' || status === 'SUSPENDED_BROKER') return 'error';
  return 'info';
}

function brokerBadgeVariant(status: string): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'CONNECTED') return 'success';
  if (status === 'CONNECTING') return 'warning';
  if (status === 'ERROR' || status === 'SUSPENDED') return 'error';
  return 'info';
}

function executionBadgeVariant(
  status: TradeExecutionView['status'],
): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'OPEN' || status === 'CLOSED') return 'success';
  if (status === 'PENDING' || status === 'RECONCILIATION_PENDING') return 'warning';
  if (status === 'REJECTED' || status === 'CANCELLED') return 'error';
  return 'info';
}

function decisionBadgeVariant(outcome: AiDecisionOutcome): 'success' | 'warning' | 'error' | 'info' {
  if (outcome === 'EXECUTION_SUCCEEDED' || outcome === 'RISK_APPROVED') return 'success';
  if (outcome === 'RISK_REJECTED' || outcome === 'EXECUTION_FAILED') return 'error';
  if (outcome === 'IGNORED') return 'warning';
  return 'info';
}

function copilotPostureBadgeVariant(
  posture: AiCopilotView['posture'],
): 'success' | 'warning' | 'error' | 'info' {
  if (posture === 'NORMAL') return 'success';
  if (posture === 'CAUTION') return 'warning';
  return 'error';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** Human copy for a durable execution mode (Selector + detail list). */
function executionModeCopy(mode: ExecutionMode): string {
  switch (mode) {
    case 'PAPER_ONLY':
      return 'Paper only — new exposure routes to the simulator path';
    case 'SEMI_AUTO':
      return 'Semi-auto — every new exposure requires your server-verified confirmation';
    case 'FULL_AUTO':
      return 'Full auto — automatic exposure only while all authority conditions hold';
    default:
      return mode;
  }
}

/** Verification label badge semantics (fixed taxonomy, risk-ascending). */
function verificationLabelVariant(
  label: ReturnType<typeof connectionVerificationLabel>['label'],
): 'success' | 'warning' | 'error' | 'info' {
  if (label === 'Production LIVE Verified') return 'success';
  if (label === 'Production LIVE Unverified') return 'error';
  if (label === 'DEMO only') return 'warning';
  if (label === 'Ineligible') return 'warning';
  if (label === 'execution disabled') return 'error';
  return 'info';
}

function formatScore(value: number | null): string {
  return value === null ? 'Not available' : `${Math.round(value * 100)}%`;
}

function CompactCandlestickChart({ candles }: { candles: MarketCandleView[] }) {
  const geometry = useMemo(() => {
    const values = candles.flatMap((candle) => [Number(candle.high), Number(candle.low)]);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = Math.max(maximum - minimum, Number.EPSILON);
    const width = 900;
    const height = 300;
    const top = 18;
    const bottom = 22;
    const plotHeight = height - top - bottom;
    const slot = width / candles.length;
    const bodyWidth = Math.max(2, Math.min(9, slot * 0.56));
    const y = (value: number) => top + ((maximum - value) / range) * plotHeight;
    return { width, height, minimum, maximum, midpoint: minimum + range / 2, slot, bodyWidth, y };
  }, [candles]);

  return (
    <div className="cockpit-chart-shell">
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        width="100%"
        role="img"
        aria-label={`Cockpit candlestick chart with ${candles.length} broker candles`}
        preserveAspectRatio="none"
      >
        {[geometry.maximum, geometry.midpoint, geometry.minimum].map((value) => {
          const y = geometry.y(value);
          return (
            <g key={value}>
              <line x1="0" x2={geometry.width} y1={y} y2={y} stroke="var(--border-subtle)" strokeWidth="1" />
              <text x="8" y={Math.max(14, y - 5)} fontSize="14" fill="currentColor" opacity="0.58">
                {value.toFixed(5)}
              </text>
            </g>
          );
        })}
        {candles.map((candle, index) => {
          const open = Number(candle.open);
          const close = Number(candle.close);
          const x = geometry.slot * index + geometry.slot / 2;
          const openY = geometry.y(open);
          const closeY = geometry.y(close);
          const highY = geometry.y(Number(candle.high));
          const lowY = geometry.y(Number(candle.low));
          const rising = close >= open;
          const bodyTop = Math.min(openY, closeY);
          const bodyHeight = Math.max(1.8, Math.abs(closeY - openY));
          const color = rising ? 'var(--success, #2f9e6f)' : 'var(--danger, #d65757)';
          return (
            <g key={`${candle.timestamp}-${index}`}>
              <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="1.35" />
              <rect
                x={x - geometry.bodyWidth / 2}
                y={bodyTop}
                width={geometry.bodyWidth}
                height={bodyHeight}
                fill={rising ? 'transparent' : color}
                stroke={color}
                strokeWidth="1.35"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ExecutionRecord({ trade }: { trade: TradeExecutionView }) {
  return (
    <article className="cockpit-execution-record">
      <div className="cockpit-record-header">
        <div>
          <strong>{trade.instrument}</strong>
          <span className="muted text-sm" style={{ marginLeft: 'var(--space-2)' }}>
            {trade.direction} · {trade.lotSize} lot
          </span>
        </div>
        <Badge variant={executionBadgeVariant(trade.status)}>{formatEnumLabel(trade.status)}</Badge>
      </div>
      <dl className="cockpit-record-grid">
        <div><dt className="text-sm muted">Requested entry</dt><dd>{trade.requestedEntryPrice}</dd></div>
        <div><dt className="text-sm muted">Fill</dt><dd>{trade.fillPrice ?? 'Pending'}</dd></div>
        <div><dt className="text-sm muted">Stop loss</dt><dd>{trade.stopLoss}</dd></div>
        <div><dt className="text-sm muted">Take profit</dt><dd>{trade.takeProfit}</dd></div>
        {trade.exitPrice && <div><dt className="text-sm muted">Exit</dt><dd>{trade.exitPrice}</dd></div>}
        {trade.closeReason && <div><dt className="text-sm muted">Close reason</dt><dd>{formatEnumLabel(trade.closeReason)}</dd></div>}
        <div><dt className="text-sm muted">Opened</dt><dd>{formatTimestamp(trade.openedAt)}</dd></div>
      </dl>
    </article>
  );
}

/**
 * Execution-mode selector (Sprint 56 correction round 5 — issues #292/#298).
 *
 * An EXPLICIT selector: choosing a mode POSTs the audited mode-change
 * endpoint and the RETURNED session becomes the displayed state. The UI
 * never optimistically re-labels the mode; while the request is in flight
 * the selector stays disabled. Only an ACTIVE/PAUSED session may change its
 * mode (ENDED/SUSPENDED sessions are server-controlled).
 */
function ExecutionModeSelector({
  session,
  modeChanging,
  onModeChange,
}: {
  session: TradingSessionView | null;
  modeChanging: boolean;
  onModeChange: (mode: ExecutionMode) => void;
}) {
  const currentMode = session?.executionMode ?? null;
  const selectorDisabled =
    modeChanging || !session || session.status === 'ENDED' || session.status.startsWith('SUSPENDED');

  return (
    <div className="cockpit-mode-selector" role="group" aria-label="Execution mode selector">
      {EXECUTION_MODES.map((mode) => {
        const selected = currentMode === mode;
        return (
          <button
            key={mode}
            type="button"
            className="filter-group__btn"
            aria-pressed={selected}
            disabled={selectorDisabled}
            onClick={() => onModeChange(mode)}
            title={executionModeCopy(mode)}
          >
            {mode === 'PAPER_ONLY' ? 'Paper only' : mode === 'SEMI_AUTO' ? 'Semi-auto' : 'Full auto'}
          </button>
        );
      })}
      {modeChanging && <LoadingSpinner text="Applying mode…" />}
    </div>
  );
}

/**
 * SEMI_AUTO confirmation inbox (issue #298).
 *
 * Renders the SERVER-queued pending confirmations with FULL order detail
 * (instrument, direction, quantity, SL, TP, expiry countdown, order-payload
 * digest) and relays an explicit Confirm to the server endpoint. Approval
 * state is NEVER fabricated locally: only the server-consumed CONSUMED
 * result removes a row, and failures render the server's typed reason
 * (expired / consumed / revoked / mismatched-generation).
 */
function ConfirmationInbox({
  confirmations,
  loading,
  error,
  confirmingId,
  failure,
  onConfirm,
  now,
}: {
  confirmations: ExecutionConfirmationView[];
  loading: boolean;
  error: string | null;
  confirmingId: string | null;
  failure: { kind: string; message: string } | null;
  onConfirm: (confirmationId: string) => void;
  now: Date;
}) {
  return (
    <section aria-labelledby="confirmation-inbox-title" className="cockpit-confirmation-inbox">
      <div className="cockpit-section-heading">
        <div>
          <p className="terminal-foundation__eyebrow">Execution authority</p>
          <h2 id="confirmation-inbox-title">Semi-auto confirmation inbox</h2>
          <p className="muted">
            Server-queued one-time confirmations bound to the exact order payload. Confirming sends the
            request to the server — only its consumed result is shown as approved.
          </p>
        </div>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {failure && (
        <Alert variant="error">
          <div style={{ flex: 1 }}>
            <strong>Server rejected the confirmation ({failure.kind}).</strong>
            <p style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>{failure.message}</p>
          </div>
        </Alert>
      )}
      {loading ? (
        <Card title="Loading confirmations" className="cockpit-panel">
          <LoadingSpinner text="Checking server-queued confirmations…" />
        </Card>
      ) : confirmations.length === 0 ? (
        <Card title="No pending confirmations" className="cockpit-panel">
          <p className="muted" style={{ marginTop: 0 }}>
            The server reports no queued semi-auto confirmations for this session. New exposure waits
            for a server-issued confirmation.
          </p>
        </Card>
      ) : (
        <div className="cockpit-confirmation-grid">
          {confirmations.map((confirmation) => {
            const countdown = formatExpiryCountdown(confirmation.expiresAt, now);
            const expired = countdown === 'Expired';
            return (
              <Card
                key={confirmation.id}
                title={`${confirmation.instrument} · ${confirmation.direction}`}
                subtitle={`Signal ${confirmation.signalId}`}
                className="cockpit-panel"
              >
                <div className="cockpit-card-badge">
                  <Badge variant={confirmation.direction === 'BUY' ? 'success' : 'error'}>
                    {confirmation.direction}
                  </Badge>
                  <Badge variant={expired ? 'error' : 'warning'}>
                    {expired ? 'Expired' : `Expires in ${countdown}`}
                  </Badge>
                </div>
                <dl className="cockpit-detail-list">
                  <div><dt>Quantity</dt><dd>{confirmation.quantity}</dd></div>
                  <div><dt>Stop loss</dt><dd>{confirmation.stopLoss ?? 'Not set'}</dd></div>
                  <div><dt>Take profit</dt><dd>{confirmation.takeProfit ?? 'Not set'}</dd></div>
                  <div><dt>Expiry</dt><dd>{formatTimestamp(confirmation.expiresAt)}</dd></div>
                  <div>
                    <dt>Order payload digest</dt>
                    <dd className="text-sm" style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                      {confirmation.orderPayloadDigest}
                    </dd>
                  </div>
                </dl>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={expired || confirmingId !== null}
                  loading={confirmingId === confirmation.id}
                  onClick={() => onConfirm(confirmation.id)}
                >
                  {confirmingId === confirmation.id ? 'Confirming…' : 'Confirm order'}
                </Button>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function TradingWorkspacePage() {
  const { user, logout, restoring } = useAuth();
  const [terminal, setTerminal] = useState<TraderTerminalStatus | null>(null);
  const [execution, setExecution] = useState<TraderExecutionSnapshot | null>(null);
  const [market, setMarket] = useState<MarketIntelligenceView | null>(null);
  const [risk, setRisk] = useState<RiskIntelligenceView | null>(null);
  const [decisions, setDecisions] = useState<AiDecisionExplorerView | null>(null);
  const [strategy, setStrategy] = useState<StrategyLabView | null>(null);
  const [copilot, setCopilot] = useState<AiCopilotView | null>(null);

  // ── Execution authority state (Sprint 56 correction round 5) ──
  /** Server registry entries — joined per connection for verification labels. */
  const [registryEntries, setRegistryEntries] = useState<BrokerRegistryEntry[]>([]);
  /** Server-queued SEMI_AUTO confirmations (only fetched in SEMI_AUTO mode). */
  const [confirmations, setConfirmations] = useState<ExecutionConfirmationView[]>([]);
  const [loadingConfirmations, setLoadingConfirmations] = useState(false);
  const [confirmationsError, setConfirmationsError] = useState<string | null>(null);
  /** Id of the confirmation whose confirm request is in flight. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** The server's typed failure for the last rejected confirm (rendered verbatim). */
  const [confirmFailure, setConfirmFailure] = useState<{ kind: string; message: string } | null>(null);
  const [modeChanging, setModeChanging] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  /** Ticks once per second so the expiry countdowns stay truthful. */
  const [now, setNow] = useState(() => new Date());

  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingExecution, setLoadingExecution] = useState(true);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [loadingRisk, setLoadingRisk] = useState(true);
  const [loadingDecisions, setLoadingDecisions] = useState(true);
  const [loadingStrategy, setLoadingStrategy] = useState(true);
  const [loadingCopilot, setLoadingCopilot] = useState(true);

  const [statusError, setStatusError] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [copilotError, setCopilotError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<TraderTerminalStatus | null> => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const [status, registry] = await Promise.all([
        loadTraderTerminalStatus(),
        // Server-authoritative registry joined per connection for the
        // verification-label taxonomy; a failure degrades fail-closed (the
        // label falls back to the unverified/DEMO-only truth, never "Live").
        api.listBrokerRegistry().catch(() => null),
      ]);
      setTerminal(status);
      setRegistryEntries(registry?.brokers ?? []);
      return status;
    } catch {
      setTerminal(null);
      setRegistryEntries([]);
      setStatusError('Unable to load the current trading status. No trading metrics have been inferred locally.');
      return null;
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  /** Refresh the server-queued SEMI_AUTO confirmations for the active session.
   *
   * `modeOverride` lets a just-applied mode change re-read the queue against
   * the NEW mode without waiting for a re-render (the captured terminal state
   * would otherwise still hold the previous mode). */
  const refreshConfirmations = useCallback(
    async (modeOverride?: ExecutionMode | null) => {
      // Only the active session's mode decides whether an inbox exists —
      // the browser never infers it from connection state.
      const mode = modeOverride !== undefined ? modeOverride : terminal?.session?.executionMode ?? null;
      if (mode !== 'SEMI_AUTO') {
        setConfirmations([]);
        setConfirmationsError(null);
        return;
      }
      setLoadingConfirmations(true);
      setConfirmationsError(null);
      try {
        setConfirmations(await loadPendingExecutionConfirmations());
      } catch {
        setConfirmations([]);
        setConfirmationsError('Unable to load server-queued confirmations. No confirmation state has been assumed locally.');
      } finally {
        setLoadingConfirmations(false);
      }
    },
    [terminal?.session?.executionMode],
  );

  /**
   * Explicit mode change (issue #298): POST the audited endpoint; the
   * RETURNED session (bumped authorityGeneration) replaces the displayed
   * state. Confirmations refresh afterwards because a generation bump
   * invalidates any outstanding server-queued confirmation.
   */
  const handleModeChange = useCallback(
    async (mode: ExecutionMode) => {
      const session = terminal?.session ?? null;
      if (!session || modeChanging) return;
      setModeChanging(true);
      setModeError(null);
      try {
        const updated = await changeSessionExecutionMode(session.id, mode);
        setTerminal((prev) => (prev ? { ...prev, session: updated } : prev));
        setConfirmFailure(null);
        // A generation bump invalidates outstanding confirmations — re-read
        // the server queue against the NEW mode instead of keeping (or
        // clearing) rows locally.
        await refreshConfirmations(updated.executionMode);
      } catch (err) {
        setModeError(
          err instanceof Error
            ? `The server rejected the mode change: ${err.message}`
            : 'The server rejected the mode change.',
        );
      } finally {
        setModeChanging(false);
      }
    },
    [terminal?.session, modeChanging, refreshConfirmations],
  );

  /** Relay one explicit confirm to the server (never a local approval). */
  const handleConfirm = useCallback(
    async (confirmationId: string) => {
      if (confirmingId) return;
      setConfirmingId(confirmationId);
      setConfirmFailure(null);
      try {
        const result = await confirmPendingConfirmation(confirmationId);
        if (result.outcome === 'CONSUMED') {
          // Server-consumed: re-read the authoritative queue.
          try {
            setConfirmations(await loadPendingExecutionConfirmations());
          } catch {
            setConfirmations([]);
            setConfirmationsError('Unable to re-load server-queued confirmations after the server consumed one.');
          }
        } else {
          // Surface the server's typed failure verbatim — no local success.
          setConfirmFailure(result.failure);
        }
      } finally {
        setConfirmingId(null);
      }
    },
    [confirmingId],
  );

  // One-second clock tick ONLY while a semi-auto inbox with pending rows is
  // rendered (drives the expiry countdowns).
  useEffect(() => {
    if (terminal?.session?.executionMode !== 'SEMI_AUTO' || confirmations.length === 0) {
      return;
    }
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [terminal?.session?.executionMode, confirmations.length]);

  const refreshExecution = useCallback(async () => {
    setLoadingExecution(true);
    setExecutionError(null);
    try {
      setExecution(await loadTraderExecutionSnapshot());
    } catch {
      setExecution(null);
      setExecutionError('Unable to load the authoritative execution snapshot. Stale position data has been cleared.');
    } finally {
      setLoadingExecution(false);
    }
  }, []);

  const refreshMarket = useCallback(async () => {
    setLoadingMarket(true);
    setMarketError(null);
    setMarket(null);
    try {
      setMarket(await loadMarketIntelligence({ instrument: 'EURUSD', timeframe: 'H1', limit: 60 }));
    } catch {
      setMarket(null);
      setMarketError('Broker market data is unavailable or failed verification. The cockpit has cleared any previous quote and chart.');
    } finally {
      setLoadingMarket(false);
    }
  }, []);

  const refreshRisk = useCallback(async () => {
    setLoadingRisk(true);
    setRiskError(null);
    try {
      setRisk(await loadTraderRiskIntelligence());
    } catch {
      setRisk(null);
      setRiskError('Portfolio and risk intelligence is unavailable. Previously loaded capital-governance state has been cleared.');
    } finally {
      setLoadingRisk(false);
    }
  }, []);

  const refreshDecisions = useCallback(async () => {
    setLoadingDecisions(true);
    setDecisionError(null);
    try {
      setDecisions(await loadAiDecisionExplorer());
    } catch {
      setDecisions(null);
      setDecisionError('Persisted AI decision evidence is unavailable. The cockpit will not reconstruct missing AI facts.');
    } finally {
      setLoadingDecisions(false);
    }
  }, []);

  const refreshStrategy = useCallback(async () => {
    setLoadingStrategy(true);
    setStrategyError(null);
    try {
      setStrategy(await loadStrategyLab());
    } catch {
      setStrategy(null);
      setStrategyError('Strategy Lab evidence is unavailable. No strategy recommendation has been inferred by the browser.');
    } finally {
      setLoadingStrategy(false);
    }
  }, []);

  const refreshCopilot = useCallback(async () => {
    setLoadingCopilot(true);
    setCopilotError(null);
    setCopilot(null);
    try {
      setCopilot(await loadAiCopilot({ instrument: 'EURUSD', timeframe: 'H1' }));
    } catch {
      setCopilot(null);
      setCopilotError('Contextual AI Copilot evidence is unavailable or failed verification. Previous Copilot explanation has been cleared.');
    } finally {
      setLoadingCopilot(false);
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    const [status] = await Promise.all([
      refreshStatus(),
      refreshExecution(),
      refreshMarket(),
      refreshRisk(),
      refreshDecisions(),
      refreshStrategy(),
      refreshCopilot(),
    ]);
    // Re-read the confirmation queue against the session mode the server
    // JUST reported (passing the mode explicitly avoids the stale closure
    // over the pre-refresh terminal state).
    await refreshConfirmations(status?.session?.executionMode ?? null);
  }, [
    refreshStatus,
    refreshConfirmations,
    refreshExecution,
    refreshMarket,
    refreshRisk,
    refreshDecisions,
    refreshStrategy,
    refreshCopilot,
  ]);

  useEffect(() => {
    if (!user) return;
    void refreshWorkspace();
  }, [user, refreshWorkspace]);

  const latestDecision = decisions?.decisions[0] ?? null;
  const strategyScenario = strategy?.scenarios[0] ?? null;
  const strategyLeader = strategyScenario?.candidates.find((candidate) => candidate.rank === 1) ?? null;

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring session…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 620, margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">You need to log in to access the trading workspace.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  const session = terminal?.session ?? null;
  const broker = terminal?.sessionBroker ?? terminal?.primaryBroker ?? null;
  const sessionBroker = terminal?.sessionBroker ?? null;

  // ── Execution-authority derivations (server facts only) ──
  /** Blocked reasons fed by the session/risk/authorization state the server reported. */
  const blockedReasons = terminal
    ? executionBlockedReasons({
        session,
        killSwitchActive: terminal.risk.killSwitchActive,
        canTrade: terminal.risk.canTrade,
        brokerConnected: terminal.risk.brokerConnected,
        sessionAuthorizationStatus: sessionBroker?.authorizationStatus ?? null,
        // The broker-connection view carries no executable gate — leave it
        // unknown rather than guessing (the live-account surface shows it).
        sessionConnectionExecutable: null,
      })
    : [];
  /** Verification label assessment for the surfaced broker (fixed taxonomy). */
  const brokerVerification =
    broker !== null
      ? connectionVerificationLabel(
          {
            accountType: broker.accountType,
            authorizationStatus: broker.authorizationStatus ?? null,
            providerBrokerIdentity: broker.providerBrokerIdentity ?? null,
            logicalAccountKey: broker.logicalAccountKey ?? null,
          },
          registryEntries.find((entry) => entry.id === broker.brokerId) ?? null,
        )
      : null;
  const workspaceLoading =
    loadingStatus ||
    loadingExecution ||
    loadingMarket ||
    loadingRisk ||
    loadingDecisions ||
    loadingStrategy ||
    loadingCopilot;

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/trade" title="Dynamic Trader Cockpit">
      <main className="terminal-foundation trader-cockpit" data-testid="dynamic-trader-cockpit">
        <section className="terminal-foundation__hero cockpit-hero" aria-labelledby="trading-workspace-title">
          <div>
            <p className="terminal-foundation__eyebrow">Dynamic Trader Cockpit</p>
            <h1 id="trading-workspace-title" className="terminal-foundation__title">Trading Workspace</h1>
            <p className="terminal-foundation__description">
              One AI-native operating surface for broker market evidence, autonomous decision evidence, capital guardrails, strategy research, and execution lifecycle state. Every panel preserves its authoritative source boundary.
            </p>
          </div>
          <Button type="button" variant="secondary" size="sm" loading={workspaceLoading} disabled={workspaceLoading} onClick={() => void refreshWorkspace()}>
            {workspaceLoading ? 'Refreshing cockpit…' : 'Refresh cockpit'}
          </Button>
        </section>

        <section className="cockpit-status-rail" aria-label="Cockpit status rail">
          <div className="cockpit-status-tile">
            <span className="cockpit-status-label">AI session</span>
            <strong>{session ? formatEnumLabel(session.status) : loadingStatus ? 'Loading' : 'No active session'}</strong>
            {session && <Badge variant={sessionBadgeVariant(session.status)}>{formatEnumLabel(session.status)}</Badge>}
          </div>
          <div className="cockpit-status-tile">
            <span className="cockpit-status-label">Broker</span>
            <strong>{broker?.brokerName ?? (loadingStatus ? 'Loading' : 'Unavailable')}</strong>
            {broker && <Badge variant={brokerBadgeVariant(broker.status)}>{formatEnumLabel(broker.status)}</Badge>}
          </div>
          <div className="cockpit-status-tile">
            <span className="cockpit-status-label">Risk gate</span>
            <strong>{terminal ? (terminal.risk.canTrade ? 'Clear' : 'Blocked') : loadingStatus ? 'Loading' : 'Unavailable'}</strong>
            {terminal && <Badge variant={terminal.risk.killSwitchActive ? 'error' : terminal.risk.canTrade ? 'success' : 'warning'}>{terminal.risk.killSwitchActive ? 'Kill switch active' : terminal.risk.canTrade ? 'Risk gate clear' : 'Trading blocked'}</Badge>}
          </div>
          <div className="cockpit-status-tile">
            <span className="cockpit-status-label">EURUSD · H1</span>
            <strong>{market ? market.quote.bid : loadingMarket ? 'Loading' : 'Unavailable'}</strong>
            {market && <Badge variant={market.status === 'FRESH' ? 'success' : 'warning'}>{market.status}</Badge>}
          </div>
        </section>

        {(statusError || executionError) && (
          <div className="cockpit-alert-stack">
            {statusError && <Alert variant="error">{statusError}</Alert>}
            {executionError && <Alert variant="error">{executionError}</Alert>}
          </div>
        )}

        <section className="cockpit-grid" aria-label="Integrated trading intelligence">
          <div className="cockpit-main-stack">
            <Card title="Broker Market · EURUSD" subtitle="Provider-backed quote and OHLCV; presentation-only chart geometry." className="cockpit-panel cockpit-panel--market">
              {marketError && <Alert variant="error">{marketError}</Alert>}
              {loadingMarket && !market ? (
                <LoadingSpinner text="Verifying broker quote and candles…" />
              ) : market ? (
                <>
                  {market.status === 'STALE' && <Alert variant="warning">Broker market evidence is stale. The cockpit does not present it as live.</Alert>}
                  <div className="cockpit-quote-grid">
                    <div><span>Bid</span><strong>{market.quote.bid}</strong></div>
                    <div><span>Ask</span><strong>{market.quote.ask}</strong></div>
                    <div><span>Spread</span><strong>{market.quote.spread}</strong></div>
                  </div>
                  <CompactCandlestickChart candles={market.candles} />
                  <div className="cockpit-panel-footer">
                    <span className="text-sm muted">{market.timeframe} · {market.source} · retrieved {formatTimestamp(market.retrievedAt)}</span>
                    <Link href="/market" className="cockpit-text-link">Open Market Intelligence</Link>
                  </div>
                </>
              ) : null}
            </Card>

            {loadingStatus && !terminal ? (
              <Card title="Loading operational status" className="cockpit-panel"><LoadingSpinner text="Checking risk, session, and broker status…" /></Card>
            ) : terminal ? (
              <section className="cockpit-operational-grid" aria-label="Trading operational status">
                <Card title="Risk Engine" className="cockpit-panel">
                  <div className="cockpit-card-badge"><Badge variant={terminal.risk.killSwitchActive ? 'error' : terminal.risk.canTrade ? 'success' : 'warning'}>{terminal.risk.killSwitchActive ? 'Kill switch active' : terminal.risk.canTrade ? 'Risk gate clear' : 'Trading blocked'}</Badge></div>
                  <dl className="cockpit-detail-list">
                    <div><dt>Broker gate</dt><dd>{terminal.risk.brokerConnected ? 'Connected' : 'Not connected'}</dd></div>
                    <div><dt>Max daily loss</dt><dd>{terminal.risk.limits.maxDailyLossPercent}%</dd></div>
                    <div><dt>Max drawdown</dt><dd>{terminal.risk.limits.maxDrawdownPercent}%</dd></div>
                    <div><dt>Max open trades</dt><dd>{terminal.risk.limits.maxOpenTrades}</dd></div>
                    <div><dt>Max position size</dt><dd>{terminal.risk.limits.maxPositionSizeLot} lot</dd></div>
                    <div><dt>Allowed instruments</dt><dd>{terminal.risk.limits.allowedInstruments === 'ALL' ? 'All configured instruments' : terminal.risk.limits.allowedInstruments.join(', ')}</dd></div>
                  </dl>
                  <Link href="/onboarding/risk" className="cockpit-text-link">Review risk limits</Link>
                </Card>

                <Card title="Trading Session — Execution Authority" subtitle="Durable session mode; changes are audited server-side." className="cockpit-panel">
                  {session ? (
                    <>
                      <div className="cockpit-card-badge">
                        <Badge variant={sessionBadgeVariant(session.status)}>{formatEnumLabel(session.status)}</Badge>
                        <Badge variant="info">{session.executionMode}</Badge>
                      </div>
                      <dl className="cockpit-detail-list">
                        <div><dt>Started</dt><dd>{formatTimestamp(session.startedAt)}</dd></div>
                        <div><dt>Authority generation</dt><dd>{session.authorityGeneration}</dd></div>
                        <div><dt>Lifecycle source</dt><dd>Trading session service</dd></div>
                      </dl>
                      <p className="text-sm muted" style={{ marginTop: 0, marginBottom: 'var(--space-2)' }}>
                        {executionModeCopy(session.executionMode)}
                      </p>
                      <ExecutionModeSelector
                        session={session}
                        modeChanging={modeChanging}
                        onModeChange={(mode) => void handleModeChange(mode)}
                      />
                      {modeError && <Alert variant="error">{modeError}</Alert>}
                      {blockedReasons.length > 0 && (
                        <Alert variant="warning">
                          <div style={{ flex: 1 }}>
                            <strong>Execution blocked</strong>
                            <ul style={{ margin: 'var(--space-1) 0 0', paddingLeft: '1.1rem' }}>
                              {blockedReasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          </div>
                        </Alert>
                      )}
                    </>
                  ) : (
                    <>
                      <Badge variant="info">No active session</Badge>
                      <p className="muted mt-4">No active AI trading session was returned. Eligibility remains server controlled — execution authority is not started.</p>
                    </>
                  )}
                </Card>

                <Card title="Broker Health" className="cockpit-panel">
                  {broker ? (
                    <>
                      <div className="cockpit-card-badge">
                        <Badge variant={brokerBadgeVariant(broker.status)}>{formatEnumLabel(broker.status)}</Badge>
                        {brokerVerification && (
                          <Badge variant={verificationLabelVariant(brokerVerification.label)}>
                            {brokerVerification.label}
                          </Badge>
                        )}
                      </div>
                      <dl className="cockpit-detail-list">
                        <div><dt>Broker</dt><dd>{broker.brokerName}</dd></div>
                        {broker.displayName && <div><dt>Account alias</dt><dd>{broker.displayName}</dd></div>}
                        <div><dt>Environment</dt><dd>{formatEnumLabel(broker.accountType)}</dd></div>
                        <div><dt>Last health check</dt><dd>{formatTimestamp(broker.lastHealthCheckAt)}</dd></div>
                        <div>
                          <dt>Current executability</dt>
                          <dd>
                            {brokerVerification
                              ? brokerVerification.connectionExecutability === 'execution disabled'
                                ? 'execution disabled'
                                : brokerVerification.connectionExecutability
                              : 'Unavailable'}
                          </dd>
                        </div>
                      </dl>
                      <p className="text-sm muted" style={{ overflowWrap: 'anywhere' }}>
                        Verification label is the fixed provider taxonomy. Live-trading flag (compatibility
                        mirror, not authoritative): {broker.liveTradingEnabled ? 'enabled' : 'not enabled'}.
                      </p>
                      <Link href="/onboarding/broker" className="cockpit-text-link">Review broker connection</Link>
                    </>
                  ) : <><Badge variant="warning">No broker connection</Badge><p className="muted mt-4">No sanitized broker connection was returned for this account.</p></>}
                </Card>
              </section>
            ) : null}

            <section aria-labelledby="execution-state-title" className="cockpit-execution-section">
              <div className="cockpit-section-heading">
                <div>
                  <p className="terminal-foundation__eyebrow">Execution intelligence</p>
                  <h2 id="execution-state-title">Positions &amp; Recent Executions</h2>
                  <p className="muted">Read-only lifecycle state from the server-side execution engine. Values are never calculated from browser market data.</p>
                </div>
              </div>
              {loadingExecution && !execution ? (
                <Card title="Loading execution state" className="cockpit-panel"><LoadingSpinner text="Loading open positions and recent executions…" /></Card>
              ) : execution ? (
                <div className="cockpit-execution-grid">
                  <Card title={`Open Positions (${execution.openPositions.length})`} className="cockpit-panel">
                    {execution.openPositions.length === 0 ? <p className="muted">The execution engine reports no open positions for this account.</p> : <div className="cockpit-record-stack">{execution.openPositions.map((trade) => <ExecutionRecord key={trade.id} trade={trade} />)}</div>}
                  </Card>
                  <Card title="Recent Executions" className="cockpit-panel">
                    {execution.recentExecutions.length === 0 ? <p className="muted">No execution lifecycle records are available yet.</p> : <div className="cockpit-record-stack">{execution.recentExecutions.slice(0, 6).map((trade) => <ExecutionRecord key={trade.id} trade={trade} />)}</div>}
                  </Card>
                </div>
              ) : null}
            </section>

            {session?.executionMode === 'SEMI_AUTO' && (
              <ConfirmationInbox
                confirmations={confirmations}
                loading={loadingConfirmations}
                error={confirmationsError}
                confirmingId={confirmingId}
                failure={confirmFailure}
                onConfirm={(confirmationId) => void handleConfirm(confirmationId)}
                now={now}
              />
            )}
          </div>

          <aside className="cockpit-side-stack" aria-label="AI and capital intelligence">
            <Card title="AI Decision Pulse" subtitle="Latest persisted autonomous-decision evidence." className="cockpit-panel">
              {decisionError && <Alert variant="error">{decisionError}</Alert>}
              {loadingDecisions && !decisions ? <LoadingSpinner text="Loading AI evidence…" /> : latestDecision ? (
                <>
                  <div className="cockpit-card-badge"><Badge variant={decisionBadgeVariant(latestDecision.outcome)}>{formatEnumLabel(latestDecision.outcome)}</Badge></div>
                  <div className="cockpit-decision-title">{latestDecision.evidence.instrument ?? 'Instrument unavailable'}{latestDecision.evidence.direction ? ` · ${latestDecision.evidence.direction}` : ''}</div>
                  <dl className="cockpit-detail-list">
                    <div><dt>Confidence</dt><dd>{formatScore(latestDecision.evidence.confidenceScore)}</dd></div>
                    <div><dt>Strategy</dt><dd>{latestDecision.evidence.strategyCode ?? 'Not available'}</dd></div>
                    <div><dt>Model</dt><dd>{latestDecision.evidence.modelVersion ?? 'Not available'}</dd></div>
                    <div><dt>Risk decision</dt><dd>{formatEnumLabel(latestDecision.risk.decision)}</dd></div>
                  </dl>
                  <p className="text-sm muted">Received {formatTimestamp(latestDecision.receivedAt)}</p>
                  <Link href="/ai" className="cockpit-text-link">Open Decision Explorer</Link>
                </>
              ) : decisions ? <><p className="muted">No persisted AI decisions were returned.</p><Link href="/ai" className="cockpit-text-link">Open Decision Explorer</Link></> : null}
            </Card>

            <Card title="Capital Guardrails" subtitle="Authoritative portfolio/risk capacity; no browser exposure math." className="cockpit-panel">
              {riskError && <Alert variant="error">{riskError}</Alert>}
              {loadingRisk && !risk ? <LoadingSpinner text="Loading capital guardrails…" /> : risk ? (
                <>
                  <div className="cockpit-card-badge"><Badge variant={risk.engine.killSwitchActive ? 'error' : risk.engine.brokerConnected ? 'success' : 'warning'}>{risk.engine.killSwitchActive ? 'Kill switch active' : risk.engine.brokerConnected ? 'Broker gate connected' : 'Broker unavailable'}</Badge></div>
                  <dl className="cockpit-detail-list">
                    <div><dt>Open positions</dt><dd>{risk.execution.openPositions} / {risk.execution.maxOpenPositions}</dd></div>
                    <div><dt>Open slots remaining</dt><dd>{risk.execution.openPositionSlotsRemaining}</dd></div>
                    <div><dt>Trades today</dt><dd>{risk.execution.todayTrades} / {risk.execution.maxDailyTrades}</dd></div>
                    <div><dt>Risk mode</dt><dd>{formatEnumLabel(risk.policy.allowedTradingMode)}</dd></div>
                    <div><dt>Portfolio snapshots</dt><dd>{risk.portfolio.freshSnapshots} fresh · {risk.portfolio.staleSnapshots} stale</dd></div>
                  </dl>
                  <Link href="/portfolio" className="cockpit-text-link">Open Portfolio &amp; Risk</Link>
                </>
              ) : null}
            </Card>

            <Card title="Strategy Lab Signal" subtitle="Versioned deterministic research, never a live execution command." className="cockpit-panel">
              {strategyError && <Alert variant="error">{strategyError}</Alert>}
              {loadingStrategy && !strategy ? <LoadingSpinner text="Verifying strategy dataset…" /> : strategy && strategyScenario ? (
                <>
                  <div className="cockpit-card-badge"><Badge variant="info">Advisory only</Badge></div>
                  <p className="cockpit-decision-title">{strategyScenario.name}</p>
                  <p className="muted text-sm">{formatEnumLabel(strategyScenario.marketRegime)} · {formatEnumLabel(strategyScenario.volatility)} volatility</p>
                  <dl className="cockpit-detail-list">
                    <div><dt>Recommended fixture</dt><dd>{strategyScenario.recommendation.strategyCode}</dd></div>
                    <div><dt>Dataset</dt><dd>{strategy.dataset.version}</dd></div>
                    {strategyLeader && <div><dt>Composite score</dt><dd>{strategyLeader.score.toFixed(1)}</dd></div>}
                  </dl>
                  <p className="text-sm muted">{strategyScenario.recommendation.summary}</p>
                  <Link href="/strategy-lab" className="cockpit-text-link">Open Strategy Lab</Link>
                </>
              ) : null}
            </Card>

            <Card
              title="Contextual AI Copilot"
              subtitle="Evidence-based explanation · No hidden reasoning exposed"
              className="cockpit-panel cockpit-copilot"
            >
              {copilotError && <Alert variant="error">{copilotError}</Alert>}
              {loadingCopilot && !copilot ? (
                <LoadingSpinner text="Composing authoritative Copilot context…" />
              ) : copilot ? (
                <>
                  <div className="cockpit-copilot-status">
                    <div className="cockpit-copilot-badges">
                      <Badge variant={copilot.status === 'READY' ? 'success' : 'warning'}>{copilot.status}</Badge>
                      <Badge variant={copilotPostureBadgeVariant(copilot.posture)}>{copilot.posture}</Badge>
                    </div>
                    <span className="cockpit-copilot-context">{copilot.instrument} · {copilot.timeframe}</span>
                  </div>

                  <div className="cockpit-copilot-summary">
                    <strong>{copilot.headline}</strong>
                    <p>{copilot.explanation}</p>
                  </div>

                  <div className="cockpit-copilot-facts" aria-label="Copilot authoritative context">
                    <div>
                      <span>Market</span>
                      <strong>{copilot.market ? copilot.market.freshness : 'Unavailable'}</strong>
                    </div>
                    <div>
                      <span>Risk</span>
                      <strong>{copilot.risk ? (copilot.risk.killSwitchActive ? 'Blocked' : copilot.posture) : 'Unavailable'}</strong>
                    </div>
                    <div>
                      <span>Evidence</span>
                      <strong>{copilot.evidence.length}</strong>
                    </div>
                  </div>

                  {copilot.decision && (
                    <section className="cockpit-copilot-block" aria-label="Persisted AI decision evidence">
                      <span className="cockpit-copilot-kicker">Persisted AI decision evidence</span>
                      <div className="cockpit-copilot-decision">
                        <strong>
                          {copilot.instrument}
                          {copilot.decision.direction ? ` · ${copilot.decision.direction}` : ''}
                        </strong>
                        <Badge variant={decisionBadgeVariant(copilot.decision.outcome)}>
                          {formatEnumLabel(copilot.decision.outcome)}
                        </Badge>
                      </div>
                      <dl className="cockpit-detail-list">
                        <div><dt>Confidence</dt><dd>{formatScore(copilot.decision.confidenceScore)}</dd></div>
                        <div><dt>Strategy</dt><dd>{copilot.decision.strategyCode ?? 'Not available'}</dd></div>
                        <div><dt>Risk decision</dt><dd>{formatEnumLabel(copilot.decision.riskDecision)}</dd></div>
                      </dl>
                    </section>
                  )}

                  {copilot.strategyResearch && (
                    <section className="cockpit-copilot-block" aria-label="Historical strategy research">
                      <span className="cockpit-copilot-kicker">Historical research · Advisory only</span>
                      <dl className="cockpit-detail-list">
                        <div><dt>Strategy</dt><dd>{copilot.strategyResearch.strategyCode}</dd></div>
                        <div><dt>Dataset</dt><dd>{copilot.strategyResearch.datasetVersion}</dd></div>
                        <div><dt>Fixture score</dt><dd>{copilot.strategyResearch.score.toFixed(1)}</dd></div>
                        <div><dt>Constraint status</dt><dd>{copilot.strategyResearch.eligible ? 'Eligible in fixture' : 'Not eligible in fixture'}</dd></div>
                      </dl>
                    </section>
                  )}

                  <section className="cockpit-copilot-block" aria-label="Authoritative Copilot evidence">
                    <span className="cockpit-copilot-kicker">Authoritative evidence</span>
                    <div className="cockpit-copilot-evidence-list">
                      {copilot.evidence.map((item) => (
                        <div key={`${item.source}-${item.state}`} className="cockpit-copilot-evidence">
                          <div>
                            <strong>{formatEnumLabel(item.source)}</strong>
                            <span>{item.summary}</span>
                          </div>
                          <Badge variant={item.state === 'BLOCKED' ? 'error' : item.state === 'STALE' ? 'warning' : item.state === 'UNAVAILABLE' ? 'warning' : 'info'}>
                            {formatEnumLabel(item.state)}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </section>

                  {copilot.nextChecks.length > 0 && (
                    <section className="cockpit-copilot-block" aria-label="Copilot next checks">
                      <span className="cockpit-copilot-kicker">Next checks</span>
                      <ul className="cockpit-copilot-checks">
                        {copilot.nextChecks.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </section>
                  )}

                  <div className="cockpit-copilot-policy">
                    <strong>Explanation only</strong>
                    <span>No hidden reasoning exposed. No trade instruction or broker mutation is available from this panel.</span>
                  </div>
                </>
              ) : null}
            </Card>

            <Card title="Cockpit Provenance" className="cockpit-panel cockpit-provenance">
              <ul>
                <li>Market values: connected provider-backed broker.</li>
                <li>AI state: persisted decision evidence only.</li>
                <li>Risk/capacity: server-side Risk Engine contracts.</li>
                <li>Strategy: deterministic research dataset, advisory only.</li>
                <li>Copilot: server-composed evidence explanation, never execution authority.</li>
                <li>Execution: server-side execution lifecycle read model.</li>
              </ul>
            </Card>
          </aside>
        </section>

        <aside className="terminal-foundation__policy" aria-label="Trading data integrity policy">
          <strong>Authoritative data only</strong>
          <p>
            This cockpit composes broker market data, Risk Engine, trading-session, sanitized broker, persisted AI-decision, deterministic Strategy Lab, Contextual AI Copilot, portfolio-risk, and frontend-safe execution APIs. It does not calculate or fabricate balances, P&amp;L, unrealised P&amp;L, market prices, risk exposure, or execution quality in the browser. P&amp;L remains intentionally hidden until the backend returns it with authoritative currency context. The browser exposes no direct broker order control.
          </p>
        </aside>
      </main>
    </DashboardShell>
  );
}
