import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  V8_SHADOW_ADMISSION_THRESHOLD,
  V8_SHADOW_ARTIFACT,
  V8_SHADOW_MODE,
} from './v8-shadow-meta-scorer';
import { PLAN_B_ENSEMBLE_ARTIFACT, PLAN_B_ENSEMBLE_MODE } from './plan-b-multimodel-shadow';

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
  market_data_bar_time: Date | string | null;
  market_data_authority: string | null;
  intent_status: string | null;
  instrument: string;
  direction: 'BUY' | 'SELL';
  confidence_score: string | number | null;
  trade_id: string | null;
  trade_status: string | null;
  fill_price: string | number | null;
  exit_price: string | number | null;
  realised_pnl: string | number | null;
  close_reason: string | null;
  closed_at: Date | string | null;
  same_bar_protection_ambiguity_count: string | number | null;
  last_same_bar_protection_ambiguity_at: Date | string | null;
  max_favorable_pnl: string | number | null;
  max_adverse_pnl: string | number | null;
  profit_giveback: string | number | null;
  path_observation_count: string | number | null;
  allocated_capital: string | number | null;
  broker_connection_id: string | null;
  session_opening_balance: string | number | null;
  session_started_at: Date | string | null;
  v8_shadow_artifact?: string | null;
  v8_shadow_probability?: string | number | null;
  v8_shadow_admitted?: string | boolean | null;
  v8_shadow_expected_r?: string | number | null;
  plan_b_ensemble_artifact?: string | null;
  plan_b_ensemble_regime?: string | null;
  plan_b_ensemble_direction_quality?: string | number | null;
  plan_b_ensemble_trade_quality?: string | number | null;
  plan_b_ensemble_exit_quality?: string | number | null;
  plan_b_ensemble_pair_side_quality?: string | number | null;
  plan_b_ensemble_pair_side_route?: string | null;
  plan_b_ensemble_session_quality?: string | number | null;
  plan_b_ensemble_consensus_passed?: string | number | null;
  plan_b_ensemble_consensus_required?: string | number | null;
  plan_b_ensemble_portfolio_quality?: string | number | null;
  plan_b_ensemble_portfolio_risk_score?: string | number | null;
  plan_b_ensemble_open_position_count?: string | number | null;
  plan_b_ensemble_same_instrument_count?: string | number | null;
  plan_b_ensemble_meta_probability?: string | number | null;
  plan_b_ensemble_score?: string | number | null;
  plan_b_ensemble_admitted?: string | boolean | null;
};

type EquitySnapshotRow = {
  connection_id: string;
  equity: string | number | null;
  accepted_at: Date | string;
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

function profitFactor(realisedPnls: number[]): number | null {
  const profit = realisedPnls.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const loss = -realisedPnls.filter((x) => x < 0).reduce((a, b) => a + b, 0);
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

function buildDriftDiagnostics(rows: EvidenceRow[]) {
  const recentWindowSize = 20;
  const minimumClosedTrades = recentWindowSize * 2;
  const summary = (bucket: EvidenceRow[]) => {
    const pnls = bucket.map((row) => finite(row.realised_pnl) ?? 0);
    const wins = pnls.filter((value) => value > 0).length;
    return {
      closedTrades: bucket.length,
      realisedPnl: pnls.reduce((sum, value) => sum + value, 0),
      averagePnl: bucket.length
        ? pnls.reduce((sum, value) => sum + value, 0) / bucket.length
        : null,
      winRate: bucket.length ? wins / bucket.length : null,
      profitFactor: bucket.length ? profitFactor(pnls) : null,
    };
  };

  const recent = rows.slice(-recentWindowSize);
  const reference = rows.slice(0, Math.max(0, rows.length - recentWindowSize));
  const recentSummary = summary(recent);
  const referenceSummary = summary(reference);
  const pfRatio =
    recentSummary.profitFactor !== null &&
    referenceSummary.profitFactor !== null &&
    referenceSummary.profitFactor > 0
      ? recentSummary.profitFactor / referenceSummary.profitFactor
      : null;

  let status: 'INSUFFICIENT_EVIDENCE' | 'STABLE' | 'WATCH' | 'DEGRADED' = 'INSUFFICIENT_EVIDENCE';
  if (rows.length >= minimumClosedTrades) {
    const recentNegative = recentSummary.realisedPnl < 0;
    if (
      recentNegative &&
      ((recentSummary.profitFactor !== null && recentSummary.profitFactor < 0.8) ||
        (pfRatio !== null && pfRatio < 0.7))
    ) {
      status = 'DEGRADED';
    } else if (
      recentNegative ||
      (recentSummary.profitFactor !== null && recentSummary.profitFactor < 1.0) ||
      (pfRatio !== null && pfRatio < 0.85)
    ) {
      status = 'WATCH';
    } else {
      status = 'STABLE';
    }
  }

  return {
    mode: 'DIAGNOSTIC_ONLY' as const,
    modifiesExecution: false as const,
    recentWindowSize,
    minimumClosedTrades,
    status,
    recent: recentSummary,
    reference: referenceSummary,
    recentToReferenceProfitFactorRatio: pfRatio,
    methodology:
      'Compares the latest 20 qualification-closed trades with all earlier qualification-closed trades. It is operational drift telemetry only and never changes admission, sizing, exits, or promotion gates.',
  };
}

function buildProfitProtectionShadow(rows: EvidenceRow[]) {
  const observed = rows.filter(
    (row) =>
      (finite(row.path_observation_count) ?? 0) > 0 && finite(row.max_favorable_pnl) !== null,
  );
  const losers = observed.filter((row) => (finite(row.realised_pnl) ?? 0) < 0);
  const losersWithPositiveMfe = losers.filter((row) => (finite(row.max_favorable_pnl) ?? 0) > 0);
  const average = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const mfe = observed.map((row) => finite(row.max_favorable_pnl) ?? 0);
  const mae = observed.map((row) => finite(row.max_adverse_pnl) ?? 0);
  const giveback = observed.map((row) => finite(row.profit_giveback) ?? 0);
  const loserMfe = losers.map((row) => finite(row.max_favorable_pnl) ?? 0);

  return {
    mode: 'DIAGNOSTIC_ONLY' as const,
    modifiesExecution: false as const,
    observedClosedTrades: observed.length,
    losingTradesObserved: losers.length,
    losersWithPositiveMfe: losersWithPositiveMfe.length,
    loserPositiveMfeFraction: losers.length ? losersWithPositiveMfe.length / losers.length : null,
    averageMaxFavorablePnl: average(mfe),
    averageMaxAdversePnl: average(mae),
    averageProfitGiveback: average(giveback),
    losingTradesThatReached: {
      usd3: loserMfe.filter((value) => value >= 3).length,
      usd5: loserMfe.filter((value) => value >= 5).length,
      usd10: loserMfe.filter((value) => value >= 10).length,
    },
    methodology:
      'Prospective path telemetry only. It measures observed MFE, MAE and profit give-back on the unchanged strategy and does not move stops, take partial profit, or close positions.',
  };
}

function maxEquityDrawdown(equities: number[]): number | null {
  const valid = equities.filter((value) => Number.isFinite(value) && value > 0);
  if (!valid.length) return null;
  let peak = valid[0];
  let worst = 0;
  for (const equity of valid) {
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? (peak - equity) / peak : 1;
    worst = Math.max(worst, dd);
  }
  return worst;
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    numerator += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? numerator / denominator : null;
}

export function buildShadowCalibrationDiagnostics(rows: EvidenceRow[]) {
  const completed = rows
    .map((row) => ({
      instrument: row.instrument,
      direction: row.direction,
      confidence: finite(row.confidence_score),
      pnl: finite(row.realised_pnl),
      closedAt: row.closed_at ? new Date(row.closed_at) : null,
    }))
    .filter(
      (
        row,
      ): row is {
        instrument: string;
        direction: 'BUY' | 'SELL';
        confidence: number;
        pnl: number;
        closedAt: Date;
      } =>
        row.confidence !== null &&
        row.pnl !== null &&
        row.closedAt !== null &&
        Number.isFinite(row.closedAt.getTime()),
    );

  const scored = completed.map((row) => ({
    ...row,
    win: row.pnl > 0 ? 1 : 0,
  }));
  const brierScore = scored.length
    ? scored.reduce((sum, row) => sum + (row.confidence - row.win) ** 2, 0) / scored.length
    : null;
  const confidencePnlCorrelation = pearsonCorrelation(
    scored.map((row) => row.confidence),
    scored.map((row) => row.pnl),
  );

  const binEdges = [0.6, 0.64, 0.68, 0.72, 0.76, 0.8, 1.000001];
  const bins = binEdges.slice(0, -1).map((lower, index) => {
    const upper = binEdges[index + 1]!;
    const bucket = scored.filter(
      (row) =>
        row.confidence >= lower &&
        (index === binEdges.length - 2 ? row.confidence <= upper : row.confidence < upper),
    );
    const wins = bucket.filter((row) => row.win === 1).length;
    const avgConfidence = bucket.length
      ? bucket.reduce((sum, row) => sum + row.confidence, 0) / bucket.length
      : null;
    const observedWinRate = bucket.length ? wins / bucket.length : null;
    const pnls = bucket.map((row) => row.pnl);
    return {
      lower,
      upper: Math.min(1, upper),
      count: bucket.length,
      wins,
      losses: bucket.length - wins,
      avgConfidence,
      observedWinRate,
      calibrationGap:
        avgConfidence !== null && observedWinRate !== null ? observedWinRate - avgConfidence : null,
      averagePnl: bucket.length
        ? pnls.reduce((sum, value) => sum + value, 0) / bucket.length
        : null,
      profitFactor: bucket.length ? profitFactor(pnls) : null,
    };
  });
  const expectedCalibrationError = scored.length
    ? bins.reduce((sum, bin) => {
        if (bin.count === 0 || bin.avgConfidence === null || bin.observedWinRate === null) {
          return sum;
        }
        return (
          sum + (bin.count / scored.length) * Math.abs(bin.observedWinRate - bin.avgConfidence)
        );
      }, 0)
    : null;

  const pairDirection = INSTRUMENTS.flatMap((instrument) =>
    (['BUY', 'SELL'] as const).map((direction) => {
      const bucket = scored.filter(
        (row) => row.instrument === instrument && row.direction === direction,
      );
      const pnls = bucket.map((row) => row.pnl);
      const wins = pnls.filter((value) => value > 0).length;
      const losses = pnls.filter((value) => value < 0).length;
      const grossProfit = pnls.filter((value) => value > 0).reduce((a, b) => a + b, 0);
      const grossLoss = -pnls.filter((value) => value < 0).reduce((a, b) => a + b, 0);
      const averageConfidence = bucket.length
        ? bucket.reduce((sum, row) => sum + row.confidence, 0) / bucket.length
        : null;
      return {
        instrument,
        direction,
        closedTrades: bucket.length,
        wins,
        losses,
        winRate: bucket.length ? wins / bucket.length : null,
        smoothedWinRate: (wins + 2) / (bucket.length + 4),
        realisedPnl: pnls.reduce((a, b) => a + b, 0),
        averagePnl: bucket.length ? pnls.reduce((a, b) => a + b, 0) / bucket.length : null,
        averageWin: wins ? grossProfit / wins : null,
        averageLoss: losses ? -(grossLoss / losses) : null,
        profitFactor:
          bucket.length && grossLoss > 0
            ? grossProfit / grossLoss
            : grossProfit > 0
              ? 1_000_000
              : null,
        averageConfidence,
        evidenceStatus:
          bucket.length >= 20 && wins >= 5 && losses >= 5
            ? ('EARLY_ACTIONABLE' as const)
            : ('OBSERVE' as const),
      };
    }),
  );

  return {
    mode: 'DIAGNOSTIC_ONLY' as const,
    modifiesExecution: false,
    resetsProviderEvidence: false,
    closedTradesEvaluated: scored.length,
    brierScore,
    expectedCalibrationError,
    confidencePnlCorrelation,
    minimumEvidenceBeforeAdaptiveUse: {
      globalClosedTrades: 100,
      pairDirectionClosedTrades: 20,
      minimumWins: 5,
      minimumLosses: 5,
    },
    confidenceBins: bins,
    pairDirection,
  };
}

@Injectable()
export class ExternalSignalPerformanceService {
  constructor(private readonly dataSource: DataSource) {}

  async getProviderPerformance(userId: string, providerCode: string) {
    // One provider family may eventually have multiple execution/data-source
    // cohorts. Qualification must never silently aggregate across them.
    const modelVersion = `external-provider/${providerCode}/paper-only-v1`;
    const expectedMarketDataAuthority = providerCode.startsWith('vps-twelvedata-six-pair-')
      ? 'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA'
      : null;
    const evidenceCohortKey = [
      providerCode,
      modelVersion,
      expectedMarketDataAuthority ?? 'UNSPECIFIED_AUTHORITY',
    ].join('|');

    const rows = (await this.dataSource.query(
      `
        SELECT
          ti.signal_generated_at,
          ti.metadata->>'market_data_bar_time' AS market_data_bar_time,
          ti.metadata->>'market_data_authority' AS market_data_authority,
          ti.status AS intent_status,
          ti.instrument,
          ti.direction,
          ti.metadata->>'confidenceScore' AS confidence_score,
          t.id AS trade_id,
          t.status AS trade_status,
          t.fill_price,
          t.exit_price,
          t.realised_pnl,
          t.close_reason,
          t.closed_at,
          t.same_bar_protection_ambiguity_count,
          t.last_same_bar_protection_ambiguity_at,
          t.max_favorable_pnl,
          t.max_adverse_pnl,
          t.profit_giveback,
          t.path_observation_count,
          ca.allocated_capital,
          ti.broker_connection_id,
          ts.opening_balance AS session_opening_balance,
          ts.started_at AS session_started_at,
          ti.metadata->>'v8_shadow_artifact' AS v8_shadow_artifact,
          ti.metadata->>'v8_shadow_probability' AS v8_shadow_probability,
          ti.metadata->>'v8_shadow_admitted' AS v8_shadow_admitted,
          ti.metadata->>'v8_shadow_expected_r' AS v8_shadow_expected_r,
          ti.metadata->>'plan_b_ensemble_artifact' AS plan_b_ensemble_artifact,
          ti.metadata->>'plan_b_ensemble_regime' AS plan_b_ensemble_regime,
          ti.metadata->>'plan_b_ensemble_direction_quality' AS plan_b_ensemble_direction_quality,
          ti.metadata->>'plan_b_ensemble_trade_quality' AS plan_b_ensemble_trade_quality,
          ti.metadata->>'plan_b_ensemble_exit_quality' AS plan_b_ensemble_exit_quality,
          ti.metadata->>'plan_b_ensemble_pair_side_quality' AS plan_b_ensemble_pair_side_quality,
          ti.metadata->>'plan_b_ensemble_pair_side_route' AS plan_b_ensemble_pair_side_route,
          ti.metadata->>'plan_b_ensemble_session_quality' AS plan_b_ensemble_session_quality,
          ti.metadata->>'plan_b_ensemble_consensus_passed' AS plan_b_ensemble_consensus_passed,
          ti.metadata->>'plan_b_ensemble_consensus_required' AS plan_b_ensemble_consensus_required,
          ti.metadata->>'plan_b_ensemble_portfolio_quality' AS plan_b_ensemble_portfolio_quality,
          ti.metadata->>'plan_b_ensemble_portfolio_risk_score' AS plan_b_ensemble_portfolio_risk_score,
          ti.metadata->>'plan_b_ensemble_open_position_count' AS plan_b_ensemble_open_position_count,
          ti.metadata->>'plan_b_ensemble_same_instrument_count' AS plan_b_ensemble_same_instrument_count,
          ti.metadata->>'plan_b_ensemble_meta_probability' AS plan_b_ensemble_meta_probability,
          ti.metadata->>'plan_b_ensemble_score' AS plan_b_ensemble_score,
          ti.metadata->>'plan_b_ensemble_admitted' AS plan_b_ensemble_admitted
        FROM trading.trade_intents ti
        LEFT JOIN trading.trades t ON t.trade_intent_id = ti.id
        LEFT JOIN trading.capital_allocations ca ON ca.trade_intent_id = ti.id
        LEFT JOIN trading.trading_sessions ts ON ts.id = ti.trading_session_id
        WHERE ti.user_id = $1
          AND ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'
          AND ti.metadata->>'external_provider_code' = $2
          AND ti.model_version = $3
        ORDER BY ti.signal_generated_at ASC, ti.id ASC
      `,
      [userId, providerCode, modelVersion],
    )) as EvidenceRow[];

    const signalTimes = rows
      .map((row) => {
        const marketBar = row.market_data_bar_time
          ? new Date(row.market_data_bar_time).getTime()
          : Number.NaN;
        return Number.isFinite(marketBar) ? marketBar : new Date(row.signal_generated_at).getTime();
      })
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const signalGaps: number[] = [];
    for (let i = 1; i < signalTimes.length; i += 1) {
      signalGaps.push((signalTimes[i] - signalTimes[i - 1]) / 60000);
    }

    const allEconomicallyClosed = rows.filter(
      (row) =>
        row.trade_status === 'CLOSED' &&
        row.closed_at != null &&
        finite(row.realised_pnl) !== null &&
        finite(row.session_opening_balance) !== null &&
        (finite(row.session_opening_balance) ?? 0) > 0,
    );
    const closed = allEconomicallyClosed.filter(
      (row) => row.close_reason === 'STOP_LOSS_HIT' || row.close_reason === 'TAKE_PROFIT_HIT',
    );
    const interruptedClosedTrades = allEconomicallyClosed.length - closed.length;
    const sameBarProtectionAmbiguityCount = closed.reduce(
      (sum, row) => sum + Math.max(0, finite(row.same_bar_protection_ambiguity_count) ?? 0),
      0,
    );
    const ambiguousClosedTrades = closed.filter(
      (row) => (finite(row.same_bar_protection_ambiguity_count) ?? 0) > 0,
    ).length;

    const realisedPnls = closed.map((row) => finite(row.realised_pnl) ?? 0);
    const strategyRealisedPnl = realisedPnls.reduce((a, b) => a + b, 0);
    const buySignals = rows.filter((row) => row.direction === 'BUY').length;
    const sellSignals = rows.filter((row) => row.direction === 'SELL').length;
    const buyExecutedTrades = rows.filter(
      (row) => row.direction === 'BUY' && row.trade_id != null,
    ).length;
    const sellExecutedTrades = rows.filter(
      (row) => row.direction === 'SELL' && row.trade_id != null,
    ).length;
    const rejectedSignals = rows.filter((row) => row.intent_status === 'REJECTED').length;
    const tradeReturns = closed.map(
      (row, index) => realisedPnls[index] / (finite(row.session_opening_balance) as number),
    );
    const ba = balancedAccuracy(closed);
    const pf = profitFactor(realisedPnls);
    const sharpe = sampleSharpe(tradeReturns);

    // Drawdown must be measured from ACCOUNT equity, not broker margin. The
    // provider owns the exact PAPER connection while its campaign is active,
    // so authoritative account snapshots include both realised and unrealised
    // campaign P&L. Query from the earliest provider-bound session start and
    // calculate drawdown independently per connection; the worst account path
    // is the campaign drawdown. Missing snapshot evidence fails the gate closed.
    const startsByConnection = new Map<string, number>();
    for (const row of rows) {
      if (!row.broker_connection_id) continue;
      const started = new Date(row.session_started_at ?? row.signal_generated_at).getTime();
      if (!Number.isFinite(started)) continue;
      const current = startsByConnection.get(row.broker_connection_id);
      if (current === undefined || started < current) {
        startsByConnection.set(row.broker_connection_id, started);
      }
    }

    let dd: number | null = null;
    if (startsByConnection.size > 0) {
      const overallStart = new Date(Math.min(...startsByConnection.values()));
      const snapshotRows = (await this.dataSource.query(
        `
          SELECT connection_id, equity, accepted_at
          FROM broker.broker_account_snapshots
          WHERE connection_id = ANY($1::uuid[])
            AND accepted_at >= $2
          ORDER BY connection_id ASC, accepted_at ASC, generation ASC
        `,
        [[...startsByConnection.keys()], overallStart],
      )) as EquitySnapshotRow[];
      const byConnection = new Map<string, number[]>();
      for (const snapshot of snapshotRows) {
        const start = startsByConnection.get(snapshot.connection_id);
        const acceptedAt = new Date(snapshot.accepted_at).getTime();
        const equity = finite(snapshot.equity);
        if (
          start === undefined ||
          !Number.isFinite(acceptedAt) ||
          acceptedAt < start ||
          equity === null
        ) {
          continue;
        }
        const series = byConnection.get(snapshot.connection_id) ?? [];
        series.push(equity);
        byConnection.set(snapshot.connection_id, series);
      }
      const perConnection = [...byConnection.values()]
        .map((series) => maxEquityDrawdown(series))
        .filter((value): value is number => value !== null);
      if (perConnection.length) dd = Math.max(...perConnection);
    }

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
    const latestRow = rows.length ? rows[rows.length - 1]! : null;
    const latestSubmittedConfidence = latestRow ? finite(latestRow.confidence_score) : null;
    const latestSignalAt = latestRow ? new Date(latestRow.signal_generated_at) : null;
    const medianGap = median(signalGaps);
    const shadowCalibration = buildShadowCalibrationDiagnostics(closed);
    const driftDiagnostics = buildDriftDiagnostics(closed);
    const profitProtectionShadow = buildProfitProtectionShadow(closed);

    // v8 is a frozen prospective SHADOW filter layered over v7. It does not
    // alter v7 admission, sizing, SL/TP or execution. Only signals tagged
    // after the artifact was frozen are counted; historical rows are never
    // backfilled into this prospective cohort.
    const v8TaggedRows = rows.filter((row) => row.v8_shadow_artifact === V8_SHADOW_ARTIFACT);
    const v8AdmittedRows = v8TaggedRows.filter(
      (row) =>
        row.v8_shadow_admitted === true ||
        String(row.v8_shadow_admitted ?? '').toLowerCase() === 'true',
    );
    const v8RejectedRows = v8TaggedRows.filter(
      (row) =>
        !(
          row.v8_shadow_admitted === true ||
          String(row.v8_shadow_admitted ?? '').toLowerCase() === 'true'
        ),
    );
    const v8Closed = v8AdmittedRows.filter(
      (row) =>
        row.trade_status === 'CLOSED' &&
        row.closed_at != null &&
        finite(row.realised_pnl) !== null &&
        finite(row.session_opening_balance) !== null &&
        (finite(row.session_opening_balance) ?? 0) > 0 &&
        (row.close_reason === 'STOP_LOSS_HIT' || row.close_reason === 'TAKE_PROFIT_HIT'),
    );
    const v8Pnls = v8Closed.map((row) => finite(row.realised_pnl) ?? 0);
    const v8RejectedClosed = v8RejectedRows.filter(
      (row) =>
        row.trade_status === 'CLOSED' &&
        row.closed_at != null &&
        finite(row.realised_pnl) !== null &&
        (row.close_reason === 'STOP_LOSS_HIT' || row.close_reason === 'TAKE_PROFIT_HIT'),
    );
    const v8RejectedPnls = v8RejectedClosed.map((row) => finite(row.realised_pnl) ?? 0);
    const v8Returns = v8Closed.map(
      (row, index) => v8Pnls[index]! / (finite(row.session_opening_balance) as number),
    );
    const v8Ba = balancedAccuracy(v8Closed);
    const v8Pf = profitFactor(v8Pnls);
    const v8Sharpe = sampleSharpe(v8Returns);

    const v8Weekly = new Map<string, number>();
    for (let i = 0; i < v8Closed.length; i += 1) {
      const key = isoWeekKey(new Date(v8Closed[i]!.closed_at as Date | string));
      v8Weekly.set(key, (v8Weekly.get(key) ?? 0) + v8Returns[i]!);
    }
    const v8PositiveWindowFraction = v8Weekly.size
      ? [...v8Weekly.values()].filter((value) => value > 0).length / v8Weekly.size
      : 0;

    const v8InstrumentReturns = Object.fromEntries(
      INSTRUMENTS.map((instrument) => [instrument, 0]),
    ) as Record<(typeof INSTRUMENTS)[number], number>;
    for (let i = 0; i < v8Closed.length; i += 1) {
      const instrument = v8Closed[i]!.instrument as (typeof INSTRUMENTS)[number];
      if (INSTRUMENTS.includes(instrument)) {
        v8InstrumentReturns[instrument] += v8Returns[i]!;
      }
    }
    const v8PositiveInstrumentFraction =
      INSTRUMENTS.filter((instrument) => v8InstrumentReturns[instrument] > 0).length /
      INSTRUMENTS.length;

    const v8SignalTimes = v8AdmittedRows
      .map((row) => {
        const marketBar = row.market_data_bar_time
          ? new Date(row.market_data_bar_time).getTime()
          : Number.NaN;
        return Number.isFinite(marketBar) ? marketBar : new Date(row.signal_generated_at).getTime();
      })
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const v8SignalGaps: number[] = [];
    for (let i = 1; i < v8SignalTimes.length; i += 1) {
      v8SignalGaps.push((v8SignalTimes[i]! - v8SignalTimes[i - 1]!) / 60000);
    }
    const v8MedianGap = median(v8SignalGaps);
    const v8Probabilities = v8TaggedRows
      .map((row) => finite(row.v8_shadow_probability))
      .filter((value): value is number => value !== null);
    const v8AdmittedConfidences = v8AdmittedRows
      .map((row) => finite(row.confidence_score))
      .filter((value): value is number => value !== null);
    const v8MinUnderlyingConfidence = v8AdmittedConfidences.length
      ? Math.min(...v8AdmittedConfidences)
      : null;
    const v8ScreeningChecks = {
      balancedAccuracy: v8Ba !== null && v8Ba >= EXTERNAL_PROVIDER_REVIEW_GATES.minBalancedAccuracy,
      sharpeRatio: v8Sharpe !== null && v8Sharpe >= EXTERNAL_PROVIDER_REVIEW_GATES.minSharpeRatio,
      profitFactor: v8Pf !== null && v8Pf >= EXTERNAL_PROVIDER_REVIEW_GATES.minProfitFactor,
      positiveWindowFraction:
        v8PositiveWindowFraction >= EXTERNAL_PROVIDER_REVIEW_GATES.minPositiveWindowFraction,
      positiveInstrumentFraction:
        v8PositiveInstrumentFraction >=
        EXTERNAL_PROVIDER_REVIEW_GATES.minPositiveInstrumentFraction,
      confidence:
        v8MinUnderlyingConfidence !== null &&
        v8MinUnderlyingConfidence >= EXTERNAL_PROVIDER_REVIEW_GATES.minConfidence,
      evidence: v8Closed.length >= EXTERNAL_PROVIDER_REVIEW_GATES.minClosedTrades,
      frequency:
        v8MedianGap !== null &&
        v8MedianGap <= EXTERNAL_PROVIDER_REVIEW_GATES.maxMedianMinutesBetweenSignals,
    };
    const v8ScreeningReadyForDedicatedPaper = Object.values(v8ScreeningChecks).every(Boolean);

    const v8ProspectiveShadow = {
      artifact: V8_SHADOW_ARTIFACT,
      mode: V8_SHADOW_MODE,
      modifiesExecution: false,
      admissionThreshold: V8_SHADOW_ADMISSION_THRESHOLD,
      trainingEvidence: 'HISTORICAL_DEVELOPMENT_ONLY_ALREADY_INSPECTED_NOT_QUALIFICATION',
      qualificationEvidence: false,
      maxDrawdownIsolated: false,
      taggedSignals: v8TaggedRows.length,
      admittedSignals: v8AdmittedRows.length,
      rejectedSignals: v8RejectedRows.length,
      admittedFraction: v8TaggedRows.length ? v8AdmittedRows.length / v8TaggedRows.length : 0,
      executedTrades: v8AdmittedRows.filter((row) => row.trade_id != null).length,
      closedTrades: v8Closed.length,
      rejectedClosedTrades: v8RejectedClosed.length,
      rejectedWins: v8RejectedPnls.filter((value) => value > 0).length,
      rejectedLosses: v8RejectedPnls.filter((value) => value < 0).length,
      rejectedRealisedPnl: v8RejectedPnls.reduce((sum, value) => sum + value, 0),
      rejectedProfitFactor: profitFactor(v8RejectedPnls),
      wins: v8Pnls.filter((value) => value > 0).length,
      losses: v8Pnls.filter((value) => value < 0).length,
      realisedPnl: v8Pnls.reduce((sum, value) => sum + value, 0),
      profitFactor: v8Pf,
      balancedAccuracy: v8Ba,
      evidenceWindowSharpeRatio: v8Sharpe,
      positiveWeeklyWindowFraction: v8PositiveWindowFraction,
      positiveInstrumentFraction: v8PositiveInstrumentFraction,
      medianMinutesBetweenSignals: v8MedianGap,
      minUnderlyingConfidence: v8MinUnderlyingConfidence,
      latestProbability: v8Probabilities.length
        ? v8Probabilities[v8Probabilities.length - 1]!
        : null,
      minProbability: v8Probabilities.length ? Math.min(...v8Probabilities) : null,
      screeningChecks: v8ScreeningChecks,
      screeningReadyForDedicatedPaper: v8ScreeningReadyForDedicatedPaper,
      nextStage: v8ScreeningReadyForDedicatedPaper
        ? 'DEDICATED_V8_PAPER_REQUIRED'
        : 'COLLECTING_PROSPECTIVE_SHADOW',
      methodology:
        'Prospective counterfactual screening only. v7 continues to execute unchanged; v8-shadow results use only post-freeze tagged v7 trades that the frozen v8 filter would have admitted. A separate dedicated v8 PAPER cohort is required before qualification.',
    };

    const ensembleTaggedRows = rows.filter(
      (row) => row.plan_b_ensemble_artifact === PLAN_B_ENSEMBLE_ARTIFACT,
    );
    const ensembleAdmittedRows = ensembleTaggedRows.filter(
      (row) => String(row.plan_b_ensemble_admitted) === 'true',
    );
    const ensembleRejectedRows = ensembleTaggedRows.filter(
      (row) => String(row.plan_b_ensemble_admitted) === 'false',
    );
    const ensembleClosedRows = ensembleAdmittedRows.filter(
      (row) =>
        row.trade_status === 'CLOSED' &&
        row.closed_at != null &&
        finite(row.realised_pnl) !== null &&
        (row.close_reason === 'STOP_LOSS_HIT' || row.close_reason === 'TAKE_PROFIT_HIT'),
    );
    const ensemblePnls = ensembleClosedRows.map((row) => finite(row.realised_pnl) ?? 0);
    const ensembleRegimes = ensembleTaggedRows.reduce<Record<string, number>>((acc, row) => {
      const regime = row.plan_b_ensemble_regime ?? 'UNKNOWN';
      acc[regime] = (acc[regime] ?? 0) + 1;
      return acc;
    }, {});
    const pairSideRouteCounts = ensembleTaggedRows.reduce<Record<string, number>>((acc, row) => {
      const route = row.plan_b_ensemble_pair_side_route ?? 'UNKNOWN';
      acc[route] = (acc[route] ?? 0) + 1;
      return acc;
    }, {});
    const ensembleAverage = (field: keyof EvidenceRow): number | null => {
      const values = ensembleTaggedRows
        .map((row) => finite(row[field]))
        .filter((value): value is number => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    const planBEnsembleShadow = {
      artifact: PLAN_B_ENSEMBLE_ARTIFACT,
      mode: PLAN_B_ENSEMBLE_MODE,
      modifiesExecution: false,
      taggedSignals: ensembleTaggedRows.length,
      admittedSignals: ensembleAdmittedRows.length,
      rejectedSignals: ensembleRejectedRows.length,
      admittedFraction: ensembleTaggedRows.length
        ? ensembleAdmittedRows.length / ensembleTaggedRows.length
        : 0,
      closedTrades: ensembleClosedRows.length,
      wins: ensemblePnls.filter((value) => value > 0).length,
      losses: ensemblePnls.filter((value) => value < 0).length,
      realisedPnl: ensemblePnls.reduce((sum, value) => sum + value, 0),
      profitFactor: profitFactor(ensemblePnls),
      regimeCounts: ensembleRegimes,
      pairSideRouteCounts,
      averageDirectionQuality: ensembleAverage('plan_b_ensemble_direction_quality'),
      averageTradeQuality: ensembleAverage('plan_b_ensemble_trade_quality'),
      averageExitQuality: ensembleAverage('plan_b_ensemble_exit_quality'),
      averagePairSideQuality: ensembleAverage('plan_b_ensemble_pair_side_quality'),
      averageSessionQuality: ensembleAverage('plan_b_ensemble_session_quality'),
      averageConsensusPassed: ensembleAverage('plan_b_ensemble_consensus_passed'),
      averageConsensusRequired: ensembleAverage('plan_b_ensemble_consensus_required'),
      averagePortfolioQuality: ensembleAverage('plan_b_ensemble_portfolio_quality'),
      averagePortfolioRiskScore: ensembleAverage('plan_b_ensemble_portfolio_risk_score'),
      averageOpenPositionCount: ensembleAverage('plan_b_ensemble_open_position_count'),
      averageSameInstrumentCount: ensembleAverage('plan_b_ensemble_same_instrument_count'),
      averageMetaProbability: ensembleAverage('plan_b_ensemble_meta_probability'),
      averageEnsembleScore: ensembleAverage('plan_b_ensemble_score'),
      methodology:
        'Prospective non-executing multimodel ensemble. Regime, direction, expected-return economics, trade quality and portfolio/currency concentration are evaluated independently and persisted for counterfactual review.',
    };

    const observedMarketDataAuthorities = [
      ...new Set(
        rows
          .map((row) => row.market_data_authority?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const authorityTaggedSignals = rows.filter((row) =>
      Boolean(row.market_data_authority?.trim()),
    ).length;
    const evidenceCohortIntegrity =
      expectedMarketDataAuthority !== null
        ? observedMarketDataAuthorities.every(
            (authority) => authority === expectedMarketDataAuthority,
          )
        : observedMarketDataAuthorities.length <= 1;

    const observed = {
      receivedSignals: rows.length,
      buySignals,
      sellSignals,
      executedTrades: rows.filter((row) => row.trade_id != null).length,
      buyExecutedTrades,
      sellExecutedTrades,
      rejectedSignals,
      closedTrades: closed.length,
      interruptedClosedTrades,
      ambiguousClosedTrades,
      sameBarProtectionAmbiguityCount,
      strategyRealisedPnl,
      balancedAccuracy: ba,
      profitFactor: pf,
      evidenceWindowSharpeRatio: sharpe,
      maxDrawdown: dd,
      positiveWeeklyWindowFraction: positiveWindowFraction,
      positiveInstrumentFraction,
      minSubmittedConfidence: minConfidence,
      latestSubmittedConfidence,
      latestSignalAt:
        latestSignalAt && Number.isFinite(latestSignalAt.getTime())
          ? latestSignalAt.toISOString()
          : null,
      latestSignalInstrument: latestRow?.instrument ?? null,
      latestSignalDirection: latestRow?.direction ?? null,
      medianMinutesBetweenSignals: medianGap,
      totalNormalizedReturn: tradeReturns.reduce((a, b) => a + b, 0),
      instrumentNormalizedReturns: instrumentReturns,
      evaluatedWeeklyWindows: weekly.size,
    };

    const checks = {
      balancedAccuracy: ba !== null && ba >= EXTERNAL_PROVIDER_REVIEW_GATES.minBalancedAccuracy,
      sharpeRatio: sharpe !== null && sharpe >= EXTERNAL_PROVIDER_REVIEW_GATES.minSharpeRatio,
      profitFactor: pf !== null && pf >= EXTERNAL_PROVIDER_REVIEW_GATES.minProfitFactor,
      maxDrawdown: dd !== null && dd <= EXTERNAL_PROVIDER_REVIEW_GATES.maxDrawdown,
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
      evidenceCohortIntegrity,
    };
    const demoReviewEligible = Object.values(checks).every(Boolean);

    return {
      providerCode,
      strategyIdentity: {
        displayName: providerCode.startsWith('vps-twelvedata-six-pair-v7')
          ? 'Six-Pair Forex v7'
          : providerCode,
        modelVersion,
        marketDataAuthority: expectedMarketDataAuthority ?? 'EXTERNAL_PROVIDER_UNSPECIFIED',
        evidenceCohortKey,
        evidenceIsolationApplied: true,
        evidenceCohortIntegrity,
        authorityTaggedSignals,
        authorityTagCoverage: rows.length ? authorityTaggedSignals / rows.length : 0,
        observedMarketDataAuthorities,
        strategyFrozen: false,
        currentEnvironment: 'PAPER' as const,
        currentExecution: 'SIMULATED_PAPER_BROKER' as const,
        productionPromotionPolicy:
          'Freeze the exact qualified strategy artifact, then validate it on broker-native data in Broker-Parity PAPER and DEMO before LIVE.',
      },
      executionAuthority: 'PAPER_ONLY' as const,
      certificationStatus: demoReviewEligible ? 'ELIGIBLE_FOR_DEMO_REVIEW' : 'PAPER_EVIDENCE_ONLY',
      demoReviewEligible,
      automaticDemoPromotion: false,
      automaticLivePromotion: false,
      gates: EXTERNAL_PROVIDER_REVIEW_GATES,
      observed,
      checks,
      shadowCalibration,
      driftDiagnostics,
      profitProtectionShadow,
      v8ProspectiveShadow,
      planBEnsembleShadow,
      methodology: {
        completedTradeEvidence:
          'Qualification metrics count only PAPER trades durably closed by STOP_LOSS_HIT or TAKE_PROFIT_HIT. Manual, kill-switch, reconciliation and unknown broker closes are censored/interrupted and do not count toward the 100-trade gate.',
        balancedAccuracy:
          'Completed-trade direction vs fill-to-exit price direction; flat exits are excluded.',
        profitFactor:
          'Conventional gross realised profit divided by gross realised loss across closed PAPER trades.',
        maxDrawdown:
          'Peak-to-trough drawdown from authoritative broker account equity snapshots during the provider campaign; includes unrealised equity changes.',
        sharpeRatio:
          'sqrt(N) times mean per-trade account return divided by sample standard deviation; each trade return is realised P&L divided by its session opening balance. Evidence-window, not annualized.',
        positiveWindowFraction:
          'Fraction of UTC calendar weeks with positive summed per-trade account return.',
        positiveInstrumentFraction:
          'Fraction of the fixed six-pair universe with positive summed per-trade account return.',
        sameBarProtectionAmbiguity:
          'Count of closed M5 bars where both SL and TP were reachable but OHLC could not prove hit order. PAPER resolves these conservatively SL-first and reports the ambiguity instead of hiding it.',
      },
    };
  }
}
