'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UserCapitalAllocationView, TradeExecutionView } from '@irexpro/types/execution';
import type { LivePositionRowView } from '@irexpro/types/live-account';
import type { MarketIntelligenceView } from '@irexpro/types/market-intelligence';
import { Alert, Badge, Button, Card, DashboardShell, Input, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { useNotification } from '@/hooks/useNotification';
import { api } from '@/lib/api';
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

function money(value: string | null | undefined, currency: string | null | undefined): string {
  if (!value) return '—';
  return currency ? `${value} ${currency}` : value;
}

function pnlBadge(value: string | null): 'success' | 'error' | 'info' {
  if (!value) return 'info';
  if (value.startsWith('-')) return 'error';
  if (value === '0' || /^0(?:\.0+)?$/.test(value)) return 'info';
  return 'success';
}

function connectionLabel(broker: TerminalBrokerView | null): string {
  if (!broker) return 'No broker connected';
  return broker.displayName || broker.brokerName;
}

function PositionCard({ position }: { position: LivePositionRowView }) {
  return (
    <article className="ai-position-card">
      <div className="ai-position-card__head">
        <div>
          <strong>{position.instrument}</strong>
          <span>{position.direction} · {position.lotSize} lot</span>
        </div>
        <Badge variant={pnlBadge(position.unrealisedPnl)}>
          {position.unrealisedPnl === null
            ? 'P&L awaiting broker'
            : `${position.unrealisedPnl.startsWith('-') ? '' : '+'}${money(position.unrealisedPnl, position.accountCurrency)}`}
        </Badge>
      </div>
      <dl className="ai-trade-metrics">
        <div><dt>Entry</dt><dd>{position.fillPrice ?? position.requestedEntryPrice}</dd></div>
        <div><dt>Current</dt><dd>{position.currentPrice ?? 'Awaiting broker mark'}</dd></div>
        <div><dt>Stop loss</dt><dd>{position.stopLoss}</dd></div>
        <div><dt>Take profit</dt><dd>{position.takeProfit}</dd></div>
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
            {realized.startsWith('-') ? '' : '+'}{money(realized, trade.accountCurrency)}
          </Badge>
        )}
      </div>
      <div className="ai-activity-row__time">
        {formatTimestamp(trade.closedAt ?? trade.openedAt ?? trade.createdAt)}
      </div>
    </article>
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
  const [error, setError] = useState<string | null>(null);

  const initializedActivity = useRef(false);
  const seenPositionIds = useRef<Set<string>>(new Set());
  const seenExecutionStates = useRef<Map<string, string>>(new Map());

  const selectedBroker = useMemo(
    () => terminal?.brokers.find((broker) => broker.id === selectedBrokerId) ?? terminal?.primaryBroker ?? null,
    [terminal, selectedBrokerId],
  );

  const automationOn =
    terminal?.session?.status === 'ACTIVE' || terminal?.session?.status === 'PAUSED';

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
      const [status, snapshot, positionSnapshot] = await Promise.all([
        loadTraderTerminalStatus(),
        loadTraderExecutionSnapshot(),
        loadLiveAccountPositions(),
      ]);
      setTerminal(status);
      setExecution(snapshot);
      setLivePositions(positionSnapshot.positions);
      emitActivityToasts(positionSnapshot.positions, snapshot);

      const brokerId =
        selectedBrokerId ||
        status.sessionBroker?.id ||
        status.primaryBroker?.id ||
        '';
      if (brokerId) {
        setSelectedBrokerId((current) => current || brokerId);
        try {
          const nextAllocation = await api.getCapitalAllocation(brokerId);
          setAllocation(nextAllocation);
          if (nextAllocation.allocatedCapital) {
            setAllocationAmount(nextAllocation.allocatedCapital);
          }
        } catch (requestError) {
          setAllocation(null);
          if (showSpinner) setError(mapApiError(requestError).message);
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

  async function handleBrokerChange(nextId: string) {
    setSelectedBrokerId(nextId);
    setAllocation(null);
    setAllocationAmount('');
    try {
      const nextAllocation = await api.getCapitalAllocation(nextId);
      setAllocation(nextAllocation);
      setAllocationAmount(nextAllocation.allocatedCapital ?? '');
    } catch (requestError) {
      setError(mapApiError(requestError).message);
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

  async function toggleAutomation() {
    if (!selectedBroker) {
      notify.warning('Connect a broker account first.');
      return;
    }
    setTogglingAutomation(true);
    setError(null);
    try {
      if (automationOn && terminal?.session) {
        await api.stopTradingSession(terminal.session.id);
        notify.info('AI automation turned off.');
      } else {
        if (!allocation?.hasAllocation || !allocation.allocatedCapital) {
          notify.warning('Allocate capital before turning on AI automation.');
          return;
        }
        const executionMode = selectedBroker.accountType === 'LIVE' ? 'FULL_AUTO' : 'PAPER_ONLY';
        await api.startTradingSession({
          brokerConnectionId: selectedBroker.id,
          executionMode,
        });
        notify.success(
          selectedBroker.accountType === 'LIVE'
            ? 'AI automation turned on for the verified live account.'
            : 'AI automation turned on in paper/demo mode.',
        );
      }
      await refreshTradingData(false);
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setTogglingAutomation(false);
    }
  }

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
              Connect your broker, choose how much capital the AI may use, then turn automation on.
              Strategy selection, position sizing and risk checks run automatically on the server.
            </p>
          </div>
          <div className="ai-trader__hero-state">
            <span>AI Automation</span>
            <Badge variant={automationOn ? 'success' : 'info'}>
              {automationOn ? 'ON' : 'OFF'}
            </Badge>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}

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
                    placeholder={allocation?.brokerEquity ?? '0.00'}
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
                  Available to new positions: {money(allocation?.availableCapital, allocation?.accountCurrency)}
                </span>
              </Card>

              <Card className="ai-control-card ai-control-card--automation">
                <span className="ai-control-card__label">AI automation</span>
                <button
                  type="button"
                  className={`ai-toggle${automationOn ? ' ai-toggle--on' : ''}`}
                  aria-pressed={automationOn}
                  aria-label={automationOn ? 'Turn AI automation off' : 'Turn AI automation on'}
                  disabled={!selectedBroker || togglingAutomation}
                  onClick={() => void toggleAutomation()}
                >
                  <span className="ai-toggle__track"><span className="ai-toggle__thumb" /></span>
                  <span>{togglingAutomation ? 'Updating…' : automationOn ? 'ON' : 'OFF'}</span>
                </button>
                <span className="ai-control-card__hint">
                  {automationOn
                    ? 'The AI may create new exposure within your allocation and server protections.'
                    : 'No new AI exposure is authorized while automation is off.'}
                </span>
              </Card>
            </section>

            <section className="ai-overview-grid">
              <Card className="ai-overview-card">
                <span className="ai-control-card__label">Allocated capital</span>
                <strong className="ai-overview-card__value">
                  {money(allocation?.allocatedCapital, allocation?.accountCurrency)}
                </strong>
                <span className="muted text-sm">
                  Committed: {money(allocation?.committedCapital, allocation?.accountCurrency)}
                </span>
              </Card>
              <Card className="ai-overview-card">
                <span className="ai-control-card__label">Open positions</span>
                <strong className="ai-overview-card__value">{livePositions.length}</strong>
                <span className="muted text-sm">Provider-enriched position state</span>
              </Card>
              <Card className="ai-overview-card">
                <span className="ai-control-card__label">AI session</span>
                <strong className="ai-overview-card__value">
                  {terminal?.session?.status ?? 'OFF'}
                </strong>
                <span className="muted text-sm">
                  {terminal?.session ? `Started ${formatTimestamp(terminal.session.startedAt)}` : 'Turn automation on to start'}
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

            <section className="ai-trading-grid">
              <section className="ai-section ai-section--positions" aria-labelledby="open-positions-title">
                <div className="ai-section__heading">
                  <div>
                    <p className="workspace-hero__eyebrow">Live exposure</p>
                    <h2 id="open-positions-title">Open Positions</h2>
                  </div>
                  <Badge variant={livePositions.length ? 'success' : 'info'}>
                    {livePositions.length} open
                  </Badge>
                </div>
                {livePositions.length === 0 ? (
                  <Card className="ai-empty-card">
                    <strong>No open positions</strong>
                    <p className="muted">
                      When AI automation opens a trade, the symbol, direction, current price and unrealized P&amp;L will appear here.
                    </p>
                  </Card>
                ) : (
                  <div className="ai-position-grid">
                    {livePositions.map((position) => (
                      <PositionCard key={position.id} position={position} />
                    ))}
                  </div>
                )}
              </section>

              <section className="ai-section ai-section--activity" aria-labelledby="recent-ai-activity-title">
                <div className="ai-section__heading">
                  <div>
                    <p className="workspace-hero__eyebrow">Orders & results</p>
                    <h2 id="recent-ai-activity-title">Recent AI Activity</h2>
                  </div>
                  <Link href="/live-account" className="ai-text-link">View all</Link>
                </div>
                {!execution || execution.recentExecutions.length === 0 ? (
                  <Card className="ai-empty-card">
                    <strong>No execution activity yet</strong>
                    <p className="muted">
                      Orders, fills, closed positions and realized P&amp;L will appear here as the AI trades.
                    </p>
                  </Card>
                ) : (
                  <div className="ai-activity-list">
                    {execution.recentExecutions.slice(0, 10).map((trade) => (
                      <ExecutionRow key={trade.id} trade={trade} />
                    ))}
                  </div>
                )}
              </section>
            </section>

            <section className="ai-simple-note" aria-label="Automatic risk protection">
              <div>
                <strong>Automatic risk protection is active</strong>
                <span>
                  Daily loss, drawdown, position limits, market safety and kill-switch checks are handled by the server. You do not need to configure them.
                </span>
              </div>
              <Link href="/onboarding/risk" className="ai-text-link">View protection</Link>
            </section>
          </>
        )}
      </main>
    </DashboardShell>
  );
}
