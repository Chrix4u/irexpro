import type { M1TacticalRoute } from './m1-tactical-route';
import { M1_TACTICAL_POLICY_V1 } from './m1-tactical-candidate';

export type M1ReliabilityRoute = Exclude<M1TacticalRoute, 'ABSTAIN'>;

export const M1_RELIABILITY_MIN_SAMPLES = 5;
export const M1_RELIABILITY_EARLY_LOSS_BRAKE_SAMPLES = 3;
export const M1_RELIABILITY_RECENT_PAYOFF_SAMPLES = 5;
export const M1_RELIABILITY_RECENT_AVERAGE_R_FLOOR = -0.1;
export const M1_RELIABILITY_MAX_SAMPLES = 20;
export const M1_RELIABILITY_CARRY_FORWARD_DAYS = 7;

const POLICY_LINEAGE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'm1-tactical-v1': Object.freeze(['m1-tactical-v1']),
  'm1-tactical-v1-cal1': Object.freeze(['m1-tactical-v1-cal1', 'm1-tactical-v1']),
});

const PRIOR_WINS = 1;
const PRIOR_LOSSES = 1;

export interface M1RoutePairSideEvidenceRow {
  route: M1ReliabilityRoute;
  instrument: string;
  direction: 'BUY' | 'SELL';
  policyVersion: string;
  realisedPnl: number;
  /** USD risk to the original stop for this executed PAPER trade. */
  riskAtStop?: number | null;
  closedAt: Date;
}

export interface M1RoutePairSideReliabilityInput {
  route: M1ReliabilityRoute;
  instrument: string;
  direction: 'BUY' | 'SELL';
  currentPolicyVersion: string;
  evaluatedAt: Date;
  evidenceRows: M1RoutePairSideEvidenceRow[];
}

export type M1RoutePairSideReliabilityReason =
  | 'INSUFFICIENT_EVIDENCE'
  | 'POSITIVE_EXPECTANCY'
  | 'NEGATIVE_EXPECTANCY'
  | 'RECENT_NEGATIVE_PAYOFF'
  | 'PAYOFF_EVIDENCE_INCOMPLETE'
  | 'EARLY_LOSS_STREAK'
  | 'INVALID_EVIDENCE';

export interface M1RoutePairSideReliabilityDecision {
  eligible: boolean;
  samples: number;
  currentPolicySamples: number;
  carriedSamples: number;
  wins: number;
  losses: number;
  smoothedWinRate: number;
  smoothedExpectedR: number;
  realizedRSamples: number;
  averageRealizedR: number | null;
  recentRealizedR: number | null;
  recentPayoffRSamples: number;
  recentPayoffAverageR: number | null;
  reason: M1RoutePairSideReliabilityReason;
  consideredPolicyVersions: string[];
}

function empty(reason: M1RoutePairSideReliabilityReason): M1RoutePairSideReliabilityDecision {
  return {
    eligible: reason === 'INSUFFICIENT_EVIDENCE',
    samples: 0,
    currentPolicySamples: 0,
    carriedSamples: 0,
    wins: 0,
    losses: 0,
    smoothedWinRate: 0.5,
    smoothedExpectedR: 0.5 * M1_TACTICAL_POLICY_V1.targetR - 0.5,
    realizedRSamples: 0,
    averageRealizedR: null,
    recentRealizedR: null,
    recentPayoffRSamples: 0,
    recentPayoffAverageR: null,
    reason,
    consideredPolicyVersions: [],
  };
}

function compatiblePolicies(currentPolicyVersion: string): readonly string[] {
  return POLICY_LINEAGE[currentPolicyVersion] ?? [currentPolicyVersion];
}

export function evaluateM1RoutePairSideReliability(
  input: M1RoutePairSideReliabilityInput,
): M1RoutePairSideReliabilityDecision {
  const evaluatedAtMs = input.evaluatedAt.getTime();
  const instrument = input.instrument.trim().toUpperCase();
  if (
    !Number.isFinite(evaluatedAtMs) ||
    !instrument ||
    !input.currentPolicyVersion.trim() ||
    !Array.isArray(input.evidenceRows)
  ) {
    return empty('INVALID_EVIDENCE');
  }

  const compatible = compatiblePolicies(input.currentPolicyVersion);
  const compatibleSet = new Set(compatible);
  const cutoffMs = evaluatedAtMs - M1_RELIABILITY_CARRY_FORWARD_DAYS * 24 * 60 * 60_000;
  const matching = input.evidenceRows
    .filter((row) => {
      const closedAtMs = row.closedAt instanceof Date ? row.closedAt.getTime() : Number.NaN;
      return (
        row.route === input.route &&
        row.instrument.trim().toUpperCase() === instrument &&
        row.direction === input.direction &&
        compatibleSet.has(row.policyVersion) &&
        Number.isFinite(row.realisedPnl) &&
        row.realisedPnl !== 0 &&
        Number.isFinite(closedAtMs) &&
        closedAtMs <= evaluatedAtMs &&
        closedAtMs >= cutoffMs
      );
    })
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());

  const current = matching
    .filter((row) => row.policyVersion === input.currentPolicyVersion)
    .slice(0, M1_RELIABILITY_MAX_SAMPLES);

  let selected: M1RoutePairSideEvidenceRow[];
  let carriedSamples = 0;
  if (current.length >= M1_RELIABILITY_MIN_SAMPLES) {
    selected = current;
  } else {
    const missing = M1_RELIABILITY_MIN_SAMPLES - current.length;
    const predecessor = matching
      .filter((row) => row.policyVersion !== input.currentPolicyVersion)
      .sort((a, b) => {
        const policyOrder =
          compatible.indexOf(a.policyVersion) - compatible.indexOf(b.policyVersion);
        return policyOrder !== 0 ? policyOrder : b.closedAt.getTime() - a.closedAt.getTime();
      })
      .slice(0, missing);
    carriedSamples = predecessor.length;
    selected = [...current, ...predecessor];
  }

  selected = [...selected].sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());
  const wins = selected.filter((row) => row.realisedPnl > 0).length;
  const losses = selected.filter((row) => row.realisedPnl < 0).length;
  const samples = wins + losses;
  const smoothedWinRate = (wins + PRIOR_WINS) / (samples + PRIOR_WINS + PRIOR_LOSSES);
  const smoothedExpectedR = smoothedWinRate * M1_TACTICAL_POLICY_V1.targetR - (1 - smoothedWinRate);
  const realizedRValues = selected.flatMap((row) => {
    const riskAtStop = Number(row.riskAtStop);
    return Number.isFinite(riskAtStop) && riskAtStop > 0 ? [row.realisedPnl / riskAtStop] : [];
  });
  const realizedRSamples = realizedRValues.length;
  const averageRealizedR =
    realizedRSamples > 0
      ? realizedRValues.reduce((sum, value) => sum + value, 0) / realizedRSamples
      : null;
  const recentRealizedValues = selected.slice(0, 3).flatMap((row) => {
    const riskAtStop = Number(row.riskAtStop);
    return Number.isFinite(riskAtStop) && riskAtStop > 0 ? [row.realisedPnl / riskAtStop] : [];
  });
  const recentRealizedR =
    recentRealizedValues.length > 0
      ? recentRealizedValues.reduce((sum, value) => sum + value, 0)
      : null;
  const recentPayoffRows = selected.slice(0, M1_RELIABILITY_RECENT_PAYOFF_SAMPLES);
  const recentPayoffValues = recentPayoffRows.flatMap((row) => {
    const riskAtStop = Number(row.riskAtStop);
    return Number.isFinite(riskAtStop) && riskAtStop > 0 ? [row.realisedPnl / riskAtStop] : [];
  });
  const recentPayoffRSamples = recentPayoffValues.length;
  const recentPayoffAverageR =
    recentPayoffRows.length === M1_RELIABILITY_RECENT_PAYOFF_SAMPLES &&
    recentPayoffRSamples === M1_RELIABILITY_RECENT_PAYOFF_SAMPLES
      ? recentPayoffValues.reduce((sum, value) => sum + value, 0) /
        M1_RELIABILITY_RECENT_PAYOFF_SAMPLES
      : null;
  const consideredPolicyVersions = compatible.filter((version) =>
    selected.some((row) => row.policyVersion === version),
  );
  const recentLossStreak =
    selected.length >= M1_RELIABILITY_EARLY_LOSS_BRAKE_SAMPLES &&
    selected.slice(0, M1_RELIABILITY_EARLY_LOSS_BRAKE_SAMPLES).every((row) => row.realisedPnl < 0);

  if (recentLossStreak) {
    return {
      eligible: false,
      samples,
      currentPolicySamples: current.length,
      carriedSamples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realizedRSamples,
      averageRealizedR,
      recentRealizedR,
      recentPayoffRSamples,
      recentPayoffAverageR,
      reason: 'EARLY_LOSS_STREAK',
      consideredPolicyVersions: [...consideredPolicyVersions],
    };
  }

  if (samples < M1_RELIABILITY_MIN_SAMPLES) {
    return {
      eligible: true,
      samples,
      currentPolicySamples: current.length,
      carriedSamples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realizedRSamples,
      averageRealizedR,
      recentRealizedR,
      recentPayoffRSamples,
      recentPayoffAverageR,
      reason: 'INSUFFICIENT_EVIDENCE',
      consideredPolicyVersions: [...consideredPolicyVersions],
    };
  }

  // Once the sleeve has enough executed evidence to govern admission, every
  // selected trade must also have provable initial-risk geometry. Falling back
  // to win-count expectancy here lets tiny protected wins mask full-stop losses.
  // Cold-start sleeves may still learn below the normal sample floor, but mature
  // execution is fail-closed until payoff evidence is complete.
  if (realizedRSamples !== samples) {
    return {
      eligible: false,
      samples,
      currentPolicySamples: current.length,
      carriedSamples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realizedRSamples,
      averageRealizedR,
      recentRealizedR,
      recentPayoffRSamples,
      recentPayoffAverageR,
      reason: 'PAYOFF_EVIDENCE_INCOMPLETE',
      consideredPolicyVersions: [...consideredPolicyVersions],
    };
  }

  const fullWindowEligible = (averageRealizedR ?? 0) > 0;
  if (!fullWindowEligible) {
    return {
      eligible: false,
      samples,
      currentPolicySamples: current.length,
      carriedSamples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realizedRSamples,
      averageRealizedR,
      recentRealizedR,
      recentPayoffRSamples,
      recentPayoffAverageR,
      reason: 'NEGATIVE_EXPECTANCY',
      consideredPolicyVersions: [...consideredPolicyVersions],
    };
  }

  const recentPayoffDecayed =
    recentPayoffRSamples === M1_RELIABILITY_RECENT_PAYOFF_SAMPLES &&
    recentPayoffAverageR !== null &&
    recentPayoffAverageR < M1_RELIABILITY_RECENT_AVERAGE_R_FLOOR;
  if (recentPayoffDecayed) {
    return {
      eligible: false,
      samples,
      currentPolicySamples: current.length,
      carriedSamples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realizedRSamples,
      averageRealizedR,
      recentRealizedR,
      recentPayoffRSamples,
      recentPayoffAverageR,
      reason: 'RECENT_NEGATIVE_PAYOFF',
      consideredPolicyVersions: [...consideredPolicyVersions],
    };
  }

  return {
    eligible: true,
    samples,
    currentPolicySamples: current.length,
    carriedSamples,
    wins,
    losses,
    smoothedWinRate,
    smoothedExpectedR,
    realizedRSamples,
    averageRealizedR,
    recentRealizedR,
    recentPayoffRSamples,
    recentPayoffAverageR,
    reason: 'POSITIVE_EXPECTANCY',
    consideredPolicyVersions: [...consideredPolicyVersions],
  };
}
