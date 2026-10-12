import { PLAN_B_SHADOW_ADMISSION_THRESHOLD } from './v8-shadow-meta-scorer';

export const PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY = 0.64;
export const PAIRED_REVERSAL_MIN_ABSOLUTE_PROBABILITY = PLAN_B_SHADOW_ADMISSION_THRESHOLD;
export const PAIRED_REVERSAL_MIN_ALIGNED_MOMENTUM_ATR = 0.15;
export const PAIRED_REVERSAL_MIN_RESEARCH_NET_EXPECTED_R = 0.08;

export type PairedDirection = 'BUY' | 'SELL';
export type PairedReversalBaseRegime =
  | 'TREND_HEALTHY'
  | 'TREND_WEAK'
  | 'TREND_EXTENDED'
  | 'VOLATILE'
  | 'ROLLOVER_RISK'
  | 'REVERSAL_CONFIRMED'
  | 'TRANSITION_EARLY';

export type PairedDirectionReversalReason =
  | 'INVALID_INPUT'
  | 'DIRECTION_EDGE_TOO_SMALL'
  | 'PRIMARY_SIDE_STILL_PREFERRED'
  | 'ABSOLUTE_TRADABILITY_TOO_LOW'
  | 'REVERSAL_REGIME_NOT_SUPPORTED'
  | 'REVERSAL_MOMENTUM_NOT_CONFIRMED'
  | 'RESEARCH_NET_EXPECTED_R_TOO_LOW'
  | 'PAIRED_REVERSAL_CANDIDATE';

export interface PairedDirectionReversalInput {
  primaryDirection: PairedDirection;
  buyProbability: number;
  sellProbability: number;
  /** Raw signed close-to-close price change / ATR. Positive means price rose. */
  rawMomentumAtr: number;
  baseRegime: PairedReversalBaseRegime;
  executionCostR: number;
  targetRMultiple: number;
}

export interface PairedDirectionReversalDecision {
  buyDirectionalProbability: number;
  sellDirectionalProbability: number;
  preferredDirection: PairedDirection | null;
  preferredAbsoluteProbability: number;
  directionalEdge: number;
  alignedMomentumAtr: number;
  researchNetExpectedR: number;
  reversalCandidate: boolean;
  reason: PairedDirectionReversalReason;
}

const EPSILON = 1e-9;

function invalidDecision(): PairedDirectionReversalDecision {
  return {
    buyDirectionalProbability: 0.5,
    sellDirectionalProbability: 0.5,
    preferredDirection: null,
    preferredAbsoluteProbability: 0,
    directionalEdge: 0,
    alignedMomentumAtr: 0,
    researchNetExpectedR: Number.NEGATIVE_INFINITY,
    reversalCandidate: false,
    reason: 'INVALID_INPUT',
  };
}

function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function logit(probability: number): number {
  const bounded = Math.max(EPSILON, Math.min(1 - EPSILON, probability));
  return Math.log(bounded / (1 - bounded));
}

function sigmoid(value: number): number {
  if (value >= 30) return 1;
  if (value <= -30) return 0;
  return 1 / (1 + Math.exp(-value));
}

export function evaluatePairedDirectionReversal(
  input: PairedDirectionReversalInput,
): PairedDirectionReversalDecision {
  if (
    !validProbability(input.buyProbability) ||
    !validProbability(input.sellProbability) ||
    !Number.isFinite(input.rawMomentumAtr) ||
    !Number.isFinite(input.executionCostR) ||
    input.executionCostR < 0 ||
    !Number.isFinite(input.targetRMultiple) ||
    input.targetRMultiple <= 0 ||
    (input.primaryDirection !== 'BUY' && input.primaryDirection !== 'SELL')
  ) {
    return invalidDecision();
  }

  const buyDirectionalProbability = sigmoid(
    logit(input.buyProbability) - logit(input.sellProbability),
  );
  const sellDirectionalProbability = 1 - buyDirectionalProbability;
  const preferredDirection: PairedDirection =
    buyDirectionalProbability >= sellDirectionalProbability ? 'BUY' : 'SELL';
  const preferredDirectionalProbability = Math.max(
    buyDirectionalProbability,
    sellDirectionalProbability,
  );
  const preferredAbsoluteProbability =
    preferredDirection === 'BUY' ? input.buyProbability : input.sellProbability;
  const directionalEdge = Math.abs(buyDirectionalProbability - sellDirectionalProbability);
  const alignedMomentumAtr =
    preferredDirection === 'BUY' ? input.rawMomentumAtr : -input.rawMomentumAtr;
  const researchNetExpectedR =
    preferredDirectionalProbability * input.targetRMultiple -
    (1 - preferredDirectionalProbability) -
    input.executionCostR;

  const baseDecision = {
    buyDirectionalProbability,
    sellDirectionalProbability,
    preferredDirection:
      preferredDirectionalProbability >= PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY
        ? preferredDirection
        : null,
    preferredAbsoluteProbability,
    directionalEdge,
    alignedMomentumAtr,
    researchNetExpectedR,
    reversalCandidate: false,
  } satisfies Omit<PairedDirectionReversalDecision, 'reason'>;

  if (preferredDirectionalProbability < PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY) {
    return { ...baseDecision, preferredDirection: null, reason: 'DIRECTION_EDGE_TOO_SMALL' };
  }
  if (preferredDirection === input.primaryDirection) {
    return { ...baseDecision, reason: 'PRIMARY_SIDE_STILL_PREFERRED' };
  }
  if (preferredAbsoluteProbability < PAIRED_REVERSAL_MIN_ABSOLUTE_PROBABILITY) {
    return { ...baseDecision, reason: 'ABSOLUTE_TRADABILITY_TOO_LOW' };
  }
  if (input.baseRegime !== 'TREND_WEAK' && input.baseRegime !== 'TREND_EXTENDED') {
    return { ...baseDecision, reason: 'REVERSAL_REGIME_NOT_SUPPORTED' };
  }
  if (alignedMomentumAtr < PAIRED_REVERSAL_MIN_ALIGNED_MOMENTUM_ATR) {
    return { ...baseDecision, reason: 'REVERSAL_MOMENTUM_NOT_CONFIRMED' };
  }
  if (researchNetExpectedR < PAIRED_REVERSAL_MIN_RESEARCH_NET_EXPECTED_R) {
    return { ...baseDecision, reason: 'RESEARCH_NET_EXPECTED_R_TOO_LOW' };
  }

  return {
    ...baseDecision,
    reversalCandidate: true,
    reason: 'PAIRED_REVERSAL_CANDIDATE',
  };
}
