import type { M1RoutePairSideReliabilityDecision } from './m1-tactical-reliability';

export const M1_TACTICAL_EXPECTANCY_ARTIFACT = 'm1-tactical-statistical-expectancy-v2';
export const M1_EXPECTANCY_REALISED_MIN_SAMPLES = 5;
export const M1_EXPECTANCY_PRIOR_WEIGHT = 5;
export const M1_EXPECTANCY_RECENT_WEIGHT = 0.25;

export type M1TacticalExpectancySource = 'HEURISTIC_PRIOR' | 'REALISED_PAIR_SIDE';

export interface M1TacticalExpectancyInput {
  targetR: number;
  confidence: number;
  directionQuality: number;
  reliability?: M1RoutePairSideReliabilityDecision | null;
}

export interface M1TacticalExpectancyDecision {
  artifact: typeof M1_TACTICAL_EXPECTANCY_ARTIFACT;
  source: M1TacticalExpectancySource;
  targetR: number;
  breakevenWinProbability: number;
  heuristicQuality: number;
  impliedWinProbability: number;
  heuristicPriorExpectedR: number;
  evidenceSamples: number;
  evidenceAverageRealizedR: number | null;
  recentPayoffSamples: number;
  recentPayoffAverageR: number | null;
  recentPayoffApplied: boolean;
  statisticalExpectedR: number;
}

function finite(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteUnit(value: unknown): number {
  const number = finite(value);
  return number === null ? 0.5 : clamp(number, 0, 1);
}

export function evaluateM1TacticalExpectancy(
  input: M1TacticalExpectancyInput,
): M1TacticalExpectancyDecision {
  const suppliedTargetR = finite(input.targetR);
  const targetR = suppliedTargetR !== null && suppliedTargetR > 0 ? suppliedTargetR : 1;
  const breakevenWinProbability = 1 / (1 + targetR);
  const confidence = finiteUnit(input.confidence);
  const directionQuality = finiteUnit(input.directionQuality);
  const heuristicQuality = (confidence + directionQuality) / 2;
  const impliedWinProbability = clamp(
    breakevenWinProbability + 0.5 * (heuristicQuality - 0.5),
    Math.max(0, breakevenWinProbability - 0.1),
    Math.min(1, breakevenWinProbability + 0.2),
  );
  const heuristicPriorExpectedR =
    impliedWinProbability * targetR - (1 - impliedWinProbability);

  const reliability = input.reliability ?? null;
  const evidenceSamples = Math.max(0, Math.floor(finite(reliability?.realizedRSamples) ?? 0));
  const evidenceAverageRealizedR = finite(reliability?.averageRealizedR);
  const recentPayoffSamples = Math.max(
    0,
    Math.floor(finite(reliability?.recentPayoffRSamples) ?? 0),
  );
  const recentPayoffAverageR = finite(reliability?.recentPayoffAverageR);
  const hasRealisedEvidence =
    evidenceSamples >= M1_EXPECTANCY_REALISED_MIN_SAMPLES && evidenceAverageRealizedR !== null;

  let source: M1TacticalExpectancySource = 'HEURISTIC_PRIOR';
  let statisticalExpectedR = heuristicPriorExpectedR;
  if (hasRealisedEvidence) {
    source = 'REALISED_PAIR_SIDE';
    const evidenceWeight = Math.min(evidenceSamples, 20);
    statisticalExpectedR =
      (heuristicPriorExpectedR * M1_EXPECTANCY_PRIOR_WEIGHT +
        evidenceAverageRealizedR * evidenceWeight) /
      (M1_EXPECTANCY_PRIOR_WEIGHT + evidenceWeight);
  }

  const recentPayoffApplied =
    hasRealisedEvidence && recentPayoffSamples >= 5 && recentPayoffAverageR !== null;
  if (recentPayoffApplied) {
    statisticalExpectedR =
      statisticalExpectedR * (1 - M1_EXPECTANCY_RECENT_WEIGHT) +
      recentPayoffAverageR * M1_EXPECTANCY_RECENT_WEIGHT;
  }

  const safeExpectedR = Number.isFinite(statisticalExpectedR)
    ? clamp(statisticalExpectedR, -1.5, Math.max(1.5, targetR))
    : 0;

  return {
    artifact: M1_TACTICAL_EXPECTANCY_ARTIFACT,
    source,
    targetR,
    breakevenWinProbability,
    heuristicQuality,
    impliedWinProbability,
    heuristicPriorExpectedR,
    evidenceSamples,
    evidenceAverageRealizedR,
    recentPayoffSamples,
    recentPayoffAverageR,
    recentPayoffApplied,
    statisticalExpectedR: safeExpectedR,
  };
}
