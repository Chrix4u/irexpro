import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

const INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'] as const;
const MIN_CLOSED_TRADES = 100;

export const EXTERNAL_PROVIDER_REVIEW_GATES = Object.freeze({
  minBalancedAccuracy: 0.52,
  minSharpeRatio: 1.0,
  minProfitFactor: 1.15,
  maxDrawdown: 0.12,
  minPositiveWindowFraction: 0.6,
  minPositiveInstrumentFraction: 0.67,
  minConfidence: 0.6,
  minClosedTrades: MIN_CLOSED_TRADES,
  maxMedianMinutesBetweenSignals: 10.0,
});

type EvidenceRow = {
  signal_generated_at: Date | string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  confidence_score: string | number | null;
  trade_id: string | null;
  trade_status: string | null;
  fill_price: string | number | null;
  exit_price: string | number | null;
  realised_pnl: string | number | null;
  closed_at: Date | string | null;
  allocated_capital: string | number | null;
};

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function balancedAccuracy(rows: EvidenceRow[]): number | null {
  let tp = 0;
  let fn = 0;
  let tn = 0;
  let fp = 0;
  for (const row of rows) {
    const fill = finite(row.fill_price);
    const exit = finite(row.exit_price);
    if (fill === null || exit === null || exit === fill) continue;
    const trueUp = exit > fill;
    const predictedUp = row.direction === 'BUY';
    if (trueUp && predictedUp) tp += 1;
    else if (trueUp) fn += 1;
    else if (!predictedUp) tn += 1;
    else fp += 1;
  }
  if (tp + fn === 0 || tn + fp === 0) return null;
  return (tp / (tp + fn) + tn / (tn + fp)) / 2;
}

function profitFactor(returns: number[]): number | null {
  const profit = returns.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const loss = -returns.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  if (loss === 0) return profit > 0 ? 1_000_000 : null;
  return profit / loss;
}

function sampleSharpe(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (!Number.isFinite(sd) || sd === 0) return null;
  // Evidence-window Sharpe: sqrt(N) * mean / sample SD. This is not an
  // annualized market Sharpe; the API labels it explicitly to avoid implying
  // a time-scale that the provider's varying holding periods do not support.
  return (Math.sqrt(returns.length) * mean) / sd;
}

function maxDrawdown(returns: number[]): number {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    equity *= Math.max(0, 1 + r);
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? (peak - equity) / peak : 1;
    worst = Math.max(worst, dd);
  }
  return worst;
}

@Injectable()
export class ExternalSignalPerformanceService {
  constructor(private readonly dataSource: DataSource) {}

  async getProviderPerformance(userId: string, providerCode: string) {
    const rows = (await this.dataSource.query(
      `
        SELECT
          ti.signal_generated_at,
          ti.instrument,
          ti.direction,
          ti.metadata->>'confidenceScore' AS confidence_score,
          t.id AS trade_id,
          t.status AS trade_status,
          t.fill_price,
          t.exit_price,
          t.realised_pnl,
          t.closed_at,
          ca.allocated_capital
        FROM trading.trade_intents ti
        LEFT JOIN trading.trades t ON t.trade_intent_id = ti.id
        LEFT JOIN trading.capital_allocations ca ON ca.trade_intent_id = ti.id
        WHERE ti.user_id = $1
          AND ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'
          AND ti.metadata->>'external_provider_code' = $2
        ORDER BY ti.signal_generated_at ASC, ti.id ASC
      `,
      [userId, providerCode],
    )) as EvidenceRow[];

    const signalTimes = rows
      .map((row) => new Date(row.signal_generated_at).getTime())
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const signalGaps: number[] = [];
    for (let i = 1; i < signalTimes.length; i += 1) {
      signalGaps.push((signalTimes[i] - signalTimes[i - 1]) / 60000);
    }

    const closed = rows.filter(
      (row) =>
        row.trade_status === 'CLOSED' &&
        row.closed_at != null &&
        finite(row.realised_pnl) !== null &&
        finite(row.allocated_capital) !== null &&
        (finite(row.allocated_capital) ?? 0) > 0,
    );

    const tradeReturns = closed.map(
      (row) => (finite(row.realised_pnl) ?? 0) / (finite(row.allocated_capital) as number),
    );
    const ba = balancedAccuracy(closed);
    const pf = profitFactor(tradeReturns);
    const sharpe = sampleSharpe(tradeReturns);
    const dd = maxDrawdown(tradeReturns);

    const weekly = new Map<string, number>();
    for (let i = 0; i < closed.length; i += 1) {
      const key = isoWeekKey(new Date(closed[i].closed_at as Date | string));
      weekly.set(key, (weekly.get(key) ?? 0) + tradeReturns[i]);
    }
    const positiveWindowFraction = weekly.size
      ? [...weekly.values()].filter((value) => value > 0).length / weekly.size
      : 0;

    const instrumentReturns = Object.fromEntries(
      INSTRUMENTS.map((instrument) => [instrument, 0]),
    ) as Record<(typeof INSTRUMENTS)[number], number>;
    for (let i = 0; i < closed.length; i += 1) {
      const instrument = closed[i].instrument as (typeof INSTRUMENTS)[number];
      if (INSTRUMENTS.includes(instrument)) instrumentReturns[instrument] += tradeReturns[i];
    }
    const positiveInstrumentFraction =
      INSTRUMENTS.filter((instrument) => instrumentReturns[instrument] > 0).length /
      INSTRUMENTS.length;

    const confidences = rows
      .map((row) => finite(row.confidence_score))
      .filter((value): value is number => value !== null);
    const minConfidence = confidences.length ? Math.min(...confidences) : null;
    const medianGap = median(signalGaps);

    const observed = {
      receivedSignals: rows.length,
      executedTrades: rows.filter((row) => row.trade_id != null).length,
      closedTrades: closed.length,
      balancedAccuracy: ba,
      profitFactor: pf,
      evidenceWindowSharpeRatio: sharpe,
      maxDrawdown: dd,
      positiveWeeklyWindowFraction: positiveWindowFraction,
      positiveInstrumentFraction,
      minSubmittedConfidence: minConfidence,
      medianMinutesBetweenSignals: medianGap,
      totalNormalizedReturn: tradeReturns.reduce((a, b) => a + b, 0),
      instrumentNormalizedReturns: instrumentReturns,
      evaluatedWeeklyWindows: weekly.size,
    };

    const checks = {
      balancedAccuracy: ba !== null && ba >= EXTERNAL_PROVIDER_REVIEW_GATES.minBalancedAccuracy,
      sharpeRatio: sharpe !== null && sharpe >= EXTERNAL_PROVIDER_REVIEW_GATES.minSharpeRatio,
      profitFactor: pf !== null && pf >= EXTERNAL_PROVIDER_REVIEW_GATES.minProfitFactor,
      maxDrawdown: dd <= EXTERNAL_PROVIDER_REVIEW_GATES.maxDrawdown,
      positiveWindowFraction:
        positiveWindowFraction >= EXTERNAL_PROVIDER_REVIEW_GATES.minPositiveWindowFraction,
      positiveInstrumentFraction:
        positiveInstrumentFraction >= EXTERNAL_PROVIDER_REVIEW_GATES.minPositiveInstrumentFraction,
      confidence:
        minConfidence !== null && minConfidence >= EXTERNAL_PROVIDER_REVIEW_GATES.minConfidence,
      evidence: closed.length >= EXTERNAL_PROVIDER_REVIEW_GATES.minClosedTrades,
      frequency:
        medianGap !== null &&
        medianGap <= EXTERNAL_PROVIDER_REVIEW_GATES.maxMedianMinutesBetweenSignals,
    };
    const demoReviewEligible = Object.values(checks).every(Boolean);

    return {
      providerCode,
      executionAuthority: 'PAPER_ONLY' as const,
      certificationStatus: demoReviewEligible ? 'ELIGIBLE_FOR_DEMO_REVIEW' : 'PAPER_EVIDENCE_ONLY',
      demoReviewEligible,
      automaticDemoPromotion: false,
      automaticLivePromotion: false,
      gates: EXTERNAL_PROVIDER_REVIEW_GATES,
      observed,
      checks,
      methodology: {
        balancedAccuracy:
          'Executed-trade direction vs fill-to-exit price direction; flat exits are excluded.',
        profitFactorAndDrawdown:
          'Computed from realised P&L divided by the durable allocated capital for each closed PAPER trade.',
        sharpeRatio:
          'sqrt(N) times mean trade return divided by sample standard deviation; evidence-window, not annualized.',
        positiveWindowFraction: 'Fraction of UTC calendar weeks with positive normalized return.',
        positiveInstrumentFraction:
          'Fraction of the fixed six-pair universe with positive normalized return.',
      },
    };
  }
}
