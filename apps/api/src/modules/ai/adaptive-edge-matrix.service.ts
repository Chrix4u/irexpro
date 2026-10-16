import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AdaptiveMarketSession, AdaptiveMarketState } from './adaptive-market-state';

export const ADAPTIVE_EDGE_MATRIX_ARTIFACT = 'adaptive-edge-matrix-v1';
export const ADAPTIVE_EDGE_MATURE_MIN_SAMPLES = 20;
export const ADAPTIVE_EDGE_MIN_WINS = 5;
export const ADAPTIVE_EDGE_MIN_LOSSES = 5;

export type AdaptiveEdgeMaturity = 'SPARSE' | 'COLLECTING' | 'MATURE' | 'DEGRADED';
export type AdaptiveEvidenceClass = 'QUALIFICATION' | 'RESEARCH';
export type AdaptiveRecentEdgeStatus = 'INSUFFICIENT' | 'STABLE' | 'WATCH' | 'DEGRADED';

export interface AdaptiveEdgeEvidenceRequest {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  session: AdaptiveMarketSession;
  state: AdaptiveMarketState;
  strategyRoute: string;
  decisionPolicyVersion: string;
  evaluatedAt: Date;
  evidenceClass?: AdaptiveEvidenceClass;
}

export interface AdaptiveEdgeOutcomeRow {
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategy_route?: string | null;
  adaptive_state: string | null;
  adaptive_session: string | null;
  adaptive_tagged?: boolean | string | number | null;
  signal_generated_at?: Date | string | null;
  fill_price?: number | string | null;
  exit_price?: number | string | null;
  stop_loss?: number | string | null;
  close_reason?: string | null;
  confidence_score?: number | string | null;
  submitted_confidence?: number | string | null;
  realised_pnl: number | string | null;
  risk_amount?: number | string | null;
  session_opening_balance: number | string | null;
  execution_cost_r: number | string | null;
  max_favorable_pnl: number | string | null;
  max_adverse_pnl: number | string | null;
  profit_giveback: number | string | null;
  closed_at: Date | string;
}

export interface AdaptiveEdgeEvidence {
  artifact: typeof ADAPTIVE_EDGE_MATRIX_ARTIFACT;
  available: boolean;
  cellKey: string;
  evidenceClass: AdaptiveEvidenceClass;
  maturity: AdaptiveEdgeMaturity;
  recentStatus: AdaptiveRecentEdgeStatus;
  closedTrades: number;
  exactClosedTrades: number;
  broaderClosedTrades: number;
  prospectiveSamples: number;
  priorSamples: number;
  wins: number;
  losses: number;
  smoothedWinRate: number;
  averageRealizedR: number | null;
  smoothedExpectedR: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  positiveWindowFraction: number | null;
  averageExecutionCostR: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  averageProfitGivebackR: number | null;
  calibrationGap: number | null;
  recentDegradation: boolean;
  latestResolvedAt: string | null;
  sourceLevel: 'EXACT' | 'PAIR_SESSION' | 'PAIR_DIRECTION' | 'ROUTE' | 'NEUTRAL';
  canUpsize: boolean;
  reason: string;
  reasons: string[];
}

type ScoredOutcome = AdaptiveEdgeOutcomeRow & {
  r: number;
  accountReturn: number | null;
  session: AdaptiveMarketSession;
  adaptiveTagged: boolean;
};

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function sessionFor(row: AdaptiveEdgeOutcomeRow): AdaptiveMarketSession {
  const tagged = row.adaptive_session;
  if (tagged === 'ASIA' || tagged === 'LONDON' || tagged === 'NEW_YORK' || tagged === 'ROLLOVER') {
    return tagged;
  }
  if (!row.signal_generated_at) return 'NEW_YORK';
  const time = new Date(row.signal_generated_at);
  if (!Number.isFinite(time.getTime())) return 'NEW_YORK';
  const hour = time.getUTCHours();
  if (hour >= 21) return 'ROLLOVER';
  if (hour < 7) return 'ASIA';
  if (hour < 13) return 'LONDON';
  return 'NEW_YORK';
}

function profitFactor(values: number[]): number | null {
  const grossProfit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = -values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  if (grossLoss === 0) return grossProfit > 0 ? 1_000_000 : null;
  return grossProfit / grossLoss;
}

function sharpe(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = average(values)!;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 && Number.isFinite(sd) ? (Math.sqrt(values.length) * mean) / sd : null;
}

function maxDrawdown(returns: number[]): number | null {
  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst;
}

function isoWeekKey(input: Date): string {
  const d = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function positiveWindowFraction(rows: ScoredOutcome[]): number | null {
  const windows = new Map<string, number>();
  for (const row of rows) {
    if (row.accountReturn === null) continue;
    const date = new Date(row.closed_at);
    if (!Number.isFinite(date.getTime())) continue;
    const key = isoWeekKey(date);
    windows.set(key, (windows.get(key) ?? 0) + row.accountReturn);
  }
  return windows.size
    ? [...windows.values()].filter((value) => value > 0).length / windows.size
    : null;
}

function blend(sample: number | null, n: number, prior: number, priorStrength: number): number {
  if (sample === null || n <= 0) return prior;
  const weight = n / (n + priorStrength);
  return weight * sample + (1 - weight) * prior;
}

function scoreRows(rows: AdaptiveEdgeOutcomeRow[]): ScoredOutcome[] {
  return rows
    .map((row) => {
      const pnl = finite(row.realised_pnl);
      const riskAmount = finite(row.risk_amount);
      const fill = finite(row.fill_price);
      const exit = finite(row.exit_price);
      const stop = finite(row.stop_loss);
      let r: number | null = null;
      if (pnl !== null && riskAmount !== null && riskAmount > 0) {
        r = pnl / riskAmount;
      } else if (fill !== null && exit !== null && stop !== null && Math.abs(fill - stop) > 0) {
        const riskDistance = Math.abs(fill - stop);
        r = row.direction === 'BUY' ? (exit - fill) / riskDistance : (fill - exit) / riskDistance;
      }
      if (r === null || !Number.isFinite(r)) return null;
      const opening = finite(row.session_opening_balance);
      return {
        ...row,
        r,
        accountReturn: pnl !== null && opening !== null && opening > 0 ? pnl / opening : null,
        session: sessionFor(row),
        adaptiveTagged:
          row.adaptive_tagged == null ? Boolean(row.adaptive_state) : truthy(row.adaptive_tagged),
      };
    })
    .filter((row): row is ScoredOutcome => row !== null)
    .sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());
}

function edgeCellKey(request: AdaptiveEdgeEvidenceRequest): string {
  return [
    request.instrument.trim().toUpperCase(),
    request.direction,
    request.session,
    request.state,
    request.strategyRoute,
    request.decisionPolicyVersion,
    request.evidenceClass ?? 'QUALIFICATION',
  ].join('|');
}

function unavailable(request: AdaptiveEdgeEvidenceRequest): AdaptiveEdgeEvidence {
  return {
    artifact: ADAPTIVE_EDGE_MATRIX_ARTIFACT,
    available: false,
    cellKey: edgeCellKey(request),
    evidenceClass: request.evidenceClass ?? 'QUALIFICATION',
    maturity: 'SPARSE',
    recentStatus: 'INSUFFICIENT',
    closedTrades: 0,
    exactClosedTrades: 0,
    broaderClosedTrades: 0,
    prospectiveSamples: 0,
    priorSamples: 0,
    wins: 0,
    losses: 0,
    smoothedWinRate: 0.5,
    averageRealizedR: null,
    smoothedExpectedR: 0,
    profitFactor: null,
    sharpe: null,
    maxDrawdown: null,
    positiveWindowFraction: null,
    averageExecutionCostR: null,
    averageMfeR: null,
    averageMaeR: null,
    averageProfitGivebackR: null,
    calibrationGap: null,
    recentDegradation: false,
    latestResolvedAt: null,
    sourceLevel: 'NEUTRAL',
    canUpsize: false,
    reason: 'ADAPTIVE_EVIDENCE_UNAVAILABLE',
    reasons: ['ADAPTIVE_EVIDENCE_UNAVAILABLE'],
  };
}

export function buildAdaptiveEdgeEvidence(
  inputRows: AdaptiveEdgeOutcomeRow[],
  request: AdaptiveEdgeEvidenceRequest,
): AdaptiveEdgeEvidence {
  const evaluatedAtMs = request.evaluatedAt.getTime();
  const rows = scoreRows(inputRows).filter((row) => {
    if (row.strategy_route && row.strategy_route !== request.strategyRoute) return false;
    const closedAtMs = new Date(row.closed_at).getTime();
    if (!Number.isFinite(closedAtMs) || closedAtMs >= evaluatedAtMs) return false;
    if (row.signal_generated_at) {
      const generatedAtMs = new Date(row.signal_generated_at).getTime();
      if (!Number.isFinite(generatedAtMs) || generatedAtMs >= evaluatedAtMs) return false;
    }
    return true;
  });
  const instrument = request.instrument.trim().toUpperCase();
  const pairDirection = rows.filter(
    (row) => row.instrument.trim().toUpperCase() === instrument && row.direction === request.direction,
  );
  const pairSession = pairDirection.filter((row) => row.session === request.session);
  const exact = pairSession.filter(
    (row) => row.adaptiveTagged && row.adaptive_state === request.state,
  );

  const routeMean = average(rows.map((row) => row.r)) ?? 0;
  const pairMean = average(pairDirection.map((row) => row.r));
  const pairPrior = blend(pairMean, pairDirection.length, routeMean, 24);
  const sessionMean = average(pairSession.map((row) => row.r));
  const sessionPrior = blend(sessionMean, pairSession.length, pairPrior, 16);
  const exactMean = average(exact.map((row) => row.r));
  const smoothedExpectedR = blend(
    exactMean,
    exact.length,
    sessionPrior,
    ADAPTIVE_EDGE_MATURE_MIN_SAMPLES,
  );

  const wins = exact.filter((row) => row.r > 0).length;
  const losses = exact.filter((row) => row.r < 0).length;
  const smoothedWinRate = (wins + 2) / (exact.length + 4);
  const returns = exact
    .map((row) => row.accountReturn)
    .filter((value): value is number => value !== null);
  const pf = profitFactor(exact.map((row) => row.r));
  const dd = maxDrawdown(returns);
  const recent = exact.slice(-8);
  const recentWins = recent.filter((row) => row.r > 0).length;
  const recentSum = recent.reduce((sum, row) => sum + row.r, 0);
  const recentDegradation =
    (recent.length >= 8 && recentWins === 0 && recentSum < 0) || (dd !== null && dd > 0.12);

  let maturity: AdaptiveEdgeMaturity;
  if (recentDegradation) maturity = 'DEGRADED';
  else if (exact.length < 8) maturity = 'SPARSE';
  else if (
    exact.length >= ADAPTIVE_EDGE_MATURE_MIN_SAMPLES &&
    wins >= ADAPTIVE_EDGE_MIN_WINS &&
    losses >= ADAPTIVE_EDGE_MIN_LOSSES
  ) {
    maturity = 'MATURE';
  } else maturity = 'COLLECTING';

  const recentStatus: AdaptiveRecentEdgeStatus = recentDegradation
    ? 'DEGRADED'
    : exact.length < 8
      ? 'INSUFFICIENT'
      : recentSum < 0
        ? 'WATCH'
        : 'STABLE';
  const costs = exact
    .map((row) => finite(row.execution_cost_r))
    .filter((value): value is number => value !== null);
  const confidences = exact
    .map((row) => finite(row.confidence_score ?? row.submitted_confidence))
    .filter((value): value is number => value !== null);
  const observedWinRate = exact.length ? wins / exact.length : null;
  const avgConfidence = average(confidences);
  const calibrationGap =
    observedWinRate !== null && avgConfidence !== null ? observedWinRate - avgConfidence : null;
  const mfeR = exact.flatMap((row) => {
    const value = finite(row.max_favorable_pnl);
    const risk = finite(row.risk_amount);
    return value !== null && risk !== null && risk > 0 ? [value / risk] : [];
  });
  const maeR = exact.flatMap((row) => {
    const value = finite(row.max_adverse_pnl);
    const risk = finite(row.risk_amount);
    return value !== null && risk !== null && risk > 0 ? [value / risk] : [];
  });
  const givebackR = exact.flatMap((row) => {
    const value = finite(row.profit_giveback);
    const risk = finite(row.risk_amount);
    return value !== null && risk !== null && risk > 0 ? [value / risk] : [];
  });
  const sourceLevel: AdaptiveEdgeEvidence['sourceLevel'] = exact.length
    ? 'EXACT'
    : pairSession.length
      ? 'PAIR_SESSION'
      : pairDirection.length
        ? 'PAIR_DIRECTION'
        : rows.length
          ? 'ROUTE'
          : 'NEUTRAL';
  const canUpsize =
    maturity === 'MATURE' &&
    smoothedExpectedR > 0 &&
    pf !== null &&
    pf >= 1.15 &&
    dd !== null &&
    dd <= 0.12;

  const reasons = recentDegradation
    ? ['RECENT_EDGE_DEGRADED']
    : exact.length === 0
      ? ['NO_PROSPECTIVE_EXACT_CELL_EVIDENCE']
      : maturity === 'MATURE'
        ? ['MATURE_EDGE_EVIDENCE']
        : ['COLLECTING_EDGE_EVIDENCE'];

  return {
    artifact: ADAPTIVE_EDGE_MATRIX_ARTIFACT,
    available: true,
    cellKey: edgeCellKey(request),
    evidenceClass: request.evidenceClass ?? 'QUALIFICATION',
    maturity,
    recentStatus,
    closedTrades: exact.length,
    exactClosedTrades: exact.length,
    broaderClosedTrades: rows.length,
    prospectiveSamples: exact.length,
    priorSamples: Math.max(0, rows.length - exact.length),
    wins,
    losses,
    smoothedWinRate,
    averageRealizedR: exactMean,
    smoothedExpectedR,
    profitFactor: pf,
    sharpe: sharpe(returns),
    maxDrawdown: dd,
    positiveWindowFraction: positiveWindowFraction(exact),
    averageExecutionCostR: average(costs),
    averageMfeR: average(mfeR),
    averageMaeR: average(maeR),
    averageProfitGivebackR: average(givebackR),
    calibrationGap,
    recentDegradation,
    latestResolvedAt: exact.length
      ? new Date(exact[exact.length - 1]!.closed_at).toISOString()
      : null,
    sourceLevel,
    canUpsize,
    reason: reasons[0] ?? 'EVIDENCE_AVAILABLE',
    reasons,
  };
}

@Injectable()
export class AdaptiveEdgeMatrixService {
  private readonly cache = new Map<string, { expiresAt: number; result: AdaptiveEdgeEvidence }>();

  constructor(private readonly dataSource: DataSource) {}

  async getEvidence(request: AdaptiveEdgeEvidenceRequest): Promise<AdaptiveEdgeEvidence> {
    const cacheKey = `${edgeCellKey(request)}|${request.evaluatedAt.toISOString()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const evidenceClass = request.evidenceClass ?? 'QUALIFICATION';
    try {
      const rows = (await this.dataSource.query(
        `
          SELECT
            ti.instrument,
            ti.direction,
            COALESCE(
              ti.metadata->'adaptiveMarketIntelligence'->>'strategyRoute',
              ti.metadata->>'plan_b_ensemble_strategy_route'
            ) AS strategy_route,
            ti.metadata->'adaptiveMarketIntelligence'->'marketState'->>'state' AS adaptive_state,
            ti.metadata->'adaptiveMarketIntelligence'->'marketState'->>'session' AS adaptive_session,
            (ti.metadata ? 'adaptiveMarketIntelligence') AS adaptive_tagged,
            ti.signal_generated_at,
            NULLIF(ti.metadata->>'confidenceScore', '')::numeric AS confidence_score,
            t.realised_pnl,
            NULLIF(ca.sizing_inputs->>'riskAmount', '')::numeric AS risk_amount,
            ts.opening_balance AS session_opening_balance,
            COALESCE(
              NULLIF(ti.metadata->'adaptiveMarketIntelligence'->>'executionCostR', '')::numeric,
              NULLIF(ti.metadata->>'plan_b_governance_execution_cost_r', '')::numeric
            ) AS execution_cost_r,
            t.max_favorable_pnl,
            t.max_adverse_pnl,
            t.profit_giveback,
            t.closed_at
          FROM trading.trade_intents ti
          JOIN trading.trades t ON t.trade_intent_id = ti.id
          JOIN trading.capital_allocations ca ON ca.trade_intent_id = ti.id
          LEFT JOIN trading.trading_sessions ts ON ts.id = ti.trading_session_id
          WHERE ti.user_id = $1
            AND ti.broker_connection_id = $2
            AND ti.signal_generated_at < $3
            AND t.closed_at < $3
            AND ti.metadata->>'decision_policy_version' = $4
            AND COALESCE(
              ti.metadata->'adaptiveMarketIntelligence'->>'strategyRoute',
              ti.metadata->>'plan_b_ensemble_strategy_route'
            ) = $5
            AND COALESCE(
              ti.metadata->'adaptiveMarketIntelligence'->>'evidenceClass',
              CASE
                WHEN COALESCE(ti.metadata->>'main_strategy_qualification_evidence', 'false') = 'true'
                  THEN 'QUALIFICATION'
                ELSE 'RESEARCH'
              END
            ) = $6
            AND ti.metadata->>'external_provider_paper_only' = 'true'
            AND t.status = 'CLOSED'
            AND t.close_reason IN ('STOP_LOSS_HIT', 'TAKE_PROFIT_HIT', 'PROFIT_PROTECTION')
          ORDER BY t.closed_at ASC, t.id ASC
        `,
        [
          request.userId,
          request.brokerConnectionId,
          request.evaluatedAt,
          request.decisionPolicyVersion,
          request.strategyRoute,
          evidenceClass,
        ],
      )) as AdaptiveEdgeOutcomeRow[];
      const result = buildAdaptiveEdgeEvidence(rows, request);
      this.cache.set(cacheKey, { expiresAt: Date.now() + 5_000, result });
      return result;
    } catch {
      return unavailable(request);
    }
  }
}
