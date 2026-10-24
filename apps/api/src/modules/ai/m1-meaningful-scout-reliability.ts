import type { M1TacticalRoute } from './m1-tactical-route';

export const M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT =
  'm1-meaningful-scout-reliability-v1' as const;
export const M1_MEANINGFUL_SCOUT_MIN_SAMPLES = 6;
export const M1_MEANINGFUL_SCOUT_MAX_SAMPLES = 20;
export const M1_MEANINGFUL_SCOUT_MAX_AGE_DAYS = 7;
export const M1_MEANINGFUL_SCOUT_MIN_PROFIT_FACTOR = 1.5;
export const M1_MEANINGFUL_SCOUT_MIN_AVERAGE_R = 0.1;
export const M1_MEANINGFUL_SCOUT_MIN_POSITIVE_FRACTION = 0.4;
export const M1_MEANINGFUL_SCOUT_RECENT_SAMPLE_COUNT = 3;

export interface M1MeaningfulScoutOutcome {
  observedAt: Date;
  netR: number;
}

export interface M1MeaningfulScoutReliabilityInput {
  route: M1TacticalRoute;
  evaluatedAt: Date;
  outcomes: M1MeaningfulScoutOutcome[];
}

export type M1MeaningfulScoutReliabilityReason =
  | 'POSITIVE_MEANINGFUL_EXPECTANCY'
  | 'INSUFFICIENT_MEANINGFUL_EVIDENCE'
  | 'WEAK_MEANINGFUL_EXPECTANCY'
  | 'RECENT_MEANINGFUL_DEGRADATION'
  | 'ROUTE_NOT_MEANINGFUL_SCOUT_ELIGIBLE'
  | 'INVALID_MEANINGFUL_EVIDENCE';

export interface M1MeaningfulScoutReliabilityDecision {
  artifact: typeof M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT;
  eligible: boolean;
  reason: M1MeaningfulScoutReliabilityReason;
  samples: number;
  positive: number;
  nonPositive: number;
  averageNetR: number;
  totalNetR: number;
  profitFactor: number | null;
  positiveFraction: number;
  recentNetR: number;
}

function summarize(
  eligible: boolean,
  reason: M1MeaningfulScoutReliabilityReason,
  selected: M1MeaningfulScoutOutcome[] = [],
): M1MeaningfulScoutReliabilityDecision {
  const positive = selected.filter((row) => row.netR > 0).length;
  const totalNetR = selected.reduce((sum, row) => sum + row.netR, 0);
  const grossProfit = selected.reduce((sum, row) => sum + Math.max(row.netR, 0), 0);
  const grossLoss = -selected.reduce((sum, row) => sum + Math.min(row.netR, 0), 0);
  const recentNetR = selected
    .slice(0, M1_MEANINGFUL_SCOUT_RECENT_SAMPLE_COUNT)
    .reduce((sum, row) => sum + row.netR, 0);
  return {
    artifact: M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT,
    eligible,
    reason,
    samples: selected.length,
    positive,
    nonPositive: selected.length - positive,
    averageNetR: selected.length ? totalNetR / selected.length : 0,
    totalNetR,
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
    positiveFraction: selected.length ? positive / selected.length : 0,
    recentNetR,
  };
}

export function evaluateM1MeaningfulScoutReliability(
  input: M1MeaningfulScoutReliabilityInput,
): M1MeaningfulScoutReliabilityDecision {
  const evaluatedAtMs = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedAtMs) || !Array.isArray(input.outcomes)) {
    return summarize(false, 'INVALID_MEANINGFUL_EVIDENCE');
  }
  if (input.route !== 'M1_EARLY_TRANSITION') {
    return summarize(false, 'ROUTE_NOT_MEANINGFUL_SCOUT_ELIGIBLE');
  }

  const cutoff = evaluatedAtMs - M1_MEANINGFUL_SCOUT_MAX_AGE_DAYS * 24 * 60 * 60_000;
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
    .slice(0, M1_MEANINGFUL_SCOUT_MAX_SAMPLES);

  if (selected.length < M1_MEANINGFUL_SCOUT_MIN_SAMPLES) {
    return summarize(false, 'INSUFFICIENT_MEANINGFUL_EVIDENCE', selected);
  }

  const metrics = summarize(false, 'WEAK_MEANINGFUL_EXPECTANCY', selected);
  if (metrics.recentNetR <= 0) {
    return { ...metrics, reason: 'RECENT_MEANINGFUL_DEGRADATION' };
  }

  const profitable =
    metrics.profitFactor !== null &&
    metrics.profitFactor >= M1_MEANINGFUL_SCOUT_MIN_PROFIT_FACTOR &&
    metrics.averageNetR >= M1_MEANINGFUL_SCOUT_MIN_AVERAGE_R &&
    metrics.positiveFraction >= M1_MEANINGFUL_SCOUT_MIN_POSITIVE_FRACTION;

  return profitable
    ? { ...metrics, eligible: true, reason: 'POSITIVE_MEANINGFUL_EXPECTANCY' }
    : metrics;
}
