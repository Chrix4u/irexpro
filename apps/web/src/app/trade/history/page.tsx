'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ClosedTradeOutcomeFilter,
  ClosedTradeReportQuery,
  ClosedTradeReportView,
  TradeExecutionCloseReason,
  TradeExecutionDirection,
  TradeExecutionView,
} from '@irexpro/types/execution';
import { Alert, Badge, Button, Card, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import { mapApiError } from '@/lib/error-mapping';
import { loadClosedTradeReport } from '@/lib/trader-execution';
import './history.css';

type FilterState = {
  fromDate: string;
  toDate: string;
  instrument: string;
  direction: '' | TradeExecutionDirection;
  outcome: ClosedTradeOutcomeFilter;
  closeReason: '' | TradeExecutionCloseReason;
};

const EMPTY_FILTERS: FilterState = {
  fromDate: '',
  toDate: '',
  instrument: '',
  direction: '',
  outcome: 'ALL',
  closeReason: '',
};

const INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'] as const;

const CLOSE_REASONS: TradeExecutionCloseReason[] = [
  'STOP_LOSS_HIT',
  'TAKE_PROFIT_HIT',
  'MANUAL_CLOSE',
  'AI_CLOSE_SIGNAL',
  'PROFIT_PROTECTION',
  'KILL_SWITCH_FORCE_CLOSE',
  'BROKER_CLOSE',
  'STRATEGY_CUTOVER',
  'RECONCILIATION',
];

function localDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDayBoundaryIso(value: string, endOfDay = false): string | undefined {
  if (!value) return undefined;
  const suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  const parsed = new Date(`${value}${suffix}`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function formatFixedDecimal(
  value: string | null | undefined,
  fractionDigits = 2,
): string {
  if (value == null || value === '') return '—';
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
  if ((paddedFraction[fractionDigits] ?? '0') >= '5') scaled += 1n;

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

function signedMoney(value: string | null | undefined, currency: string | null | undefined): string {
  if (value == null) return '—';
  const formatted = money(value, currency);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || formatted === '—') return formatted;
  return `+${formatted}`;
}

function lossMoney(value: string | null | undefined, currency: string | null | undefined): string {
  if (value == null) return '—';
  const normalized = value.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return money(value, currency);
  if (/^[+-]?0(?:\.0+)?$/.test(normalized)) return money('0', currency);
  return money(normalized.startsWith('-') ? normalized : `-${normalized.replace(/^\+/, '')}`, currency);
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function formatHoldTime(trade: TradeExecutionView): string {
  if (!trade.openedAt || !trade.closedAt) return '—';
  const start = Date.parse(trade.openedAt);
  const end = Date.parse(trade.closedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const totalMinutes = Math.round((end - start) / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatAverageHold(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function labelize(value: string | null | undefined): string {
  if (!value) return 'Not reported';
  return value.replaceAll('_', ' ').toLowerCase();
}

function pnlTone(value: string | null | undefined): 'positive' | 'negative' | 'neutral' {
  if (value == null) return 'neutral';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return 'neutral';
  return numeric > 0 ? 'positive' : 'negative';
}

function TradePnl({ trade }: { trade: TradeExecutionView }) {
  const tone = pnlTone(trade.realisedPnl);
  return (
    <strong className={`history-pnl history-pnl--${tone}`}>
      {trade.realisedPnl == null
        ? 'Unavailable'
        : signedMoney(trade.realisedPnl, trade.accountCurrency)}
    </strong>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'positive' | 'negative' | 'neutral';
}) {
  return (
    <article className={`history-summary-card history-summary-card--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export default function ClosedTradeHistoryPage() {
  const { user, logout, restoring } = useAuth();
  const [queryReady, setQueryReady] = useState(false);
  const [brokerConnectionId, setBrokerConnectionId] = useState('');
  const [draft, setDraft] = useState<FilterState>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<FilterState>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [report, setReport] = useState<ClosedTradeReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setBrokerConnectionId(params.get('brokerConnectionId') ?? '');
    setQueryReady(true);
  }, []);

  const query = useMemo<ClosedTradeReportQuery>(() => ({
    page,
    pageSize,
    brokerConnectionId: brokerConnectionId || undefined,
    from: localDayBoundaryIso(applied.fromDate, false),
    to: localDayBoundaryIso(applied.toDate, true),
    instrument: applied.instrument.trim() || undefined,
    direction: applied.direction || undefined,
    outcome: applied.outcome,
    closeReason: applied.closeReason || undefined,
  }), [applied, brokerConnectionId, page, pageSize]);

  const refresh = useCallback(async (initial = false) => {
    if (!user || !queryReady) return;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      setReport(await loadClosedTradeReport(query));
    } catch (requestError) {
      setError(mapApiError(requestError).message);
      setReport(null);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }, [query, queryReady, user]);

  useEffect(() => {
    if (!user || !queryReady) return;
    void refresh(true);
  }, [refresh, queryReady, user]);

  function applyFilters() {
    setPage(1);
    setApplied({ ...draft, instrument: draft.instrument.trim().toUpperCase() });
  }

  function clearFilters() {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  }

  function applyRecentDays(days: number) {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - Math.max(0, days - 1));
    const next = {
      ...draft,
      fromDate: localDateInputValue(from),
      toDate: localDateInputValue(now),
    };
    setDraft(next);
    setApplied({ ...next, instrument: next.instrument.trim().toUpperCase() });
    setPage(1);
  }

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring closed-trade history…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 680, margin: '0 auto' }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to view closed-trade history and realized results.</p>
          <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
        </Card>
      </div>
    );
  }

  const summary = report?.summary ?? null;
  const currency = summary?.accountCurrency ?? null;
  const netTone = pnlTone(summary?.netRealisedPnl);
  const firstRow = report && report.total > 0 ? (report.page - 1) * report.pageSize + 1 : 0;
  const lastRow = report ? Math.min(report.page * report.pageSize, report.total) : 0;
  const hasMixedCurrencies = (summary?.currencyBreakdown.length ?? 0) > 1;
  const profitFactorLabel = summary
    ? Number(summary.grossLoss) === 0 && Number(summary.grossProfit) > 0
      ? '∞'
      : summary.profitFactor == null
        ? '—'
        : summary.profitFactor.toFixed(2)
    : '—';

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/trade/history" title="Reports">
      <main className="trade-history" data-testid="closed-trade-history">
        <section className="trade-history__hero">
          <div>
            <p className="workspace-hero__eyebrow">Realized results</p>
            <h1>Closed Trade History</h1>
            <p>
              Audit every completed AI trade and analyze realized profit, loss, costs and trade
              quality across the exact filters you select.
            </p>
          </div>
          <div className="trade-history__hero-actions">
            {brokerConnectionId ? <Badge variant="info">Selected broker account</Badge> : <Badge variant="info">All broker accounts</Badge>}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={refreshing}
              disabled={loading || refreshing}
              onClick={() => void refresh(false)}
            >
              Refresh
            </Button>
            <Link href="/trade" className="btn btn--ghost btn--sm">Back to AI Trading</Link>
          </div>
        </section>

        {brokerConnectionId && (
          <Alert variant="info">
            This report is scoped to the broker account selected on the AI Trading page.{' '}
            <button
              type="button"
              className="history-inline-action"
              onClick={() => {
                setBrokerConnectionId('');
                setPage(1);
              }}
            >
              Show all broker accounts
            </button>
          </Alert>
        )}

        {error && <Alert variant="error">{error}</Alert>}

        <section className="history-filter-panel" aria-label="Closed trade filters">
          <div className="history-filter-panel__head">
            <div>
              <span>Filters</span>
              <small>Totals below always cover the entire filtered result.</small>
            </div>
            <div className="history-preset-actions">
              <button type="button" onClick={() => applyRecentDays(7)}>7 days</button>
              <button type="button" onClick={() => applyRecentDays(30)}>30 days</button>
              <button type="button" onClick={clearFilters}>All time</button>
            </div>
          </div>
          <div className="history-filter-grid">
            <label>
              <span>From date</span>
              <input
                className="input"
                type="date"
                value={draft.fromDate}
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => setDraft((current) => ({ ...current, fromDate: event.target.value }))}
              />
            </label>
            <label>
              <span>To date</span>
              <input
                className="input"
                type="date"
                value={draft.toDate}
                onClick={(event) => event.currentTarget.showPicker?.()}
                onChange={(event) => setDraft((current) => ({ ...current, toDate: event.target.value }))}
              />
            </label>
            <label>
              <span>Instrument</span>
              <select
                className="input"
                value={draft.instrument}
                onChange={(event) => setDraft((current) => ({ ...current, instrument: event.target.value }))}
              >
                <option value="">All instruments</option>
                {INSTRUMENTS.map((instrument) => (
                  <option key={instrument} value={instrument}>{instrument}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Side</span>
              <select
                className="input"
                value={draft.direction}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  direction: event.target.value as FilterState['direction'],
                }))}
              >
                <option value="">All sides</option>
                <option value="BUY">Buy</option>
                <option value="SELL">Sell</option>
              </select>
            </label>
            <label>
              <span>Outcome</span>
              <select
                className="input"
                value={draft.outcome}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  outcome: event.target.value as ClosedTradeOutcomeFilter,
                }))}
              >
                <option value="ALL">All outcomes</option>
                <option value="WIN">Profit only</option>
                <option value="LOSS">Loss only</option>
                <option value="FLAT">Flat only</option>
              </select>
            </label>
            <label>
              <span>Close reason</span>
              <select
                className="input"
                value={draft.closeReason}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  closeReason: event.target.value as FilterState['closeReason'],
                }))}
              >
                <option value="">All close reasons</option>
                {CLOSE_REASONS.map((reason) => (
                  <option key={reason} value={reason}>{labelize(reason)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="history-filter-actions">
            <Button type="button" variant="primary" size="sm" onClick={applyFilters}>Apply filters</Button>
            <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>Clear</Button>
          </div>
        </section>

        {loading && !report ? (
          <Card title="Loading closed trades">
            <LoadingSpinner text="Loading realized results and report totals…" />
          </Card>
        ) : report ? (
          <>
            {summary?.unresolvedPnlCount ? (
              <Alert variant="warning">
                {summary.unresolvedPnlCount} closed trade{summary.unresolvedPnlCount === 1 ? '' : 's'} in this result do not have complete currency-bound realized P&amp;L yet. Money totals show only authoritative currency-bound values.
              </Alert>
            ) : null}

            <section className="history-summary-grid" aria-label="Filtered realized results">
              <SummaryCard
                label={summary?.unresolvedPnlCount ? 'Known gross profit' : 'Gross profit'}
                value={signedMoney(summary?.grossProfit, currency)}
                detail={`${summary?.wins ?? 0} profitable trade${summary?.wins === 1 ? '' : 's'}`}
                tone="positive"
              />
              <SummaryCard
                label={summary?.unresolvedPnlCount ? 'Known gross loss' : 'Gross loss'}
                value={lossMoney(summary?.grossLoss, currency)}
                detail={`${summary?.losses ?? 0} losing trade${summary?.losses === 1 ? '' : 's'}`}
                tone="negative"
              />
              <SummaryCard
                label={summary?.unresolvedPnlCount ? 'Known net P&L' : 'Net P&L'}
                value={signedMoney(summary?.netRealisedPnl, currency)}
                detail={hasMixedCurrencies ? 'See currency breakdown below' : 'Profit minus realized losses'}
                tone={netTone}
              />
              <SummaryCard
                label="Closed trades"
                value={String(summary?.totalTrades ?? 0)}
                detail={`${summary?.wins ?? 0}W / ${summary?.losses ?? 0}L / ${summary?.flats ?? 0} flat`}
              />
            </section>

            {hasMixedCurrencies && summary && (
              <section className="history-currency-breakdown" aria-label="Currency breakdown">
                <div>
                  <strong>Currency breakdown</strong>
                  <span>Money totals are intentionally separated rather than mixing currencies.</span>
                </div>
                <div className="history-currency-breakdown__grid">
                  {summary.currencyBreakdown.map((item) => (
                    <article key={item.accountCurrency}>
                      <b>{item.accountCurrency}</b>
                      <span>Profit {signedMoney(item.grossProfit, item.accountCurrency)}</span>
                      <span>Loss {lossMoney(item.grossLoss, item.accountCurrency)}</span>
                      <span>Net {signedMoney(item.netRealisedPnl, item.accountCurrency)}</span>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="history-quality-grid" aria-label="Trade quality report">
              <div><span>Win rate</span><strong>{summary?.winRate == null ? '—' : `${(summary.winRate * 100).toFixed(1)}%`}</strong></div>
              <div><span>Profit factor</span><strong>{profitFactorLabel}</strong></div>
              <div><span>Average win</span><strong className="is-positive">{signedMoney(summary?.averageWin, currency)}</strong></div>
              <div><span>Average loss</span><strong className="is-negative">{lossMoney(summary?.averageLoss, currency)}</strong></div>
              <div><span>Expectancy / trade</span><strong className={pnlTone(summary?.expectancyPerTrade) === 'negative' ? 'is-negative' : pnlTone(summary?.expectancyPerTrade) === 'positive' ? 'is-positive' : ''}>{signedMoney(summary?.expectancyPerTrade, currency)}</strong></div>
              <div><span>Largest win</span><strong className="is-positive">{signedMoney(summary?.largestWin, currency)}</strong></div>
              <div><span>Largest loss</span><strong className="is-negative">{signedMoney(summary?.largestLoss, currency)}</strong></div>
              <div><span>Commission</span><strong>{money(summary?.totalCommission, currency)}</strong></div>
              <div><span>Swap / financing</span><strong>{signedMoney(summary?.totalSwap, currency)}</strong></div>
              <div><span>Average hold</span><strong>{formatAverageHold(summary?.averageHoldMinutes ?? null)}</strong></div>
            </section>

            <section className="history-table-card" aria-labelledby="closed-trade-table-title">
              <div className="history-table-card__head">
                <div>
                  <p className="workspace-hero__eyebrow">Completed positions</p>
                  <h2 id="closed-trade-table-title">Closed Trades</h2>
                  <span>{firstRow}-{lastRow} of {report.total}</span>
                </div>
                <label className="history-page-size">
                  <span>Rows</span>
                  <select
                    className="input"
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
              </div>

              {report.trades.length === 0 ? (
                <Card className="history-empty">
                  <strong>No closed trades match these filters</strong>
                  <p className="muted">Change the date range or filters to widen the report.</p>
                </Card>
              ) : (
                <div className="history-table-wrap">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>Closed</th>
                        <th>Instrument</th>
                        <th>Side</th>
                        <th>Lot</th>
                        <th>Entry</th>
                        <th>Exit</th>
                        <th>Realized P&amp;L</th>
                        <th>Commission</th>
                        <th>Swap</th>
                        <th>Close reason</th>
                        <th>Hold</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.trades.map((trade) => (
                        <tr key={trade.id}>
                          <td>{formatTimestamp(trade.closedAt)}</td>
                          <td><strong>{trade.instrument}</strong></td>
                          <td><Badge variant={trade.direction === 'BUY' ? 'success' : 'warning'}>{trade.direction}</Badge></td>
                          <td>{formatFixedDecimal(trade.lotSize, 2)}</td>
                          <td>{formatFixedDecimal(trade.fillPrice ?? trade.requestedEntryPrice, 5)}</td>
                          <td>{formatFixedDecimal(trade.exitPrice, 5)}</td>
                          <td><TradePnl trade={trade} /></td>
                          <td>{money(trade.commission, trade.accountCurrency)}</td>
                          <td>{signedMoney(trade.swap, trade.accountCurrency)}</td>
                          <td className="history-table__reason">{labelize(trade.closeReason)}</td>
                          <td>{formatHoldTime(trade)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="history-pagination">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={report.page <= 1 || loading}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </Button>
                <span>Page {report.page} of {Math.max(report.totalPages, 1)}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={report.totalPages === 0 || report.page >= report.totalPages || loading}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </DashboardShell>
  );
}
