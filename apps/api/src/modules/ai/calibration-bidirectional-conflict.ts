import type { AdaptivePredictionCalibrationDecision } from './adaptive-prediction-calibration.service';
import type { PairedDirection, PairedDirectionReversalDecision } from './paired-direction-reversal';

export const CALIBRATION_BIDIRECTIONAL_CONFLICT_ARTIFACT =
  'calibration-bidirectional-conflict-shadow-v1' as const;

export type CalibrationBidirectionalConflictState =
  | 'NO_CALIBRATION_BLOCK'
  | 'BLOCK_CURRENT_SIDE_FAVORED'
  | 'BLOCK_OPPOSITE_SIDE_FAVORED'
  | 'BLOCK_PAIRED_BALANCED'
  | 'BLOCK_PAIRED_INVALID';

export type CalibrationBidirectionalConflictReason =
  | 'CALIBRATION_NOT_BLOCKED'
  | 'CALIBRATION_BLOCK_CURRENT_SIDE_FAVORED'
  | 'CALIBRATION_BLOCK_OPPOSITE_SIDE_FAVORED'
  | 'CALIBRATION_BLOCK_PAIRED_BALANCED'
  | 'CALIBRATION_BLOCK_PAIRED_INVALID';

export interface CalibrationBidirectionalConflictInput {
  candidateDirection: PairedDirection;
  strategyRoute: string;
  adaptiveState: string;
  calibration: Pick<
    AdaptivePredictionCalibrationDecision,
    | 'blockRecommended'
    | 'reason'
    | 'maturity'
    | 'sourceLevel'
    | 'samples'
    | 'calibratedNetExpectedR'
    | 'calibratedWinProbability'
  >;
  paired: Pick<
    PairedDirectionReversalDecision,
    | 'buyDirectionalProbability'
    | 'sellDirectionalProbability'
    | 'preferredDirection'
    | 'preferredAbsoluteProbability'
    | 'directionalEdge'
    | 'reason'
  >;
}

export interface CalibrationBidirectionalConflictDecision {
  artifact: typeof CALIBRATION_BIDIRECTIONAL_CONFLICT_ARTIFACT;
  state: CalibrationBidirectionalConflictState;
  reason: CalibrationBidirectionalConflictReason;
  active: boolean;
  candidateDirection: PairedDirection;
  strategyRoute: string;
  adaptiveState: string;
  calibrationBlockRecommended: boolean;
  calibrationReason: string;
  calibrationMaturity: AdaptivePredictionCalibrationDecision['maturity'];
  calibrationSourceLevel: AdaptivePredictionCalibrationDecision['sourceLevel'];
  calibrationSamples: number;
  calibratedNetExpectedR: number;
  calibratedWinProbability: number;
  rawPreferredDirection: PairedDirection | null;
  pairedPreferredDirection: PairedDirection | null;
  candidateDirectionalProbability: number | null;
  oppositeDirectionalProbability: number | null;
  preferredAbsoluteProbability: number;
  directionalEdge: number;
  pairedReason: PairedDirectionReversalDecision['reason'];
  executionAuthority: 'NONE';
  modifiesExecution: false;
}

const BALANCED_EPSILON = 1e-9;

function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function evaluateCalibrationBidirectionalConflict(
  input: CalibrationBidirectionalConflictInput,
): CalibrationBidirectionalConflictDecision {
  const buy = input.paired.buyDirectionalProbability;
  const sell = input.paired.sellDirectionalProbability;
  const pairedValid = validProbability(buy) && validProbability(sell);
  const candidateDirectionalProbability = pairedValid
    ? input.candidateDirection === 'BUY'
      ? buy
      : sell
    : null;
  const oppositeDirectionalProbability = pairedValid
    ? input.candidateDirection === 'BUY'
      ? sell
      : buy
    : null;

  let rawPreferredDirection: PairedDirection | null = null;
  if (pairedValid && Math.abs(buy - sell) > BALANCED_EPSILON) {
    rawPreferredDirection = buy > sell ? 'BUY' : 'SELL';
  }

  let state: CalibrationBidirectionalConflictState;
  let reason: CalibrationBidirectionalConflictReason;
  if (!input.calibration.blockRecommended) {
    state = 'NO_CALIBRATION_BLOCK';
    reason = 'CALIBRATION_NOT_BLOCKED';
  } else if (!pairedValid) {
    state = 'BLOCK_PAIRED_INVALID';
    reason = 'CALIBRATION_BLOCK_PAIRED_INVALID';
  } else if (rawPreferredDirection === null) {
    state = 'BLOCK_PAIRED_BALANCED';
    reason = 'CALIBRATION_BLOCK_PAIRED_BALANCED';
  } else if (rawPreferredDirection === input.candidateDirection) {
    state = 'BLOCK_CURRENT_SIDE_FAVORED';
    reason = 'CALIBRATION_BLOCK_CURRENT_SIDE_FAVORED';
  } else {
    state = 'BLOCK_OPPOSITE_SIDE_FAVORED';
    reason = 'CALIBRATION_BLOCK_OPPOSITE_SIDE_FAVORED';
  }

  return {
    artifact: CALIBRATION_BIDIRECTIONAL_CONFLICT_ARTIFACT,
    state,
    reason,
    active: state === 'BLOCK_CURRENT_SIDE_FAVORED',
    candidateDirection: input.candidateDirection,
    strategyRoute: input.strategyRoute,
    adaptiveState: input.adaptiveState,
    calibrationBlockRecommended: input.calibration.blockRecommended,
    calibrationReason: input.calibration.reason,
    calibrationMaturity: input.calibration.maturity,
    calibrationSourceLevel: input.calibration.sourceLevel,
    calibrationSamples: input.calibration.samples,
    calibratedNetExpectedR: input.calibration.calibratedNetExpectedR,
    calibratedWinProbability: input.calibration.calibratedWinProbability,
    rawPreferredDirection,
    pairedPreferredDirection: input.paired.preferredDirection,
    candidateDirectionalProbability,
    oppositeDirectionalProbability,
    preferredAbsoluteProbability: input.paired.preferredAbsoluteProbability,
    directionalEdge: input.paired.directionalEdge,
    pairedReason: input.paired.reason,
    executionAuthority: 'NONE',
    modifiesExecution: false,
  };
}
