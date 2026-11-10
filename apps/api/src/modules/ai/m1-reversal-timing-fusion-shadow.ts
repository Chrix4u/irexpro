import type { M1TacticalCandidate } from './m1-tactical-candidate';
import type { M1TacticalRoute } from './m1-tactical-route';

export const M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT =
  'm1-planb-reversal-dual-impulse-fusion-shadow-v1';
export const M1_REVERSAL_TIMING_FUSION_MIN_QUALITY = 0.6;
export const M1_REVERSAL_TIMING_FUSION_MIN_MOMENTUM = 0.25;

export type M1ReversalFusionState =
  | 'ALTERNATIVE_CONFIRMATION_CANDIDATE'
  | 'PLAN_B_REVERSAL_NOT_ADMITTED'
  | 'M1_DIRECTION_QUALITY_LOW'
  | 'M1_MULTIBAR_IMPULSE_MISSING'
  | 'M1_SLOPE_NOT_ALIGNED'
  | 'COMPLETED_M5_TURN_MISSING'
  | 'ORIGINAL_M1_ALREADY_CONFIRMED'
  | 'FAILED_BREAKOUT_PRESENT_OTHER_ROUTE_BLOCK'
  | 'INVALID_EVIDENCE';

export interface M1ReversalFusionResult {
  artifact: typeof M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT;
  state: M1ReversalFusionState;
  wouldConfirmWithoutFailedBreakout: boolean;
  originalRoute: M1TacticalRoute;
  originalFailedBreakout: boolean;
  m1QualityPassed: boolean;
  m1MomentumPassed: boolean;
  m1SlopePassed: boolean;
  completedM5TurnPassed: boolean;
  completedM5TurnType: 'ESTABLISHED' | 'DECISIVE_FRESH' | 'NONE';
  signalEvidenceAsOf: string;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  modelTrainingStatus: 'UNVALIDATED_RESEARCH';
}

export type M1ReversalFusionCandidate = Pick<
  M1TacticalCandidate,
  | 'instrument'
  | 'direction'
  | 'decisionTime'
  | 'directionQuality'
  | 'alignedMomentum1Atr'
  | 'alignedMomentum3Atr'
  | 'alignedMomentum5Atr'
  | 'alignedEmaSlopeAtr'
  | 'alignedM5BodyPressure3'
  | 'alignedM5Momentum3Atr'
  | 'alignedM5Momentum1Atr'
  | 'alignedM5LatestBodyPressure'
  | 'failedBreakoutAgainstDirection'
>;

/**
 * As-of model disagreement research only. A validated Plan-B reversal and
 * independent M1+completed-M5 impulse may be worth a prospective experiment
 * even when the existing failed-breakout predicate is false.
 * This does NOT relabel the existing M1 route or authorize a broker entry.
 */
export function evaluateM1ReversalTimingFusionShadow(input: {
  candidate: M1ReversalFusionCandidate;
  originalRoute: M1TacticalRoute;
  planBStrategyRoute: string;
  planBPaperAdmitted: boolean;
}): M1ReversalFusionResult {
  const { candidate: c } = input;
  const values = [
    c.decisionTime.getTime(),
    c.directionQuality,
    c.alignedMomentum1Atr,
    c.alignedMomentum3Atr,
    c.alignedMomentum5Atr,
    c.alignedEmaSlopeAtr,
    c.alignedM5BodyPressure3,
    c.alignedM5Momentum3Atr,
    c.alignedM5Momentum1Atr,
    c.alignedM5LatestBodyPressure ?? 0,
  ];
  const invalid =
    values.some((n) => !Number.isFinite(n)) ||
    !/^[A-Z]{6}$/.test(c.instrument) ||
    !['BUY', 'SELL'].includes(c.direction) ||
    !['ABSTAIN', 'M1_CONFIRMED_REVERSAL', 'M1_EARLY_TRANSITION', 'M1_TREND_CONTINUATION'].includes(
      input.originalRoute,
    );

  const m1QualityPassed =
    Number.isFinite(c.directionQuality) &&
    c.directionQuality >= M1_REVERSAL_TIMING_FUSION_MIN_QUALITY;
  const m1MomentumPassed =
    c.alignedMomentum1Atr >= M1_REVERSAL_TIMING_FUSION_MIN_MOMENTUM &&
    c.alignedMomentum3Atr >= M1_REVERSAL_TIMING_FUSION_MIN_MOMENTUM &&
    c.alignedMomentum5Atr >= M1_REVERSAL_TIMING_FUSION_MIN_MOMENTUM / 2;
  const m1SlopePassed = c.alignedEmaSlopeAtr > 0;
  const established =
    c.alignedM5BodyPressure3 >= 0.08 &&
    c.alignedM5Momentum3Atr >= 0.08 &&
    c.alignedM5Momentum1Atr >= -0.1;
  const decisive =
    (c.alignedM5LatestBodyPressure ?? 0) >= 0.6 &&
    c.alignedM5Momentum1Atr >= 0.3 &&
    c.alignedM5Momentum3Atr >= -0.1;
  const completedM5TurnPassed = established || decisive;
  const planBReversal =
    input.planBPaperAdmitted && input.planBStrategyRoute === 'CONFIRMED_REVERSAL';

  const state: M1ReversalFusionState = invalid
    ? 'INVALID_EVIDENCE'
    : !planBReversal
      ? 'PLAN_B_REVERSAL_NOT_ADMITTED'
      : input.originalRoute === 'M1_CONFIRMED_REVERSAL'
        ? 'ORIGINAL_M1_ALREADY_CONFIRMED'
        : !m1QualityPassed
          ? 'M1_DIRECTION_QUALITY_LOW'
          : !m1MomentumPassed
            ? 'M1_MULTIBAR_IMPULSE_MISSING'
            : !m1SlopePassed
              ? 'M1_SLOPE_NOT_ALIGNED'
              : !completedM5TurnPassed
                ? 'COMPLETED_M5_TURN_MISSING'
                : c.failedBreakoutAgainstDirection === true
                  ? 'FAILED_BREAKOUT_PRESENT_OTHER_ROUTE_BLOCK'
                  : 'ALTERNATIVE_CONFIRMATION_CANDIDATE';

  return {
    artifact: M1_REVERSAL_TIMING_FUSION_SHADOW_ARTIFACT,
    state,
    wouldConfirmWithoutFailedBreakout: state === 'ALTERNATIVE_CONFIRMATION_CANDIDATE',
    originalRoute: input.originalRoute,
    originalFailedBreakout: c.failedBreakoutAgainstDirection === true,
    m1QualityPassed,
    m1MomentumPassed,
    m1SlopePassed,
    completedM5TurnPassed,
    completedM5TurnType: established ? 'ESTABLISHED' : decisive ? 'DECISIVE_FRESH' : 'NONE',
    signalEvidenceAsOf: Number.isFinite(c.decisionTime.getTime())
      ? c.decisionTime.toISOString()
      : 'INVALID',
    executionAuthority: 'NONE',
    modifiesExecution: false,
    modelTrainingStatus: 'UNVALIDATED_RESEARCH',
  };
}
