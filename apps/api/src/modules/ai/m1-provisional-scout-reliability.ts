import type { M1TacticalRoute } from './m1-tactical-route';

export const M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT =
  'm1-provisional-scout-reliability-v1' as const;
export const M1_PROVISIONAL_SCOUT_MIN_SAMPLES = 3;
export const M1_PROVISIONAL_SCOUT_MATURE_SAMPLE_FLOOR = 6;
export const M1_PROVISIONAL_SCOUT_MAX_AGE_DAYS = 7;
export const M1_PROVISIONAL_SCOUT_MIN_PROFIT_FACTOR = 2.0;
export const M1_PROVISIONAL_SCOUT_MIN_AVERAGE_R = 0.2;
export const M1_PROVISIONAL_SCOUT_MIN_POSITIVE_FRACTION = 0.5;
export const M1_PROVISIONAL_SCOUT_LOT_CAP = 0.05;

export interface M1ProvisionalScoutOutcome {
  observedAt: Date;
  netR: number;
}

export type M1ProvisionalScoutReliabilityReason =
  | 'POSITIVE_PROVISIONAL_EXPECTANCY'
  | 'INSUFFICIENT_PROVISIONAL_EVIDENCE'
  | 'MATURE_EVIDENCE_AVAILABLE'
  | 'WEAK_PROVISIONAL_EXPECTANCY'
  | 'RECENT_PROVISIONAL_DEGRADATION'
  | 'ROUTE_NOT_PROVISIONAL_SCOUT_ELIGIBLE'
  | 'INVALID_PROVISIONAL_EVIDENCE';

export interface M1ProvisionalScoutReliabilityDecision {
  artifact: typeof M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT;
  eligible: boolean;
  tier: 'PROVISIONAL' | 'NONE';
  reason: M1ProvisionalScoutReliabilityReason;
  samples: number;
  positive: number;
  nonPositive: number;
  averageNetR: number;
  totalNetR: number;
  profitFactor: number | null;
  positiveFraction: number;
  recentNetR: number;
  lotCap: number;
}

function summarize(
  eligible: boolean,
  reason: M1ProvisionalScoutReliabilityReason,
  selected: M1ProvisionalScoutOutcome[] = [],
): M1ProvisionalScoutReliabilityDecision {
  const positive = selected.filter((row) => row.netR > 0).length;
  const totalNetR = selected.reduce((sum, row) => sum + row.netR, 0);
  const grossProfit = selected.reduce((sum, row) => sum + Math.max(row.netR, 0), 0);
  const grossLoss = -selected.reduce((sum, row) => sum + Math.min(row.netR, 0), 0);
  const recentNetR = selected.slice(0, 3).reduce((sum, row) => sum + row.netR, 0);
  return {
    artifact: M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT,
    eligible,
    tier: eligible ? 'PROVISIONAL' : 'NONE',
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
    lotCap: M1_PROVISIONAL_SCOUT_LOT_CAP,
  };
}

export function evaluateM1ProvisionalScoutReliability(input: {
  route: M1TacticalRoute;
  evaluatedAt: Date;
  outcomes: M1ProvisionalScoutOutcome[];
}): M1ProvisionalScoutReliabilityDecision {
  const evaluatedAtMs = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedAtMs) || !Array.isArray(input.outcomes)) {
    return summarize(false, 'INVALID_PROVISIONAL_EVIDENCE');
  }
  if (input.route !== 'M1_EARLY_TRANSITION') {
    return summarize(false, 'ROUTE_NOT_PROVISIONAL_SCOUT_ELIGIBLE');
  }

  const cutoff = evaluatedAtMs - M1_PROVISIONAL_SCOUT_MAX_AGE_DAYS * 24 * 60 * 60_000;
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
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());

  if (selected.length >= M1_PROVISIONAL_SCOUT_MATURE_SAMPLE_FLOOR) {
    return summarize(false, 'MATURE_EVIDENCE_AVAILABLE', selected);
  }
  if (selected.length < M1_PROVISIONAL_SCOUT_MIN_SAMPLES) {
    return summarize(false, 'INSUFFICIENT_PROVISIONAL_EVIDENCE', selected);
  }

  const metrics = summarize(false, 'WEAK_PROVISIONAL_EXPECTANCY', selected);
  if (metrics.recentNetR <= 0) {
    return { ...metrics, reason: 'RECENT_PROVISIONAL_DEGRADATION' };
  }
  const profitable =
    metrics.profitFactor !== null &&
    metrics.profitFactor >= M1_PROVISIONAL_SCOUT_MIN_PROFIT_FACTOR &&
    metrics.averageNetR >= M1_PROVISIONAL_SCOUT_MIN_AVERAGE_R &&
    metrics.positiveFraction >= M1_PROVISIONAL_SCOUT_MIN_POSITIVE_FRACTION;

  return profitable
    ? { ...metrics, eligible: true, tier: 'PROVISIONAL', reason: 'POSITIVE_PROVISIONAL_EXPECTANCY' }
    : metrics;
}
