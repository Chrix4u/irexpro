'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  startExecutionModeForBroker,
  type UserCapitalAllocationView,
  type TradeExecutionView,
} from '@irexpro/types/execution';
import type { LivePositionRowView } from '@irexpro/types/live-account';
import type { MarketIntelligenceView } from '@irexpro/types/market-intelligence';
import { Alert, Badge, Button, Card, DashboardShell, Input, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { useNotification } from '@/hooks/useNotification';
import { api } from '@/lib/api';
import { formatAgeSeconds } from '@/lib/duration';
import { mapApiError } from '@/lib/error-mapping';
import { loadLiveAccountPositions } from '@/lib/live-account';
import { loadMarketIntelligence } from '@/lib/market-intelligence';
import { loadTraderExecutionSnapshot, type TraderExecutionSnapshot } from '@/lib/trader-execution';
import {
  loadTraderTerminalStatus,
  type TraderTerminalStatus,
  type TerminalBrokerView,
} from '@/lib/trader-terminal-status';
import './ai-trader.css';

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatFixedDecimal(
  value: string | null | undefined,
  fractionDigits = 2,
): string {
  if (!value) return '—';

  const normalized = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return normalized;

  const negative = match[1] === '-';
  const integerPart = match[2];
  const fractionalPart = match[3] ?? '';
  const scale = 10n ** BigInt(fractionDigits);
  const paddedFraction = fractionalPart.padEnd(fractionDigits + 1, '0');
  const keptFraction = paddedFraction.slice(0, fractionDigits) || '0';

  let scaled =
    BigInt(integerPart) * scale +
    (fractionDigits > 0 ? BigInt(keptFraction) : 0n);

  const roundDigit = paddedFraction[fractionDigits] ?? '0';
  if (roundDigit >= '5') {
    scaled += 1n;
  }

  const whole = scaled / scale;
  const fraction = fractionDigits > 0
    ? (scaled % scale).toString().padStart(fractionDigits, '0')
    : '';
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative && scaled !== 0n ? '-' : '';

  return fractionDigits > 0
    ? `${sign}${groupedWhole}.${fraction}`
    : `${sign}${groupedWhole}`;
}

function money(value: string | null | undefined, currency: string | null | undefined): string {
  const formatted = formatFixedDecimal(value, 2);
  if (formatted === '—') return formatted;
  return currency ? `${formatted} ${currency}` : formatted;
}

function pnlBadge(value: string | null): 'success' | 'error' | 'info' {
  if (!value) return 'info';
  if (value.startsWith('-')) return 'error';
  if (value === '0' || /^0(?:\.0+)?$/.test(value)) return 'info';
  return 'success';
}

function signedMoney(
  value: string | null | undefined,
  currency: string | null | undefined,
): string {
  if (value == null) return '—';
  return `${value.startsWith('-') || /^0(?:\.0+)?$/.test(value) ? '' : '+'}${money(value, currency)}`;
}

function sumDecimalStrings(values: Array<string | null | undefined>): string {
  const parsed = values.flatMap((value) => {
    if (value == null) return [];
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!match) return [];
    return [{
      negative: match[1] === '-',
      whole: match[2],
      fraction: match[3] ?? '',
    }];
  });
  if (parsed.length === 0) return '0';

  const fractionDigits = parsed.reduce(
    (maximum, value) => Math.max(maximum, value.fraction.length),
    0,
  );
  const scale = 10n ** BigInt(fractionDigits);
  let total = 0n;

  for (const value of parsed) {
    const fraction = value.fraction.padEnd(fractionDigits, '0');
    const absolute =
      BigInt(value.whole) * scale +
      (fractionDigits > 0 ? BigInt(fraction || '0') : 0n);
    total += value.negative ? -absolute : absolute;
  }

  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const whole = absolute / scale;
  if (fractionDigits === 0) return `${negative ? '-' : ''}${whole}`;

  const fraction = (absolute % scale)
    .toString()
    .padStart(fractionDigits, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function connectionLabel(broker: TerminalBrokerView | null): string {
  if (!broker) return 'No broker connected';
  return broker.displayName || broker.brokerName;
}

interface AiAutomationRuntimeStatus {
  enabled: boolean;
  registered: boolean;
  trading_session_id: string;
  active: boolean;
  instruments: string[];
  timeframe: string | null;
  interval_seconds: number | null;
  source: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_decision: string | null;
  last_reason: string | null;
  last_confidence_score: number | null;
  last_confidence_at: string | null;
  confidence_threshold: number | null;
  model_version: string | null;
  model_mode: string | null;
  model_loaded: boolean | null;
  last_market_data_at: string | null;
  market_data_age_seconds: number | null;
  market_data_cache_bypassed: boolean;
  last_publish_failed: boolean;
  research_uat?: boolean;
  replay_steps_per_cycle?: number;
  replay_steps_last_cycle?: number;
  replay_steps_total?: number;
  signals_published_total?: number;
  qualified_signals_published_total?: number;
  uat_probe_signals_published_total?: number;
  last_strategy_outcome?: string | null;
  last_strategy_reason?: string | null;
  last_trade_id?: string | null;
  executions_succeeded_total?: number;
  qualified_executions_succeeded_total?: number;
  uat_probe_executions_succeeded_total?: number;
  downstream_rejected_total?: number;
  qualified_downstream_rejected_total?: number;
  uat_probe_downstream_rejected_total?: number;
}

function runtimeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Waiting for first market scan';
  const labels: Record<string, string> = {
    confidence_below_threshold: 'Market setup did not meet the confidence threshold',
    confidence_threshold_passed: 'Signal passed the confidence threshold and was published',
    market_data_unchanged:
      'No new market-data revision was available, so no duplicate signal was published',
    scheduler_integration_disabled: 'AI scheduler integration is disabled',
    model_not_approved_for_live:
      'Current AI model is not yet approved for live-money automation',
    MarketDataError:
      'Market data is unavailable or invalid; this scan was skipped and no confidence was evaluated',
    research_uat_replay_budget_exhausted:
      'Research PAPER replay completed its bounded market steps without an eligible signal',
    uat_workflow_probe_published:
      'Synthetic Research PAPER workflow probe published. The model did not pass the normal confidence gate.',
  };
  return labels[reason] ?? reason.replaceAll('_', ' ');
}

function formatConfidence(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

function modelModeLabel(mode: string | null | undefined): string {
  if (!mode) return 'Unknown';
  if (mode === 'heuristic_placeholder') return 'Heuristic scaffold';
  if (mode === 'trained_xgboost_mtf') return 'Trained MTF XGBoost';
  if (mode === 'trained_xgboost' || mode === 'real') return 'Trained XGBoost';
  return mode.replaceAll('_', ' ');
}

function executionReasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const labels: Record<string, string> = {
    MARKET_SAFETY_MARKET_DATA_UNAVAILABLE:
      'Execution blocked because a current paper-market quote could not be proven.',
    MARKET_SAFETY_STALE_PRICE:
      'Execution blocked because the provider quote was outside the allowed freshness window.',
    MARKET_SAFETY_ABNORMAL_SPREAD:
      'Execution blocked because the current spread exceeded the market-safety limit.',
    MARKET_SAFETY_PRICE_DEVIATION_EXCESSIVE:
      'Execution blocked because the execution quote was too far from the risk-validated reference price.',
    DISPATCH_BOUNDARY_BLOCKED:
      'Execution authority changed before provider dispatch, so the order was blocked safely.',
    EXECUTION_UNRESOLVED:
      'Provider outcome is not yet proven; reconciliation is still required.',
    EXECUTION_CANCELLED:
      'The order was cancelled before an active position was established.',
    EXECUTION_REJECTED:
      'The order was rejected before an active position was established.',
  };
  return labels[code] ?? 'Execution did not establish an active position.';
}

function PositionCard({ position }: { position: LivePositionRowView }) {
  return (
    <article className="ai-position-card">
      <div className="ai-position-card__head">
        <div>
          <strong>{position.instrument}</strong>
          <span>{position.direction} · {position.lotSize} lot · {position.status.replaceAll('_', ' ')}</span>
        </div>
        <Badge variant={pnlBadge(position.unrealisedPnl)}>
          {position.unrealisedPnl === null
            ? 'P&L awaiting broker'
            : signedMoney(position.unrealisedPnl, position.accountCurrency)}
        </Badge>
      </div>
      <dl className="ai-trade-metrics">
        <div><dt>Entry</dt><dd>{position.fillPrice ?? position.requestedEntryPrice}</dd></div>
        <div><dt>Current</dt><dd>{position.currentPrice ?? 'Awaiting broker mark'}</dd></div>
        <div><dt>Stop loss</dt><dd>{position.stopLoss}</dd></div>
        <div><dt>Take profit</dt><dd>{position.takeProfit}</dd></div>
        <div><dt>Trailing stop</dt><dd>{position.trailingStopPips ? `${position.trailingStopPips} pips` : '—'}</dd></div>
        <div><dt>Commission</dt><dd>{money(position.commission, position.accountCurrency)}</dd></div>
        <div><dt>Swap</dt><dd>{money(position.swap, position.accountCurrency)}</dd></div>
        <div><dt>Environment</dt><dd>{position.environment}</dd></div>
      </dl>
      <div className="ai-position-card__foot">
        <span>{position.brokerName ?? 'Broker'}</span>
        <span>{formatTimestamp(position.openedAt ?? position.createdAt)}</span>
      </div>
    </article>
  );
}

function ExecutionRow({ trade }: { trade: TradeExecutionView }) {
  const realized = trade.status === 'CLOSED' ? trade.realisedPnl : null;
  const executionReason = executionReasonLabel(trade.executionReasonCode);
  return (
    <article className="ai-activity-row">
      <div className="ai-activity-row__symbol">
        <strong>{trade.instrument}</strong>
        <span>{trade.direction} · {trade.lotSize} lot</span>
      </div>
      <div className="ai-activity-row__state">
        <Badge
          variant={
            trade.status === 'CLOSED' || trade.status === 'OPEN'
              ? 'success'
              : trade.status === 'REJECTED' || trade.status === 'CANCELLED'
                ? 'error'
                : 'warning'
          }
        >
          {trade.status.replaceAll('_', ' ')}
        </Badge>
        {realized !== null && (
          <Badge variant={pnlBadge(realized)}>
            {signedMoney(realized, trade.accountCurrency)}
          </Badge>
        )}
      </div>
      {trade.status === 'CLOSED' && (
        <div className="ai-activity-row__details">
          <span>Entry {trade.fillPrice ?? trade.requestedEntryPrice}</span>
          <span>Exit {trade.exitPrice ?? '—'}</span>
          <span>{trade.closeReason ? trade.closeReason.replaceAll('_', ' ') : 'CLOSED'}</span>
        </div>
      )}
      {executionReason && (
        <div className="ai-activity-row__reason">{executionReason}</div>
      )}
      <div className="ai-activity-row__time">
        {formatTimestamp(trade.closedAt ?? trade.openedAt ?? trade.createdAt)}
      </div>
    </article>
  );
}

function PositionTable({ positions }: { positions: LivePositionRowView[] }) {
  return (
    <div className="ai-table-shell">
      <table className="ai-trading-table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th>Lots</th>
            <th>Status</th>
            <th>Entry</th>
            <th>Current</th>
            <th>Unrealized P&amp;L</th>
            <th>Stop loss</th>
            <th>Take profit</th>
            <th>Trailing stop</th>
            <th>Commission</th>
            <th>Swap</th>
            <th>Broker</th>
            <th>Environment</th>
            <th>Opened</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.id}>
              <td><strong>{position.instrument}</strong></td>
              <td><Badge variant={position.direction === 'BUY' ? 'success' : 'warning'}>{position.direction}</Badge></td>
              <td>{position.lotSize}</td>
              <td><Badge variant={position.status === 'OPEN' ? 'success' : 'warning'}>{position.status.replaceAll('_', ' ')}</Badge></td>
              <td>{position.fillPrice ?? position.requestedEntryPrice}</td>
              <td>{position.currentPrice ?? 'Awaiting mark'}</td>
              <td>
                <span className={`ai-pnl ai-pnl--${pnlBadge(position.unrealisedPnl)}`}>
                  {position.unrealisedPnl === null
                    ? 'Awaiting broker'
                    : signedMoney(position.unrealisedPnl, position.accountCurrency)}
                </span>
              </td>
              <td>{position.stopLoss}</td>
              <td>{position.takeProfit}</td>
              <td>{position.trailingStopPips ? `${position.trailingStopPips} pips` : '—'}</td>
              <td>{money(position.commission, position.accountCurrency)}</td>
              <td>{money(position.swap, position.accountCurrency)}</td>
              <td>{position.brokerName ?? 'Broker'}</td>
              <td>{position.environment}</td>
              <td>{formatTimestamp(position.openedAt ?? position.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExecutionTable({ trades }: { trades: TradeExecutionView[] }) {
  return (
    <div className="ai-table-shell">
      <table className="ai-trading-table ai-trading-table--orders">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th>Lots</th>
            <th>Status</th>
            <th>Entry price</th>
            <th>Exit price</th>
            <th>Realized P&amp;L</th>
            <th>Commission</th>
            <th>Swap</th>
            <th>Result / close reason</th>
            <th>Opened</th>
            <th>Closed / updated</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const result = executionReasonLabel(trade.executionReasonCode);
            return (
              <tr key={trade.id}>
                <td><strong>{trade.instrument}</strong></td>
                <td><Badge variant={trade.direction === 'BUY' ? 'success' : 'warning'}>{trade.direction}</Badge></td>
                <td>{trade.lotSize}</td>
                <td>
                  <Badge
                    variant={
                      trade.status === 'CLOSED' || trade.status === 'OPEN'
                        ? 'success'
                        : trade.status === 'REJECTED' || trade.status === 'CANCELLED'
                          ? 'error'
                          : 'warning'
                    }
                  >
                    {trade.status.replaceAll('_', ' ')}
                  </Badge>
                </td>
                <td>{trade.fillPrice ?? trade.requestedEntryPrice}</td>
                <td>{trade.exitPrice ?? '—'}</td>
                <td>
                  <span className={`ai-pnl ai-pnl--${pnlBadge(trade.realisedPnl)}`}>
                    {trade.realisedPnl === null ? '—' : signedMoney(trade.realisedPnl, trade.accountCurrency)}
                  </span>
                </td>
                <td>{money(trade.commission, trade.accountCurrency)}</td>
                <td>{money(trade.swap, trade.accountCurrency)}</td>
                <td>{trade.closeReason?.replaceAll('_', ' ') ?? result ?? '—'}</td>
                <td>{formatTimestamp(trade.openedAt ?? trade.createdAt)}</td>
                <td>{formatTimestamp(trade.closedAt ?? trade.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function AiTradingPage() {
  const { user, logout, restoring } = useAuth();
  const notify = useNotification();

  const [terminal, setTerminal] = useState<TraderTerminalStatus | null>(null);
  const [execution, setExecution] = useState<TraderExecutionSnapshot | null>(null);
  const [livePositions, setLivePositions] = useState<LivePositionRowView[]>([]);
  const [market, setMarket] = useState<MarketIntelligenceView | null>(null);
  const [allocation, setAllocation] = useState<UserCapitalAllocationView | null>(null);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>('');
  const [allocationAmount, setAllocationAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingAllocation, setSavingAllocation] = useState(false);
  const [togglingAutomation, setTogglingAutomation] = useState(false);
  const [pendingAutomationAction, setPendingAutomationAction] = useState<'START' | 'STOP' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allocationWarning, setAllocationWarning] = useState<string | null>(null);
  const [activityWarning, setActivityWarning] = useState<string | null>(null);
  const [automationRuntime, setAutomationRuntime] = useState<AiAutomationRuntimeStatus | null>(null);
  const [automationRuntimeWarning, setAutomationRuntimeWarning] = useState<string | null>(null);
  const [positionViewMode, setPositionViewMode] = useState<'table' | 'grid'>('table');

  const initializedActivity = useRef(false);
  const seenPositionIds = useRef<Set<string>>(new Set());
  const seenExecutionStates = useRef<Map<string, string>>(new Map());

  const controlStateReady = Boolean(terminal?.risk && terminal?.sessionStateKnown);
  const automationOn =
    terminal?.sessionStateKnown === true &&
    (terminal.session?.status === 'ACTIVE' || terminal.session?.status === 'PAUSED');

  // The ACTIVE session is the execution authority. While it exists, the
  // workspace must stay visibly pinned to that exact broker account instead
  // of letting another selection inherit the global "AI ON" state.
  const selectedBroker = useMemo(
    () =>
      terminal?.sessionBroker ??
      terminal?.brokers.find((broker) => broker.id === selectedBrokerId) ??
      terminal?.primaryBroker ??
      null,
    [terminal, selectedBrokerId],
  );

  const unrealisedSummary = useMemo(() => {
    const marked = livePositions.filter((position) => position.unrealisedPnl !== null);
    const currencies = Array.from(
      new Set(marked.map((position) => position.accountCurrency).filter(Boolean)),
    ) as string[];

    if (currencies.length > 1) {
      return {
        value: null,
        currency: null,
        markedCount: marked.length,
        mixedCurrencies: true,
      };
    }

    return {
      value: sumDecimalStrings(marked.map((position) => position.unrealisedPnl)),
      currency: currencies[0] ?? allocation?.accountCurrency ?? null,
      markedCount: marked.length,
      mixedCurrencies: false,
    };
  }, [livePositions, allocation?.accountCurrency]);

  const emitActivityToasts = useCallback(
    (positions: LivePositionRowView[], snapshot: TraderExecutionSnapshot) => {
      if (!initializedActivity.current) {
        seenPositionIds.current = new Set(positions.map((position) => position.id));
        seenExecutionStates.current = new Map(
          snapshot.recentExecutions.map((trade) => [trade.id, trade.status]),
        );
        initializedActivity.current = true;
        return;
      }

      for (const position of positions) {
        if (!seenPositionIds.current.has(position.id)) {
          notify.success(
            `AI opened ${position.direction} ${position.instrument} · ${position.lotSize} lot`,
          );
        }
      }

      for (const trade of snapshot.recentExecutions) {
        const previous = seenExecutionStates.current.get(trade.id);
        if (previous && previous !== trade.status) {
          if (trade.status === 'CLOSED') {
            const pnl = trade.realisedPnl
              ? ` · ${trade.realisedPnl.startsWith('-') ? '' : '+'}${money(trade.realisedPnl, trade.accountCurrency)}`
              : '';
            notify.success(`${trade.instrument} position closed${pnl}`);
          } else if (trade.status === 'OPEN') {
            notify.info(`${trade.instrument} order filled — position is now open`);
          } else if (trade.status === 'REJECTED' || trade.status === 'CANCELLED') {
            notify.warning(`${trade.instrument} order ${trade.status.toLowerCase()}`);
          }
        }
      }

      seenPositionIds.current = new Set(positions.map((position) => position.id));
      seenExecutionStates.current = new Map(
        snapshot.recentExecutions.map((trade) => [trade.id, trade.status]),
      );
    },
    [notify],
  );

  const refreshTradingData = useCallback(async (showSpinner = false) => {
    if (!user) return;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      // Core trading controls depend only on the authoritative terminal state.
      // Activity/position read models are useful context but must never make
      // the Start/Stop workspace unavailable when one of those secondary
      // endpoints has a transient server-side failure.
      const status = await loadTraderTerminalStatus();
      setTerminal(status);

      if (status.session) {
        try {
          const runtime = await api.request<AiAutomationRuntimeStatus>(
            `/trading/sessions/${encodeURIComponent(status.session.id)}/automation-status`,
          );
          setAutomationRuntime(runtime);
          setAutomationRuntimeWarning(null);
        } catch {
          setAutomationRuntime(null);
          setAutomationRuntimeWarning(
            'AI Trading is running, but the AI engine runtime status could not be verified yet.',
          );
        }
      } else {
        setAutomationRuntime(null);
        setAutomationRuntimeWarning(null);
      }

      const [executionResult, positionsResult] = await Promise.allSettled([
        loadTraderExecutionSnapshot(),
        loadLiveAccountPositions(),
      ]);

      const snapshot =
        executionResult.status === 'fulfilled' ? executionResult.value : null;
      const positions =
        positionsResult.status === 'fulfilled' ? positionsResult.value.positions : [];

      setExecution(snapshot);
      setLivePositions(positions);

      if (snapshot) {
        emitActivityToasts(positions, snapshot);
      }

      if (executionResult.status === 'rejected' || positionsResult.status === 'rejected') {
        setActivityWarning(
          'AI Trading controls are available, but recent activity or position details could not be loaded. You can continue using Start/Stop; refresh this page to retry the activity feed.',
        );
      } else {
        setActivityWarning(null);
      }

      const brokerId =
        status.sessionBroker?.id ||
        selectedBrokerId ||
        status.primaryBroker?.id ||
        '';
      if (brokerId) {
        setSelectedBrokerId((current) => status.sessionBroker?.id || current || brokerId);
        try {
          const nextAllocation = await api.getCapitalAllocation(brokerId);
          setAllocation(nextAllocation);
          setAllocationWarning(null);
          if (nextAllocation.allocatedCapital) {
            setAllocationAmount(nextAllocation.allocatedCapital);
          }
        } catch {
          setAllocation(null);
          setAllocationWarning(
            'Your broker account is connected, but its AI capital allocation could not be loaded. Trading controls remain disabled until this data is available.',
          );
        }
      } else {
        setAllocation(null);
      }

      try {
        setMarket(await loadMarketIntelligence({ instrument: 'EURUSD', timeframe: 'H1', limit: 48 }));
      } catch {
        setMarket(null);
      }
    } catch (requestError) {
      setError(mapApiError(requestError).message);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [user, selectedBrokerId, emitActivityToasts]);

  useEffect(() => {
    if (!user) return;
    void refreshTradingData(true);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      void refreshTradingData(false);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [user, refreshTradingData]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadLiveAccountPositions()
        .then((next) => setLivePositions(next.positions))
        .catch(() => {
          // The full refresh owns the user-facing partial-read warning.
          // Keep the last proven position marks rather than blanking the table.
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    if (!pendingAutomationAction) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !togglingAutomation) {
        setPendingAutomationAction(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [pendingAutomationAction, togglingAutomation]);

  async function handleBrokerChange(nextId: string) {
    setSelectedBrokerId(nextId);
    setAllocation(null);
    setAllocationAmount('');
    try {
      const nextAllocation = await api.getCapitalAllocation(nextId);
      setAllocation(nextAllocation);
      setAllocationWarning(null);
      setAllocationAmount(nextAllocation.allocatedCapital ?? '');
    } catch {
      setAllocation(null);
      setAllocationWarning(
        'This broker is connected, but its AI capital allocation could not be loaded yet.',
      );
    }
  }

  async function saveAllocation() {
    if (!selectedBroker) {
      notify.warning('Connect a broker account first.');
      return;
    }
    if (!allocationAmount.trim()) {
      notify.warning('Enter the capital amount the AI may use.');
      return;
    }
    setSavingAllocation(true);
    setError(null);
    try {
      const next = await api.setCapitalAllocation({
        brokerConnectionId: selectedBroker.id,
        amount: allocationAmount.trim(),
      });
      setAllocation(next);
      setAllocationAmount(next.allocatedCapital ?? allocationAmount.trim());
      notify.success(`AI capital allocated: ${money(next.allocatedCapital, next.accountCurrency)}`);
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setSavingAllocation(false);
    }
  }

  function requestAutomationAction() {
    if (!selectedBroker) {
      notify.warning('Connect a broker account first.');
      return;
    }
    if (!controlStateReady) {
      notify.warning(
        'AI Trading controls are temporarily unavailable while risk protection and session status are being verified.',
      );
      return;
    }
    if (!automationOn && (!allocation?.hasAllocation || !allocation.allocatedCapital)) {
      notify.warning('Allocate capital before starting AI Trading.');
      return;
    }
    setPendingAutomationAction(automationOn ? 'STOP' : 'START');
  }

  async function confirmAutomationAction() {
    if (!pendingAutomationAction || !selectedBroker) return;
    const action = pendingAutomationAction;

    setTogglingAutomation(true);
    setError(null);
    try {
      if (action === 'STOP') {
        if (!terminal?.session) {
          notify.warning('AI Trading is already stopped.');
          setPendingAutomationAction(null);
          return;
        }

        const result = await api.stopTradingSession(terminal.session.id);
        const summary = result.positionCloseSummary;

        if (summary.state === 'COMPLETE') {
          if (summary.closedCount > 0) {
            notify.success(
              'AI Trading stopped. ' +
                summary.closedCount +
                ' AI position' +
                (summary.closedCount === 1 ? '' : 's') +
                ' confirmed closed.',
            );
          } else {
            notify.info('AI Trading stopped. No AI-opened positions were open.');
          }
        } else if (summary.state === 'PARTIAL') {
          notify.warning(
            'AI Trading stopped. ' +
              summary.closedCount +
              ' of ' +
              (summary.targetCount ?? 'the') +
              ' AI positions were confirmed closed; ' +
              (summary.unresolvedCount ?? 'some') +
              ' require follow-up.',
          );
        } else {
          notify.warning(
            'AI Trading stopped, but position closure could not be verified. Check Positions & Activity now.',
          );
        }
      } else {
        if (!allocation?.hasAllocation || !allocation.allocatedCapital) {
          notify.warning('Allocate capital before starting AI Trading.');
          setPendingAutomationAction(null);
          return;
        }
        const executionMode = startExecutionModeForBroker(selectedBroker);
        await api.startTradingSession({
          brokerConnectionId: selectedBroker.id,
          executionMode,
        });
        notify.success(
          selectedBroker.brokerId === 'paper-broker'
            ? 'Research PAPER UAT started in the internal simulator. No live broker funds are reachable.'
            : selectedBroker.accountType === 'DEMO'
              ? "AI Trading started against this broker's DEMO environment. No live funds are used."
              : 'AI Trading started for the verified live account.',
        );
      }

      await refreshTradingData(false);
      setPendingAutomationAction(null);
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setTogglingAutomation(false);
    }
  }

  const recentClosedTrades = execution?.closedExecutions.slice(0, 10) ?? [];

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring trading workspace…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: '680px', margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to access AI Trading.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/trade" title="AI Trading">
      <main className="ai-trader" data-testid="ai-trader-workspace">
        <section className="ai-trader__hero">
          <div>
            <p className="workspace-hero__eyebrow">AI trading made simple</p>
            <h1>AI Trader</h1>
            <p>
              Connect your broker, choose how much capital the AI may use, then start AI Trading.
              Strategy selection, position sizing and risk checks run automatically on the server.
            </p>
          </div>
          <div className="ai-trader__hero-state">
            <span>AI Trading</span>
            <Badge variant={automationOn ? 'success' : 'info'}>
              {automationOn ? 'RUNNING' : 'STOPPED'}
            </Badge>
            {selectedBroker?.brokerId === 'paper-broker' && (
              <Badge variant="warning">RESEARCH PAPER</Badge>
            )}
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}
        {terminal?.controlWarnings.map((warning) => (
          <Alert key={warning} variant="warning">{warning}</Alert>
        ))}
        {allocationWarning && <Alert variant="warning">{allocationWarning}</Alert>}
        {activityWarning && <Alert variant="warning">{activityWarning}</Alert>}
        {automationRuntimeWarning && <Alert variant="warning">{automationRuntimeWarning}</Alert>}
        {selectedBroker?.brokerId === 'paper-broker' && (
          <Alert variant="info">
            <strong>Research PAPER UAT · simulated execution only.</strong>{' '}
            Accelerated replay may advance multiple simulated market steps per cycle so the
            end-to-end AI, risk, execution, position and P&amp;L workflow can be tested faster.
            No live broker funds are reachable, and model promotion gates remain unchanged.
          </Alert>
        )}

        {loading && !terminal ? (
          <Card title="Loading AI Trader">
            <LoadingSpinner text="Loading broker, allocation and trading activity…" />
          </Card>
        ) : (
          <>
            <section className="ai-control-deck" aria-label="AI trading controls">
              <Card className="ai-control-card ai-control-card--broker">
                <span className="ai-control-card__label">Broker account</span>
                {terminal?.brokers.length ? (
                  <>
                    <select
                      className="input"
                      value={selectedBroker?.id ?? ''}
                      onChange={(event) => void handleBrokerChange(event.target.value)}
                      aria-label="Broker account"
                      disabled={automationOn}
                    >
                      {terminal.brokers.map((broker) => (
                        <option key={broker.id} value={broker.id}>
                          {broker.displayName || broker.brokerName} · {broker.accountType}
                        </option>
                      ))}
                    </select>
                    <div className="ai-control-card__meta">
                      <Badge variant={selectedBroker?.status === 'CONNECTED' ? 'success' : 'warning'}>
                        {selectedBroker?.status ?? 'Not connected'}
                      </Badge>
                      <span>{selectedBroker?.accountType ?? '—'}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <strong>No broker connected</strong>
                    <Link href="/onboarding/broker" className="btn btn--primary btn--sm mt-4">
                      Connect broker
                    </Link>
                  </>
                )}
              </Card>

              <Card className="ai-control-card">
                <span className="ai-control-card__label">Broker equity</span>
                <strong className="ai-control-card__value">
                  {money(allocation?.brokerEquity, allocation?.accountCurrency)}
                </strong>
                <span className="ai-control-card__hint">Authoritative broker account snapshot</span>
              </Card>

              <Card className="ai-control-card ai-control-card--allocation">
                <span className="ai-control-card__label">AI capital allocation</span>
                <div className="ai-allocation-row">
                  <Input
                    aria-label="AI capital allocation amount"
                    inputMode="decimal"
                    value={allocationAmount}
                    onChange={(event) => setAllocationAmount(event.target.value)}
                    placeholder={formatFixedDecimal(allocation?.brokerEquity, 2)}
                    disabled={!selectedBroker || savingAllocation || automationOn}
                  />
                  <Button
                    type="button"
                    size="sm"
                    loading={savingAllocation}
                    disabled={!selectedBroker || automationOn}
                    onClick={() => void saveAllocation()}
                  >
                    Allocate
                  </Button>
                </div>
                <span className="ai-control-card__hint">
                  Shared across multiple AI trades. Available now: {money(allocation?.availableCapital, allocation?.accountCurrency)}
                </span>
              </Card>

              <Card className="ai-control-card ai-control-card--automation">
                <div className="ai-control-card__status-row">
                  <span className="ai-control-card__label">AI Trading</span>
                  <Badge variant={automationOn ? 'success' : 'info'}>
                    {automationOn ? 'Running' : 'Stopped'}
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant={automationOn ? 'danger' : 'primary'}
                  size="lg"
                  block
                  className="ai-automation-action"
                  aria-label={automationOn ? 'Stop AI Trading' : 'Start AI Trading'}
                  disabled={!selectedBroker || !controlStateReady || togglingAutomation}
                  onClick={requestAutomationAction}
                >
                  {togglingAutomation
                    ? automationOn ? 'Stopping…' : 'Starting…'
                    : automationOn ? 'Stop AI Trading' : 'Start AI Trading'}
                </Button>
                <span className="ai-control-card__hint">
                  {automationOn
                    ? 'AI Trading may open and manage positions within your allocation. Stop requires confirmation and closes AI-opened positions.'
                    : 'AI Trading cannot create new positions while stopped.'}
                </span>
              </Card>
            </section>

            <section className="ai-overview-grid">
              <Card className="ai-overview-card ai-overview-card--allocation-pool">
                <span className="ai-control-card__label">AI capital pool</span>
                <strong className="ai-overview-card__value">
                  {money(allocation?.allocatedCapital, allocation?.accountCurrency)}
                </strong>
                <span className="muted text-sm">
                  Shared across multiple trades — each trade commits only its broker-required margin.
                </span>
                <dl className="ai-allocation-breakdown" aria-label="AI capital pool breakdown">
                  <div>
                    <dt>Available</dt>
                    <dd>{money(allocation?.availableCapital, allocation?.accountCurrency)}</dd>
                  </div>
                  <div>
                    <dt>Committed now</dt>
                    <dd>{money(allocation?.committedCapital, allocation?.accountCurrency)}</dd>
                  </div>
                  <div>
                    <dt>Open positions</dt>
                    <dd>{money(allocation?.openPositionCommitments, allocation?.accountCurrency)}</dd>
                  </div>
                  <div>
                    <dt>Pending orders</dt>
                    <dd>{money(allocation?.pendingOrderCommitments, allocation?.accountCurrency)}</dd>
                  </div>
                  <div>
                    <dt>In-flight decisions</dt>
                    <dd>{money(allocation?.inFlightCommitments, allocation?.accountCurrency)}</dd>
                  </div>
                </dl>
              </Card>
              <Card className="ai-overview-card">
                <span className="ai-control-card__label">Open positions</span>
                <strong className="ai-overview-card__value">{livePositions.length}</strong>
                <span className="muted text-sm">Provider-enriched position state</span>
              </Card>
              <Card className="ai-overview-card">
                <span className="ai-control-card__label">AI session</span>
                <strong className="ai-overview-card__value">
                  {!terminal?.sessionStateKnown
                    ? 'UNAVAILABLE'
                    : terminal.session?.status ?? 'STOPPED'}
                </strong>
                <span className="muted text-sm">
                  {!terminal?.sessionStateKnown
                    ? 'Session status is being verified'
                    : terminal.session
                      ? `Started ${formatTimestamp(terminal.session.startedAt)}`
                      : 'Start AI Trading to begin'}
                </span>
              </Card>
              <Card className="ai-overview-card">
                <span className="ai-control-card__label">EURUSD · H1</span>
                <strong className="ai-overview-card__value">{market?.quote.bid ?? '—'}</strong>
                <span className="muted text-sm">
                  {market ? `Spread ${market.quote.spread} · ${market.status}` : 'Market snapshot unavailable'}
                </span>
              </Card>
            </section>

            {automationOn && (
              <section className="ai-runtime-panel" aria-label="AI engine runtime">
                <div className="ai-runtime-panel__heading">
                  <div>
                    <p className="workspace-hero__eyebrow">Automation runtime</p>
                    <h2>AI Engine Monitor</h2>
                  </div>
                  <Badge
                    variant={
                      automationRuntime?.last_decision === 'ERROR'
                        ? 'warning'
                        : automationRuntime?.active && automationRuntime?.registered
                          ? 'success'
                          : automationRuntime?.last_decision === 'BLOCKED'
                          ? 'warning'
                          : 'info'
                    }
                  >
                    {automationRuntime?.last_decision === 'ERROR'
                      ? 'DATA ISSUE'
                      : automationRuntime?.active && automationRuntime?.registered
                        ? 'SCANNING'
                        : automationRuntime?.last_decision === 'BLOCKED'
                        ? 'BLOCKED'
                        : automationRuntime?.enabled
                          ? 'WAITING'
                          : 'OFFLINE'}
                  </Badge>
                </div>

                <div className="ai-runtime-grid">
                  <div>
                    <span>AI engine</span>
                    <strong>{automationRuntime?.enabled ? 'CONNECTED' : 'NOT ACTIVE'}</strong>
                  </div>
                  <div>
                    <span>Signal scheduler</span>
                    <strong>
                      {automationRuntime?.registered && automationRuntime?.active
                        ? 'ACTIVE'
                        : automationRuntime?.last_decision === 'BLOCKED'
                          ? 'BLOCKED'
                          : 'NOT REGISTERED'}
                    </strong>
                  </div>
                  <div>
                    <span>Watching</span>
                    <strong>
                      {automationRuntime?.instruments?.length
                        ? `${automationRuntime.instruments.join(' · ')}${automationRuntime.timeframe ? ` · ${automationRuntime.timeframe}` : ''}`
                        : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>Scan interval</span>
                    <strong>
                      {automationRuntime?.interval_seconds
                        ? `Every ${automationRuntime.interval_seconds}s`
                        : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>Last market scan</span>
                    <strong>{formatTimestamp(automationRuntime?.last_run_at)}</strong>
                  </div>
                  <div>
                    <span>Next scan</span>
                    <strong>{formatTimestamp(automationRuntime?.next_run_at)}</strong>
                  </div>
                  <div>
                    <span>Model</span>
                    <strong>
                      {automationRuntime?.model_version
                        ? `${automationRuntime.model_version} · ${modelModeLabel(automationRuntime.model_mode)}`
                        : 'Awaiting first evaluation'}
                    </strong>
                  </div>
                  <div>
                    <span>Market data</span>
                    <strong className="ai-runtime-market-data">
                      {automationRuntime?.last_market_data_at
                        ? selectedBroker?.brokerId === 'paper-broker'
                          ? (
                            <time dateTime={automationRuntime.last_market_data_at}>
                              Simulated · {formatTimestamp(automationRuntime.last_market_data_at)}
                            </time>
                          )
                          : (
                            <>
                              <time dateTime={automationRuntime.last_market_data_at}>
                                {formatTimestamp(automationRuntime.last_market_data_at)}
                              </time>
                              <small className="ai-runtime-market-data__age">
                                {formatAgeSeconds(automationRuntime.market_data_age_seconds)}
                              </small>
                            </>
                          )
                        : selectedBroker?.brokerId === 'paper-broker'
                          ? 'Awaiting simulated market snapshot'
                          : 'Awaiting first broker snapshot'}
                    </strong>
                  </div>
                  <div>
                    <span>Data read</span>
                    <strong>
                      {automationRuntime?.research_uat
                        ? `Research replay · up to ${automationRuntime.replay_steps_per_cycle ?? 1} market steps/cycle`
                        : selectedBroker?.brokerId === 'paper-broker'
                          ? 'Paper simulator · one heartbeat per scan'
                        : automationRuntime?.market_data_cache_bypassed
                          ? 'Broker queried every scan'
                          : automationRuntime?.source
                            ? `${automationRuntime.source.toUpperCase()} · cache eligible`
                            : '—'}
                    </strong>
                  </div>
                  {automationRuntime?.research_uat && (
                    <>
                      <div>
                        <span>Replay steps</span>
                        <strong>
                          {automationRuntime.replay_steps_last_cycle ?? 0} last cycle ·{' '}
                          {automationRuntime.replay_steps_total ?? 0} total
                        </strong>
                      </div>
                      <div>
                        <span>Qualified AI submissions</span>
                        <strong>{automationRuntime.qualified_signals_published_total ?? 0} submitted</strong>
                      </div>
                      <div>
                        <span>UAT workflow probes</span>
                        <strong>{automationRuntime.uat_probe_signals_published_total ?? 0} submitted</strong>
                      </div>
                      <div>
                        <span>Qualified AI execution</span>
                        <strong>
                          {automationRuntime.qualified_executions_succeeded_total ?? 0} executed ·{' '}
                          {automationRuntime.qualified_downstream_rejected_total ?? 0} rejected
                        </strong>
                      </div>
                      <div>
                        <span>Workflow-probe execution</span>
                        <strong>
                          {automationRuntime.uat_probe_executions_succeeded_total ?? 0} executed ·{' '}
                          {automationRuntime.uat_probe_downstream_rejected_total ?? 0} rejected
                        </strong>
                      </div>
                      <div>
                        <span>Workflow probe status</span>
                        <strong>
                          {(automationRuntime.uat_probe_executions_succeeded_total ?? 0) > 0
                            ? 'COMPLETE · low-confidence probe injection disabled'
                            : 'PENDING · validation probe may run when due'}
                        </strong>
                      </div>
                      <div>
                        <span>Downstream outcome</span>
                        <strong>
                          {automationRuntime.last_strategy_outcome?.replaceAll('_', ' ') ?? 'WAITING'}
                        </strong>
                      </div>
                    </>
                  )}
                  <div>
                    <span>Last decision</span>
                    <strong>{automationRuntime?.last_decision?.replaceAll('_', ' ') ?? 'WAITING'}</strong>
                  </div>
                  <div>
                    <span>Confidence</span>
                    <strong>
                      {automationRuntime?.last_confidence_score == null
                        ? '—'
                        : automationRuntime.last_decision === 'UAT_WORKFLOW_PROBE'
                          ? `${formatConfidence(automationRuntime.last_confidence_score)} actual model confidence · ${formatConfidence(automationRuntime.confidence_threshold)} normal AI gate`
                          : `${formatConfidence(automationRuntime.last_confidence_score)} / ${formatConfidence(automationRuntime.confidence_threshold)} required`}
                    </strong>
                  </div>
                  <div>
                    <span>Confidence evaluated</span>
                    <strong>{formatTimestamp(automationRuntime?.last_confidence_at)}</strong>
                  </div>
                </div>

                {automationRuntime?.research_uat && (
                  <Alert variant="info">
                    Research PAPER UAT can deliberately execute production-ineligible workflow probes
                    below the normal confidence gate, but only on the internal PAPER_ONLY demo broker.
                    These probe trades validate the end-to-end workflow; they are not qualified AI
                    signals. After the first successful workflow-probe execution, further low-confidence
                    probe injection is disabled for that UAT session. Qualified AI and workflow-probe
                    execution counts are shown separately above.
                  </Alert>
                )}

                {automationRuntime?.model_mode === 'heuristic_placeholder' && (
                  <Alert variant="warning">
                    The active model is the baseline heuristic scaffold, not a promoted XGBoost model.
                    In Research PAPER UAT this is used to exercise the product workflow only; simulated
                    trades are not evidence of production trading performance.
                  </Alert>
                )}

                <div className="ai-runtime-reason">
                  <span>Decision explanation</span>
                  <strong>{runtimeReasonLabel(automationRuntime?.last_reason)}</strong>
                </div>
                {automationRuntime?.research_uat && automationRuntime.last_strategy_outcome && (
                  <div className="ai-runtime-reason">
                    <span>Last UAT pipeline result</span>
                    <strong>
                      {automationRuntime.last_strategy_outcome.replaceAll('_', ' ')}
                      {automationRuntime.last_strategy_reason
                        ? ` · ${automationRuntime.last_strategy_reason}`
                        : ''}
                      {automationRuntime.last_trade_id
                        ? ` · trade ${automationRuntime.last_trade_id}`
                        : ''}
                    </strong>
                  </div>
                )}
              </section>
            )}

            <section className="ai-trading-stack">
              <section className="ai-section ai-section--positions ai-section--full" aria-labelledby="open-positions-title">
                <div className="ai-section__heading">
                  <div>
                    <p className="workspace-hero__eyebrow">Live exposure</p>
                    <h2 id="open-positions-title">Open Positions</h2>
                  </div>
                  <div className="ai-section__actions">
                    <div className="ai-view-toggle" role="group" aria-label="Open positions view">
                      <button
                        type="button"
                        className={positionViewMode === 'table' ? 'is-active' : ''}
                        aria-pressed={positionViewMode === 'table'}
                        onClick={() => setPositionViewMode('table')}
                      >
                        Table
                      </button>
                      <button
                        type="button"
                        className={positionViewMode === 'grid' ? 'is-active' : ''}
                        aria-pressed={positionViewMode === 'grid'}
                        onClick={() => setPositionViewMode('grid')}
                      >
                        Grid
                      </button>
                    </div>
                    <Badge variant={livePositions.length ? 'success' : 'info'}>
                      {livePositions.length} open
                    </Badge>
                  </div>
                </div>

                <div className="ai-position-summary" aria-label="Open position performance summary">
                  <div>
                    <span>Total unrealized P&amp;L</span>
                    <strong className={`ai-pnl ai-pnl--${pnlBadge(unrealisedSummary.value)}`}>
                      {unrealisedSummary.mixedCurrencies
                        ? 'Multiple account currencies'
                        : signedMoney(unrealisedSummary.value, unrealisedSummary.currency)}
                    </strong>
                  </div>
                  <div>
                    <span>Broker marks available</span>
                    <strong>{unrealisedSummary.markedCount} / {livePositions.length}</strong>
                  </div>
                  <div>
                    <span>Live performance</span>
                    <strong>Auto-refresh every 3 seconds</strong>
                  </div>
                </div>

                {livePositions.length === 0 ? (
                  <Card className="ai-empty-card">
                    <strong>No open positions</strong>
                    <p className="muted">
                      Current unrealized P&amp;L: {money('0', allocation?.accountCurrency)}. When AI
                      automation opens a trade, entry/current price, SL/TP, costs and live unrealized
                      P&amp;L will appear here.
                    </p>
                  </Card>
                ) : positionViewMode === 'table' ? (
                  <PositionTable positions={livePositions} />
                ) : (
                  <div className="ai-position-grid">
                    {livePositions.map((position) => (
                      <PositionCard key={position.id} position={position} />
                    ))}
                  </div>
                )}
              </section>

              <section className="ai-section ai-section--activity ai-section--full" aria-labelledby="orders-results-title">
                <div className="ai-section__heading">
                  <div>
                    <p className="workspace-hero__eyebrow">Execution history</p>
                    <h2 id="orders-results-title">Orders &amp; Results</h2>
                  </div>
                  <div className="ai-section__actions">
                    <Badge variant={execution?.recentExecutions.length ? 'success' : 'info'}>
                      {execution?.recentExecutions.length ?? 0} recent
                    </Badge>
                    <Link href="/live-account" className="ai-text-link">View all</Link>
                  </div>
                </div>
                {!execution || execution.recentExecutions.length === 0 ? (
                  <Card className="ai-empty-card">
                    <strong>No execution activity yet</strong>
                    <p className="muted">
                      Orders will show status, entry and exit prices, realized profit/loss, costs,
                      close reason and timestamps as the AI trades.
                    </p>
                  </Card>
                ) : (
                  <ExecutionTable trades={execution.recentExecutions.slice(0, 20)} />
                )}
              </section>
            </section>

            <section
              className="ai-section ai-section--closed-trades"
              aria-labelledby="closed-trades-title"
            >
              <div className="ai-section__heading">
                <div>
                  <p className="workspace-hero__eyebrow">Completed positions</p>
                  <h2 id="closed-trades-title">Closed Trades &amp; Realized P&amp;L</h2>
                </div>
                <Badge variant={recentClosedTrades.length ? 'success' : 'info'}>
                  {recentClosedTrades.length} recent
                </Badge>
              </div>
              {recentClosedTrades.length === 0 ? (
                <Card className="ai-empty-card">
                  <strong>No closed trades in the latest execution history</strong>
                  <p className="muted">
                    Closed positions are kept separate here so realized profit or loss cannot be
                    hidden by newer rejected workflow probes.
                  </p>
                </Card>
              ) : (
                <div className="ai-activity-list">
                  {recentClosedTrades.map((trade) => (
                    <ExecutionRow key={trade.id} trade={trade} />
                  ))}
                </div>
              )}
            </section>

            <section className="ai-simple-note" aria-label="Automatic risk protection">
              <div>
                <strong>Automatic risk protection is active</strong>
                <span>
                  There is no fixed trades-per-day cap. The AI may take every qualified opportunity while daily loss, drawdown, concurrent-position, margin, market-safety and kill-switch protections remain enforced by the server.
                </span>
              </div>
              <Link href="/onboarding/risk" className="ai-text-link">View protection</Link>
            </section>
          </>
        )}

        {pendingAutomationAction && (
          <div
            className="ai-confirm-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !togglingAutomation) {
                setPendingAutomationAction(null);
              }
            }}
          >
            <section
              className="ai-confirm-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ai-confirm-title"
              aria-describedby="ai-confirm-description"
            >
              <div className="ai-confirm-dialog__header">
                <span className="ai-control-card__label">
                  {pendingAutomationAction === 'STOP' ? 'Confirmation required' : 'Ready to start'}
                </span>
                <h2 id="ai-confirm-title">
                  {pendingAutomationAction === 'STOP'
                    ? 'Stop AI Trading and close AI positions?'
                    : 'Start AI Trading?'}
                </h2>
              </div>

              <p id="ai-confirm-description" className="ai-confirm-dialog__description">
                {pendingAutomationAction === 'STOP'
                  ? 'Confirming will stop new AI trading first, then immediately request closure of every currently open position that iRexPro can prove was opened by the AI.'
                  : 'Confirm that you want iRexPro AI to begin trading this broker account automatically using the capital you allocated.'}
              </p>

              <div className="ai-confirm-facts" aria-label="AI Trading confirmation details">
                <div>
                  <span>Broker</span>
                  <strong>{connectionLabel(selectedBroker)}</strong>
                </div>
                <div>
                  <span>AI allocation</span>
                  <strong>{money(allocation?.allocatedCapital, allocation?.accountCurrency)}</strong>
                </div>
                <div>
                  <span>Open positions shown</span>
                  <strong>{livePositions.length}</strong>
                </div>
              </div>

              {pendingAutomationAction === 'STOP' ? (
                <Alert variant="warning">
                  <strong>Stopping also closes AI-opened positions.</strong>{' '}
                  Broker market conditions determine the actual exit price. If a broker cannot immediately prove a closure, iRexPro will report it as unresolved/reconciliation pending instead of pretending it is closed.
                </Alert>
              ) : (
                <Alert variant="info">
                  Once started, the AI may open, manage and close positions automatically within your allocation and server-enforced protections until you stop AI Trading.
                </Alert>
              )}

              <div className="ai-confirm-dialog__actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={togglingAutomation}
                  onClick={() => setPendingAutomationAction(null)}
                >
                  {pendingAutomationAction === 'STOP' ? 'Keep AI Trading Running' : 'Cancel'}
                </Button>
                <Button
                  type="button"
                  variant={pendingAutomationAction === 'STOP' ? 'danger' : 'primary'}
                  loading={togglingAutomation}
                  autoFocus
                  onClick={() => void confirmAutomationAction()}
                >
                  {pendingAutomationAction === 'STOP'
                    ? 'Stop & Close AI Positions'
                    : 'Start AI Trading'}
                </Button>
              </div>
            </section>
          </div>
        )}
      </main>
    </DashboardShell>
  );
}
