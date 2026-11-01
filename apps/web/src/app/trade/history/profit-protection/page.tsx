'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, DashboardShell, LoadingSpinner } from '@/components/ui';
import { useAuth } from '@/context/auth-context';
import {
  loadProfitProtectionExitQuality,
  type ProfitProtectionExitQualityOutcome,
  type ProfitProtectionExitQualityQuery,
  type ProfitProtectionExitQualityReport,
  type ProfitProtectionStrategyRoute,
} from '@/lib/profit-protection-exit-quality';
import '../history.css';
import './profit-protection.css';

const INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'] as const;
const ROUTES: ProfitProtectionStrategyRoute[] = [
  'CONFIRMED_REVERSAL',
  'EARLY_TRANSITION',
  'TREND_CONTINUATION',
  'UNKNOWN',
];
const OUTCOMES: ProfitProtectionExitQualityOutcome[] = [
  'TP_FIRST',
  'SL_FIRST',
  'AMBIGUOUS_SAME_M1',
  'NEITHER_4H',
  'DATA_GAP',
];

type Filters = {
  fromDate: string;
  toDate: string;
  instrument: string;
  direction: '' | 'BUY' | 'SELL';
  strategyRoute: '' | ProfitProtectionStrategyRoute;
  outcome: '' | ProfitProtectionExitQualityOutcome;
  smallProfitOnly: boolean;
};

const EMPTY_FILTERS: Filters = {
  fromDate: '',
  toDate: '',
  instrument: '',
  direction: '',
  strategyRoute: '',
  outcome: '',
  smallProfitOnly: false,
};

function localDayBoundaryIso(value: string, endOfDay = false): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}${endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'}`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function routeLabel(route: ProfitProtectionStrategyRoute): string {
  if (route === 'UNKNOWN') return 'Unknown';
  return route
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function outcomeLabel(outcome: ProfitProtectionExitQualityOutcome): string {
  const labels: Record<ProfitProtectionExitQualityOutcome, string> = {
    TP_FIRST: 'TP first',
    SL_FIRST: 'SL first',
    AMBIGUOUS_SAME_M1: 'Ambiguous same M1',
    NEITHER_4H: 'Neither in 4h',
    DATA_GAP: 'Data gap',
  };
  return labels[outcome];
}

function rate(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function rValue(value: number | null, signed = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}R`;
}

function money(value: string | null, currency: string | null): string {
  if (value == null) return '—';
  const numeric = Number(value);
  const formatted = Number.isFinite(numeric)
    ? numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value;
  return currency ? `${formatted} ${currency}` : formatted;
}

function timestamp(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
    : '—';
}

function minutes(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 60) return `${Math.round(value)}m`;
  const hours = Math.floor(value / 60);
  const remainder = Math.round(value % 60);
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export default function ProfitProtectionExitQualityPage() {
  const { user, logout, restoring } = useAuth();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [report, setReport] = useState<ProfitProtectionExitQualityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo<ProfitProtectionExitQualityQuery>(() => ({
    from: localDayBoundaryIso(filters.fromDate),
    to: localDayBoundaryIso(filters.toDate, true),
    instrument: filters.instrument || undefined,
    direction: filters.direction || undefined,
    strategyRoute: filters.strategyRoute || undefined,
    outcome: filters.outcome || undefined,
    smallProfitOnly: filters.smallProfitOnly,
    page,
    pageSize,
  }), [filters, page, pageSize]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await loadProfitProtectionExitQuality(query));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Exit-quality evidence could not be loaded.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [query, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draft });
  };

  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  if (restoring) {
    return <div style={{ padding: '3rem' }}><LoadingSpinner text="Restoring exit-quality report…" /></div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '3rem', maxWidth: 680, margin: '0 auto' }}>
        <p>Sign in to view Profit Protection exit-quality research.</p>
        <Link href="/login" className="btn btn--primary mt-4">Go to login</Link>
      </div>
    );
  }

  const summary = report?.summary;

  return (
    <DashboardShell user={user} onLogout={logout} activeRoute="/trade/history" title="Reports">
      <div className="trade-history exit-quality-report">
        <section className="trade-history__hero">
          <div>
            <p className="workspace-hero__eyebrow">Execution research</p>
            <h1>Profit Protection Exit Quality</h1>
            <p>
              See what happened after the AI protected profit: whether the original target or stop
              was reached first, how long it took, and the theoretical R opportunity left behind.
            </p>
          </div>
          <div className="trade-history__hero-actions">
            <Link className="button button--secondary" href="/trade/history">
              Closed Trade History
            </Link>
            <Button type="button" onClick={() => void load()} disabled={loading}>
              Refresh
            </Button>
          </div>
        </section>

        <div className="exit-quality-report__research-note" role="note">
          <strong>Research evidence, not realised returns.</strong>{' '}
          TP/SL-after-exit outcomes are counterfactual broker-candle observations. Actual realised
          P&amp;L remains the authoritative financial result; theoretical R excludes later execution
          costs and slippage.
        </div>

        <form className="history-filter-panel" onSubmit={applyFilters}>
          <div className="history-filter-panel__head">
            <div>
              <span>Evidence filters</span>
              <small>All calculations and filtering are performed by the server.</small>
            </div>
          </div>
          <div className="history-filter-grid exit-quality-report__filters">
            <label>
              <span>From</span>
              <input type="date" value={draft.fromDate} onChange={(e) => setDraft((current) => ({ ...current, fromDate: e.target.value }))} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={draft.toDate} onChange={(e) => setDraft((current) => ({ ...current, toDate: e.target.value }))} />
            </label>
            <label>
              <span>Instrument</span>
              <select value={draft.instrument} onChange={(e) => setDraft((current) => ({ ...current, instrument: e.target.value }))}>
                <option value="">All</option>
                {INSTRUMENTS.map((instrument) => <option key={instrument} value={instrument}>{instrument}</option>)}
              </select>
            </label>
            <label>
              <span>Direction</span>
              <select value={draft.direction} onChange={(e) => setDraft((current) => ({ ...current, direction: e.target.value as Filters['direction'] }))}>
                <option value="">All</option>
                <option value="BUY">Buy</option>
                <option value="SELL">Sell</option>
              </select>
            </label>
            <label>
              <span>Route</span>
              <select value={draft.strategyRoute} onChange={(e) => setDraft((current) => ({ ...current, strategyRoute: e.target.value as Filters['strategyRoute'] }))}>
                <option value="">All</option>
                {ROUTES.map((route) => <option key={route} value={route}>{routeLabel(route)}</option>)}
              </select>
            </label>
            <label>
              <span>Outcome</span>
              <select value={draft.outcome} onChange={(e) => setDraft((current) => ({ ...current, outcome: e.target.value as Filters['outcome'] }))}>
                <option value="">All</option>
                {OUTCOMES.map((outcome) => <option key={outcome} value={outcome}>{outcomeLabel(outcome)}</option>)}
              </select>
            </label>
          </div>
          <div className="history-filter-actions exit-quality-report__filter-actions">
            <label className="exit-quality-report__checkbox">
              <input
                type="checkbox"
                checked={draft.smallProfitOnly}
                onChange={(e) => setDraft((current) => ({ ...current, smallProfitOnly: e.target.checked }))}
              />
              <span>Small profits only (0–6)</span>
            </label>
            <Button type="submit">Apply filters</Button>
            <Button type="button" onClick={clearFilters}>Clear</Button>
          </div>
        </form>

        {error ? <Alert>{error}</Alert> : null}
        {loading && !report ? <LoadingSpinner /> : null}

        {report && summary ? (
          <>
            <section className="history-summary-grid exit-quality-report__summary">
              <article className="history-summary-card">
                <span>Evaluated exits</span>
                <strong>{summary.total} evaluated</strong>
                <small>{summary.resolvedCount} have a resolved TP/SL barrier order.</small>
              </article>
              <article className="history-summary-card history-summary-card--positive">
                <span>TP later</span>
                <strong>{rate(summary.tpFirstRate)}</strong>
                <small>{summary.tpFirstCount} reached original TP before original SL.</small>
              </article>
              <article className="history-summary-card history-summary-card--negative">
                <span>SL later</span>
                <strong>{rate(summary.slFirstRate)}</strong>
                <small>{summary.slFirstCount} reached original SL first.</small>
              </article>
              <article className="history-summary-card history-summary-card--positive">
                <span>Small wins → TP</span>
                <strong>{summary.smallProfitTpFirstCount} of {summary.smallProfitCount}</strong>
                <small>{rate(summary.smallProfitTpFirstRate)} of small protected wins later hit TP first.</small>
              </article>
              <article className="history-summary-card">
                <span>Average R delta</span>
                <strong>{rValue(summary.averageRDelta, true)}</strong>
                <small>Theoretical post-exit barrier R minus actual exit R.</small>
              </article>
            </section>

            <section className="history-quality-grid">
              <div><span>Actual exit R</span><strong>{rValue(summary.averageActualExitR)}</strong></div>
              <div><span>Counterfactual R</span><strong>{rValue(summary.averageCounterfactualR)}</strong></div>
              <div><span>Ambiguous</span><strong>{summary.ambiguousCount}</strong></div>
              <div><span>Neither in 4h</span><strong>{summary.neitherCount}</strong></div>
              <div><span>Data gaps</span><strong>{summary.dataGapCount}</strong></div>
            </section>

            {summary.currencyBreakdown.length > 0 ? (
              <section className="history-currency-breakdown">
                <div>
                  <strong>Actual realised P&amp;L by account currency</strong>
                  <span>Monetary results are never summed across currencies.</span>
                </div>
                <div className="history-currency-breakdown__grid">
                  {summary.currencyBreakdown.map((currency) => (
                    <article key={currency.accountCurrency}>
                      <strong>{money(currency.actualRealisedPnl, currency.accountCurrency)}</strong>
                      <span>{currency.tradeCount} evaluated exits</span>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="history-table-card">
              <div className="history-table-card__head">
                <div>
                  <h2>Route evidence</h2>
                  <span>Resolved barrier outcomes grouped by originating strategy route.</span>
                </div>
              </div>
              <div className="history-table-wrap">
                <table className="history-table exit-quality-report__route-table">
                  <thead><tr><th>Route</th><th>Evaluated</th><th>TP first</th><th>SL first</th><th>TP-first share</th></tr></thead>
                  <tbody>
                    {report.routes.map((route) => (
                      <tr key={route.strategyRoute}>
                        <td>{routeLabel(route.strategyRoute)}</td>
                        <td>{route.total}</td>
                        <td>{route.tpFirstCount}</td>
                        <td>{route.slFirstCount}</td>
                        <td>{route.tpFirstRate == null ? '—' : `${Math.round(route.tpFirstRate * 100)}% TP-first`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="history-table-card">
              <div className="history-table-card__head">
                <div>
                  <h2>Exit-level evidence</h2>
                  <span>{report.total} filtered Profit Protection exits.</span>
                </div>
                <label className="history-page-size">
                  <span>Rows</span>
                  <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
              </div>
              <div className="history-table-wrap">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Closed</th><th>Pair</th><th>Side</th><th>Route</th><th>Actual P&amp;L</th>
                      <th>Exit R</th><th>Later outcome</th><th>Time after exit</th><th>CF R</th><th>R delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.items.length ? report.items.map((item) => (
                      <tr key={item.tradeId}>
                        <td>{timestamp(item.closedAt)}</td>
                        <td>{item.instrument}</td>
                        <td>{item.direction}</td>
                        <td>{routeLabel(item.strategyRoute)}</td>
                        <td>{money(item.realisedPnl, item.accountCurrency)}</td>
                        <td>{rValue(item.actualExitR)}</td>
                        <td>{outcomeLabel(item.outcome)}</td>
                        <td>{minutes(item.minutesAfterClose)}</td>
                        <td>{rValue(item.counterfactualR)}</td>
                        <td className={item.rDelta != null && item.rDelta > 0 ? 'history-pnl--positive' : item.rDelta != null && item.rDelta < 0 ? 'history-pnl--negative' : ''}>{rValue(item.rDelta, true)}</td>
                      </tr>
                    )) : (
                      <tr><td className="history-empty" colSpan={10}>No Profit Protection evidence matches these filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="history-pagination">
                <Button type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
                <span>Page {report.page} of {Math.max(1, report.totalPages)}</span>
                <Button type="button" disabled={page >= report.totalPages || report.totalPages === 0 || loading} onClick={() => setPage((current) => current + 1)}>Next</Button>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </DashboardShell>
  );
}
