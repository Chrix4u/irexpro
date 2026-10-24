export const ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_ARTIFACT = 'adaptive-shadow-directional-pulse-v1';
export const ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MAX_OUTCOMES_PER_SIDE = 10;
export const ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MIN_OUTCOMES_PER_SIDE = 4;
export const ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_DECAY = 0.65;

export interface AdaptiveShadowDirectionalOutcome {
  direction: 'BUY' | 'SELL';
  netR: number;
  resolvedAt: Date | string;
}

export type AdaptiveShadowDirectionalPulseStatus =
  | 'INSUFFICIENT'
  | 'OPPOSED'
  | 'NEUTRAL'
  | 'SUPPORTED';

export interface AdaptiveShadowDirectionalPulseDecision {
  artifact: typeof ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_ARTIFACT;
  available: boolean;
  direction: 'BUY' | 'SELL';
  status: AdaptiveShadowDirectionalPulseStatus;
  candidateSamples: number;
  oppositeSamples: number;
  candidateWeightedR: number;
  oppositeWeightedR: number;
  advantageR: number;
  quality: number;
}

export interface AdaptiveShadowDirectionalPulseInput {
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date;
  outcomes: readonly AdaptiveShadowDirectionalOutcome[];
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function resolvedAtMs(value: Date | string): number | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function latestResolved(
  outcomes: readonly AdaptiveShadowDirectionalOutcome[],
  direction: 'BUY' | 'SELL',
  evaluatedAtMs: number,
): AdaptiveShadowDirectionalOutcome[] {
  return outcomes
    .filter((outcome) => {
      if (outcome.direction !== direction || !Number.isFinite(outcome.netR)) return false;
      const resolvedMs = resolvedAtMs(outcome.resolvedAt);
      return resolvedMs !== null && resolvedMs < evaluatedAtMs;
    })
    .sort((a, b) => resolvedAtMs(a.resolvedAt)! - resolvedAtMs(b.resolvedAt)!)
    .slice(-ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MAX_OUTCOMES_PER_SIDE);
}

function exponentiallyWeightedMean(outcomes: readonly AdaptiveShadowDirectionalOutcome[]): number {
  if (!outcomes.length) return 0;
  let numerator = 0;
  let denominator = 0;
  const newestFirst = [...outcomes].reverse();
  for (let index = 0; index < newestFirst.length; index += 1) {
    const weight = ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_DECAY ** index;
    numerator += newestFirst[index]!.netR * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Builds a causal, ranking-only directional pulse from already-resolved shadow outcomes.
 * Future/unresolved evidence is ignored. Sparse evidence returns a neutral quality so it
 * can neither promote nor penalize the candidate.
 */
export function buildAdaptiveShadowDirectionalPulse(
  input: AdaptiveShadowDirectionalPulseInput,
): AdaptiveShadowDirectionalPulseDecision {
  const evaluatedAtMs = input.evaluatedAt.getTime();
  const oppositeDirection = input.direction === 'BUY' ? 'SELL' : 'BUY';
  const candidateOutcomes = latestResolved(input.outcomes, input.direction, evaluatedAtMs);
  const oppositeOutcomes = latestResolved(input.outcomes, oppositeDirection, evaluatedAtMs);
  const candidateWeightedR = exponentiallyWeightedMean(candidateOutcomes);
  const oppositeWeightedR = exponentiallyWeightedMean(oppositeOutcomes);
  const advantageR = candidateWeightedR - oppositeWeightedR;

  if (
    !Number.isFinite(evaluatedAtMs) ||
    candidateOutcomes.length < ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MIN_OUTCOMES_PER_SIDE ||
    oppositeOutcomes.length < ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MIN_OUTCOMES_PER_SIDE
  ) {
    return {
      artifact: ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_ARTIFACT,
      available: false,
      direction: input.direction,
      status: 'INSUFFICIENT',
      candidateSamples: candidateOutcomes.length,
      oppositeSamples: oppositeOutcomes.length,
      candidateWeightedR,
      oppositeWeightedR,
      advantageR,
      quality: 0.5,
    };
  }

  const quality = clamp01(0.5 + advantageR / 4);
  const status: AdaptiveShadowDirectionalPulseStatus =
    advantageR >= 0.5 && candidateWeightedR > 0
      ? 'SUPPORTED'
      : advantageR <= -0.5 && oppositeWeightedR > 0
        ? 'OPPOSED'
        : 'NEUTRAL';

  return {
    artifact: ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_ARTIFACT,
    available: true,
    direction: input.direction,
    status,
    candidateSamples: candidateOutcomes.length,
    oppositeSamples: oppositeOutcomes.length,
    candidateWeightedR,
    oppositeWeightedR,
    advantageR,
    quality,
  };
}
