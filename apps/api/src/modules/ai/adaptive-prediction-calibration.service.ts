import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AdaptiveMarketSession, AdaptiveMarketState } from './adaptive-market-state';

export const ADAPTIVE_PREDICTION_CALIBRATION_ARTIFACT = 'adaptive-prediction-calibration-v1';
export const ADAPTIVE_CALIBRATION_MIN_AUTHORITATIVE_SAMPLES = 12;
export const ADAPTIVE_CALIBRATION_MATURE_MIN_SAMPLES = 20;
export const ADAPTIVE_CALIBRATION_MIN_WINS = 5;
export const ADAPTIVE_CALIBRATION_MIN_LOSSES = 5;
export const ADAPTIVE_CALIBRATION_RESCUE_MIN_NET_EXPECTED_R = 0.12;
const ADAPTIVE_CALIBRATION_PRIOR_WEIGHT = 8;

export type AdaptivePredictionCalibrationMaturity = 'SPARSE' | 'COLLECTING' | 'MATURE' | 'DEGRADED';
export type AdaptivePredictionCalibrationSource =
  | 'EXACT'
  | 'PAIR_DIRECTION_ROUTE'
  | 'ROUTE'
  | 'GLOBAL'
  | 'NONE';

export interface AdaptivePredictionCalibrationRequest {
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  session: AdaptiveMarketSession;
  state: AdaptiveMarketState;
  strategyRoute: string;
  decisionPolicyVersions: readonly string[];
  evaluatedAt: Date;
  rawConfidence: number;
  rawNetExpectedR: number;
}

export interface AdaptivePredictionOutcomeRow {
  instrument: string;
  direction: 'BUY' | 'SELL';
  strategy_route: string | null;
  adaptive_state: string | null;
  legacy_regime: string | null;
  adaptive_session: string | null;
  evaluated_at: Date | string;
  outcome_resolved_at?: Date | string | null;
  outcome_status: string | null;
  outcome_net_r: number | string | null;
}

export interface AdaptivePredictionCalibrationDecision {
  artifact: typeof ADAPTIVE_PREDICTION_CALIBRATION_ARTIFACT;
  available: boolean;
  authoritative: boolean;
  sourceLevel: AdaptivePredictionCalibrationSource;
  maturity: AdaptivePredictionCalibrationMaturity;
  samples: number;
  wins: number;
  losses: number;
  empiricalWinRate: number | null;
  rawConfidence: number;
  calibratedWinProbability: number;
  confidenceCorrection: number;
  rawNetExpectedR: number;
  calibratedNetExpectedR: number;
  profitFactor: number | null;
  recentDegradation: boolean;
  blockRecommended: boolean;
  rescueEligible: boolean;
  reason: string;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function sessionOf(row: AdaptivePredictionOutcomeRow): AdaptiveMarketSession | null {
  if (
    row.adaptive_session === 'ASIA' ||
    row.adaptive_session === 'LONDON' ||
    row.adaptive_session === 'NEW_YORK' ||
    row.adaptive_session === 'ROLLOVER'
  ) {
    return row.adaptive_session;
  }
  const time = new Date(row.evaluated_at);
  if (!Number.isFinite(time.getTime())) return null;
  const hour = time.getUTCHours();
  if (hour >= 21) return 'ROLLOVER';
  if (hour < 7) return 'ASIA';
  if (hour < 13) return 'LONDON';
  return 'NEW_YORK';
}

function stateOf(row: AdaptivePredictionOutcomeRow): AdaptiveMarketState | null {
  const state = row.adaptive_state;
  if (
    state === 'TREND_HEALTHY' ||
    state === 'TREND_EXTENDED' ||
    state === 'TREND_WEAK' ||
    state === 'RANGE' ||
    state === 'TRANSITION' ||
    state === 'REVERSAL' ||
    state === 'HIGH_VOLATILITY' ||
    state === 'DISLOCATED' ||
    state === 'ROLLOVER_RISK' ||
    state === 'UNKNOWN'
  ) {
    return state;
  }
  switch (row.legacy_regime) {
    case 'TREND_HEALTHY':
    case 'TREND_EXTENDED':
    case 'TREND_WEAK':
    case 'ROLLOVER_RISK':
      return row.legacy_regime;
    case 'REVERSAL_CONFIRMED':
      return 'REVERSAL';
    case 'TRANSITION_EARLY':
      return 'TRANSITION';
    case 'VOLATILE':
      return 'HIGH_VOLATILITY';
    default:
      return null;
  }
}

function profitFactor(values: number[]): number | null {
  const grossProfit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = -values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  if (grossLoss === 0) return grossProfit > 0 ? 1_000_000 : null;
  return grossProfit / grossLoss;
}

function rowResolvedBefore(row: AdaptivePredictionOutcomeRow, evaluatedAt: Date): boolean {
  const decisionAt = new Date(row.evaluated_at).getTime();
  const resolvedAt = new Date(row.outcome_resolved_at ?? row.evaluated_at).getTime();
  return (
    Number.isFinite(decisionAt) &&
    Number.isFinite(resolvedAt) &&
    decisionAt < evaluatedAt.getTime() &&
    resolvedAt < evaluatedAt.getTime()
  );
}

function validRows(
  rows: AdaptivePredictionOutcomeRow[],
  evaluatedAt: Date,
): Array<AdaptivePredictionOutcomeRow & { netR: number }> {
  return rows.flatMap((row) => {
    if (!rowResolvedBefore(row, evaluatedAt)) return [];
    if (row.outcome_status !== 'WIN' && row.outcome_status !== 'LOSS') return [];
    const netR = finite(row.outcome_net_r);
    return netR === null ? [] : [{ ...row, netR }];
  });
}

function chooseEvidence(
  rows: Array<AdaptivePredictionOutcomeRow & { netR: number }>,
  request: AdaptivePredictionCalibrationRequest,
): {
  sourceLevel: AdaptivePredictionCalibrationSource;
  rows: Array<AdaptivePredictionOutcomeRow & { netR: number }>;
} {
  const route = rows.filter((row) => row.strategy_route === request.strategyRoute);
  const pairDirectionRoute = route.filter(
    (row) => row.instrument === request.instrument && row.direction === request.direction,
  );
  const exact = pairDirectionRoute.filter(
    (row) => sessionOf(row) === request.session && stateOf(row) === request.state,
  );
  const candidates = [
    ['EXACT', exact],
    ['PAIR_DIRECTION_ROUTE', pairDirectionRoute],
    ['ROUTE', route],
    ['GLOBAL', rows],
  ] as const;
  for (const [sourceLevel, bucket] of candidates) {
    if (bucket.length >= ADAPTIVE_CALIBRATION_MIN_AUTHORITATIVE_SAMPLES) {
      return { sourceLevel, rows: bucket };
    }
  }
  for (const [sourceLevel, bucket] of candidates) {
    if (bucket.length > 0) return { sourceLevel, rows: bucket };
  }
  return { sourceLevel: 'NONE', rows: [] };
}

export function unavailableAdaptivePredictionCalibration(
  request: Pick<AdaptivePredictionCalibrationRequest, 'rawConfidence' | 'rawNetExpectedR'>,
): AdaptivePredictionCalibrationDecision {
  const rawConfidence = clamp01(request.rawConfidence);
  const rawNetExpectedR = finite(request.rawNetExpectedR) ?? Number.NEGATIVE_INFINITY;
  return {
    artifact: ADAPTIVE_PREDICTION_CALIBRATION_ARTIFACT,
    available: false,
    authoritative: false,
    sourceLevel: 'NONE',
    maturity: 'SPARSE',
    samples: 0,
    wins: 0,
    losses: 0,
    empiricalWinRate: null,
    rawConfidence,
    calibratedWinProbability: rawConfidence,
    confidenceCorrection: 0,
    rawNetExpectedR,
    calibratedNetExpectedR: rawNetExpectedR,
    profitFactor: null,
    recentDegradation: false,
    blockRecommended: false,
    rescueEligible: false,
    reason: 'CALIBRATION_EVIDENCE_UNAVAILABLE',
  };
}

export function buildAdaptivePredictionCalibration(
  rows: AdaptivePredictionOutcomeRow[],
  request: AdaptivePredictionCalibrationRequest,
): AdaptivePredictionCalibrationDecision {
  const valid = validRows(rows, request.evaluatedAt);
  const selected = chooseEvidence(valid, request);
  const sample = selected.rows;
  const samples = sample.length;
  const wins = sample.filter((row) => row.outcome_status === 'WIN').length;
  const losses = sample.filter((row) => row.outcome_status === 'LOSS').length;
  const rawConfidence = clamp01(request.rawConfidence);
  const rawNetExpectedR = finite(request.rawNetExpectedR) ?? Number.NEGATIVE_INFINITY;
  const empiricalWinRate = samples ? wins / samples : null;
  const values = sample.map((row) => row.netR);
  const pf = profitFactor(values);
  const recent = sample.slice(-8);
  const recentWins = recent.filter((row) => row.outcome_status === 'WIN').length;
  const recentNetR = recent.reduce((sum, row) => sum + row.netR, 0);
  const recentDegradation = recent.length >= 8 && recentWins <= 1 && recentNetR < 0;
  const authoritative = samples >= ADAPTIVE_CALIBRATION_MIN_AUTHORITATIVE_SAMPLES;

  if (!authoritative) {
    return {
      ...unavailableAdaptivePredictionCalibration(request),
      available: samples > 0,
      sourceLevel: selected.sourceLevel,
      samples,
      wins,
      losses,
      empiricalWinRate,
      profitFactor: pf,
      reason: samples ? 'CALIBRATION_EVIDENCE_SPARSE' : 'CALIBRATION_EVIDENCE_UNAVAILABLE',
    };
  }

  const calibratedWinProbability = clamp01(
    (rawConfidence * ADAPTIVE_CALIBRATION_PRIOR_WEIGHT + wins) /
      (ADAPTIVE_CALIBRATION_PRIOR_WEIGHT + samples),
  );
  const observedNetRSum = values.reduce((sum, value) => sum + value, 0);
  const calibratedNetExpectedR =
    (rawNetExpectedR * ADAPTIVE_CALIBRATION_PRIOR_WEIGHT + observedNetRSum) /
    (ADAPTIVE_CALIBRATION_PRIOR_WEIGHT + samples);
  const mature =
    samples >= ADAPTIVE_CALIBRATION_MATURE_MIN_SAMPLES &&
    wins >= ADAPTIVE_CALIBRATION_MIN_WINS &&
    losses >= ADAPTIVE_CALIBRATION_MIN_LOSSES;
  const maturity: AdaptivePredictionCalibrationMaturity = recentDegradation
    ? 'DEGRADED'
    : mature
      ? 'MATURE'
      : 'COLLECTING';
  const localExecutionEvidence =
    selected.sourceLevel === 'EXACT' || selected.sourceLevel === 'PAIR_DIRECTION_ROUTE';
  const blockRecommended =
    localExecutionEvidence &&
    (maturity === 'DEGRADED' ||
      (maturity === 'MATURE' && (calibratedNetExpectedR <= 0 || calibratedWinProbability < 0.45)));
  const rescueEligible =
    localExecutionEvidence &&
    maturity === 'MATURE' &&
    !recentDegradation &&
    calibratedNetExpectedR >= ADAPTIVE_CALIBRATION_RESCUE_MIN_NET_EXPECTED_R &&
    calibratedWinProbability >= 0.55 &&
    pf !== null &&
    pf >= 1.15;

  return {
    artifact: ADAPTIVE_PREDICTION_CALIBRATION_ARTIFACT,
    available: true,
    authoritative: true,
    sourceLevel: selected.sourceLevel,
    maturity,
    samples,
    wins,
    losses,
    empiricalWinRate,
    rawConfidence,
    calibratedWinProbability,
    confidenceCorrection: calibratedWinProbability - rawConfidence,
    rawNetExpectedR,
    calibratedNetExpectedR,
    profitFactor: pf,
    recentDegradation,
    blockRecommended,
    rescueEligible,
    reason: blockRecommended
      ? 'CALIBRATED_EDGE_UNFAVOURABLE'
      : rescueEligible
        ? 'MATURE_POSITIVE_CALIBRATED_EDGE'
        : 'CALIBRATION_APPLIED',
  };
}

export interface AdaptivePredictionCalibrationAuthorityInput {
  calibration: AdaptivePredictionCalibrationDecision;
  rawConfidence: number;
  rawNetExpectedR: number;
  paperExecutionBlockers: string[];
  allowResearchRescue: boolean;
}

export interface AdaptivePredictionCalibrationAuthorityDecision {
  effectiveConfidence: number;
  effectiveNetExpectedR: number;
  effectivePaperExecutionBlockers: string[];
  blockExecution: boolean;
  rescueApplied: boolean;
}

export function applyAdaptivePredictionCalibrationAuthority(
  input: AdaptivePredictionCalibrationAuthorityInput,
): AdaptivePredictionCalibrationAuthorityDecision {
  if (!input.calibration.authoritative) {
    return {
      effectiveConfidence: input.rawConfidence,
      effectiveNetExpectedR: input.rawNetExpectedR,
      effectivePaperExecutionBlockers: [...input.paperExecutionBlockers],
      blockExecution: false,
      rescueApplied: false,
    };
  }

  let effectivePaperExecutionBlockers = [...input.paperExecutionBlockers];
  const rescueApplied =
    input.allowResearchRescue &&
    input.calibration.rescueEligible &&
    effectivePaperExecutionBlockers.includes('PAPER_NET_EXPECTED_R');
  if (rescueApplied) {
    effectivePaperExecutionBlockers = effectivePaperExecutionBlockers.filter(
      (blocker) => blocker !== 'PAPER_NET_EXPECTED_R',
    );
  }
  const blockExecution = input.calibration.blockRecommended;
  if (
    blockExecution &&
    !effectivePaperExecutionBlockers.includes('ADAPTIVE_CALIBRATION_NEGATIVE_EDGE')
  ) {
    effectivePaperExecutionBlockers.push('ADAPTIVE_CALIBRATION_NEGATIVE_EDGE');
  }

  return {
    effectiveConfidence: input.calibration.calibratedWinProbability,
    effectiveNetExpectedR: input.calibration.calibratedNetExpectedR,
    effectivePaperExecutionBlockers,
    blockExecution,
    rescueApplied,
  };
}

@Injectable()
export class AdaptivePredictionCalibrationService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: AdaptivePredictionCalibrationDecision }
  >();

  constructor(private readonly dataSource: DataSource) {}

  async getCalibration(
    request: AdaptivePredictionCalibrationRequest,
  ): Promise<AdaptivePredictionCalibrationDecision> {
    const cacheKey = [
      request.userId,
      request.brokerConnectionId,
      request.instrument,
      request.direction,
      request.session,
      request.state,
      request.strategyRoute,
      request.decisionPolicyVersions.join(','),
      String(request.rawConfidence),
      String(request.rawNetExpectedR),
      request.evaluatedAt.toISOString(),
    ].join('|');
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    try {
      const rows = (await this.dataSource.query(
        `
          SELECT
            instrument,
            direction,
            components->>'strategyRoute' AS strategy_route,
            components->'adaptiveMarketIntelligence'->'marketState'->>'state' AS adaptive_state,
            regime AS legacy_regime,
            components->'adaptiveMarketIntelligence'->'marketState'->>'session' AS adaptive_session,
            evaluated_at,
            NULLIF(components->'outcome'->>'resolvedAt', '')::timestamptz AS outcome_resolved_at,
            components->'outcome'->>'status' AS outcome_status,
            NULLIF(components->'outcome'->>'netR', '')::numeric AS outcome_net_r
          FROM trading.ensemble_shadow_decisions
          WHERE user_id = $1
            AND broker_connection_id = $2
            AND engine_code = $3
            AND model_version = ANY($4::text[])
            AND evaluated_at < $5
            AND components ? 'outcome'
            AND NULLIF(components->'outcome'->>'resolvedAt', '')::timestamptz < $5
          ORDER BY evaluated_at ASC, id ASC
          LIMIT 4000
        `,
        [
          request.userId,
          request.brokerConnectionId,
          'irexpro-multimodel-ensemble-v1',
          [...request.decisionPolicyVersions],
          request.evaluatedAt,
        ],
      )) as AdaptivePredictionOutcomeRow[];
      const result = buildAdaptivePredictionCalibration(rows, request);
      this.cache.set(cacheKey, { expiresAt: Date.now() + 5_000, result });
      return result;
    } catch {
      return unavailableAdaptivePredictionCalibration(request);
    }
  }
}
