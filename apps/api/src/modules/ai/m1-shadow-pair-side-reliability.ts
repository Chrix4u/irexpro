import type { M1TacticalRoute } from './m1-tactical-route';

export const M1_SHADOW_MICRO_MIN_SAMPLES = 3;
export const M1_SHADOW_MICRO_MAX_SAMPLES = 20;
export const M1_SHADOW_MICRO_MAX_AGE_DAYS = 7;
export const M1_SHADOW_MICRO_MIN_PROFIT_FACTOR = 1.5;
export const M1_SHADOW_MICRO_MIN_AVERAGE_R = 0.1;
export const M1_SHADOW_MICRO_MIN_POSITIVE_FRACTION = 0.4;

export interface M1ShadowPairSideOutcome {
  observedAt: Date;
  netR: number;
}

export interface M1ShadowPairSideReliabilityInput {
  route: M1TacticalRoute;
  evaluatedAt: Date;
  outcomes: M1ShadowPairSideOutcome[];
}

export type M1ShadowPairSideReliabilityReason =
  | 'POSITIVE_SHADOW_EXPECTANCY'
  | 'INSUFFICIENT_SHADOW_EVIDENCE'
  | 'WEAK_SHADOW_EXPECTANCY'
  | 'RECENT_SHADOW_LOSS_STREAK'
  | 'ROUTE_NOT_MICRO_ELIGIBLE'
  | 'INVALID_SHADOW_EVIDENCE';

export interface M1ShadowPairSideReliabilityDecision {
  eligible: boolean;
  reason: M1ShadowPairSideReliabilityReason;
  samples: number;
  positive: number;
  nonPositive: number;
  averageNetR: number;
  totalNetR: number;
  profitFactor: number | null;
  positiveFraction: number;
}

function decision(
  eligible: boolean,
  reason: M1ShadowPairSideReliabilityReason,
  selected: M1ShadowPairSideOutcome[] = [],
): M1ShadowPairSideReliabilityDecision {
  const positive = selected.filter((row) => row.netR > 0).length;
  const nonPositive = selected.length - positive;
  const totalNetR = selected.reduce((sum, row) => sum + row.netR, 0);
  const grossProfit = selected.reduce((sum, row) => sum + Math.max(row.netR, 0), 0);
  const grossLoss = -selected.reduce((sum, row) => sum + Math.min(row.netR, 0), 0);
  return {
    eligible,
    reason,
    samples: selected.length,
    positive,
    nonPositive,
    averageNetR: selected.length > 0 ? totalNetR / selected.length : 0,
    totalNetR,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
    positiveFraction: selected.length > 0 ? positive / selected.length : 0,
  };
}

export function evaluateM1ShadowPairSideReliability(
  input: M1ShadowPairSideReliabilityInput,
): M1ShadowPairSideReliabilityDecision {
  const evaluatedAtMs = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedAtMs) || !Array.isArray(input.outcomes)) {
    return decision(false, 'INVALID_SHADOW_EVIDENCE');
  }
  if (input.route !== 'M1_EARLY_TRANSITION') {
    return decision(false, 'ROUTE_NOT_MICRO_ELIGIBLE');
  }

  const cutoff = evaluatedAtMs - M1_SHADOW_MICRO_MAX_AGE_DAYS * 24 * 60 * 60_000;
  const selected = input.outcomes
    .filter((row) => {
      const observedAtMs = row.observedAt instanceof Date ? row.observedAt.getTime() : Number.NaN;
      return (
        Number.isFinite(observedAtMs) &&
        observedAtMs <= evaluatedAtMs &&
        observedAtMs >= cutoff &&
        Number.isFinite(row.netR)
      );
    })
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
    .slice(0, M1_SHADOW_MICRO_MAX_SAMPLES);

  if (selected.length < M1_SHADOW_MICRO_MIN_SAMPLES) {
    return decision(false, 'INSUFFICIENT_SHADOW_EVIDENCE', selected);
  }
  if (selected.slice(0, 3).every((row) => row.netR <= 0)) {
    return decision(false, 'RECENT_SHADOW_LOSS_STREAK', selected);
  }

  const metrics = decision(false, 'WEAK_SHADOW_EXPECTANCY', selected);
  const profitable =
    metrics.profitFactor !== null &&
    metrics.profitFactor >= M1_SHADOW_MICRO_MIN_PROFIT_FACTOR &&
    metrics.averageNetR >= M1_SHADOW_MICRO_MIN_AVERAGE_R &&
    metrics.positiveFraction >= M1_SHADOW_MICRO_MIN_POSITIVE_FRACTION;

  return profitable
    ? { ...metrics, eligible: true, reason: 'POSITIVE_SHADOW_EXPECTANCY' }
    : metrics;
}
