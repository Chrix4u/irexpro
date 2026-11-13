/**
 * Prospective, observation-only Plan B reversal / M1 continuation mismatch.
 *
 * A same-direction M1 continuation can coexist with a regime called
 * "CONFIRMED_REVERSAL"; the latter may be a higher-level transition
 * that already developed into an M1 continuation. But calling every
 * mismatch a confirmation would admit many historically losing trades.
 *
 * This explicitly frozen research hypothesis does NOT permit an order,
 * override Plan B/M1, bypass drift/HTF, increase lot sizes or alter SL/TP.
 * Record its inputs only from the completed decision-time M1/M5 snapshot;
 * later quotes/outcomes must be joined outside this pure function.
 */
export const PLANB_REVERSAL_M1_CONTINUATION_SHADOW_ARTIFACT =
  'planb-reversal-m1-continuation-asof-shadow-v1' as const;

export interface PlanBReversalM1ContinuationShadowInput {
  instrument: string;
  direction: 'BUY' | 'SELL';
  planBStrategyRoute: string | null;
  planBPaperAdmitted: boolean;
  planBGovernanceEligible: boolean;
  planBNetExpectedR: number | null;
  driftState: string | null;
  eventRisk: string | null;
  executionSpreadEvidenceValid: boolean;
  m1Route: string;
  m1Direction: string | null;
  m1Reason: string;
  m1ScoreEdge: number;
  directionQuality: number;
  alignedHigherTimeframeAgreement: number;
  alignedM5Momentum1Atr: number;
  alignedM5Momentum3Atr: number;
  alignedM5BodyPressure3: number;
  alignedM5LatestBodyPressure: number | null;
  failedBreakoutWithDirection: boolean;
  trainedExpertOpposed: boolean;
}
export type PlanBReversalM1ContinuationShadowReason =
  | 'NOT_A_REVERSAL_CONTINUATION_MISMATCH'
  | 'M1_DIRECTION_UNVERIFIED'
  | 'PLAN_B_NOT_FULLY_ADMITTED'
  | 'BROKER_COST_OR_EVENT_OR_DRIFT_UNSAFE'
  | 'M1_DIRECTION_OR_HTF_WEAK'
  | 'COMPLETED_M5_NOT_CONFIRMING'
  | 'M1_CONFIRMED_M5_CONFIRMED_SHADOW_ONLY';

export interface PlanBReversalM1ContinuationShadowDecision {
  artifact: typeof PLANB_REVERSAL_M1_CONTINUATION_SHADOW_ARTIFACT;
  shadowOnly: true;
  modifiesExecution: false;
  brokerOrderAuthority: 'NONE';
  automaticPromotionEligible: false;
  mismatchObserved: boolean;
  eligibleForProspectiveStudy: boolean;
  reason: PlanBReversalM1ContinuationShadowReason;
  instrument: string;
  direction: 'BUY' | 'SELL';
  m1Route: string;
  m1Reason: string;
  scoreEdge: number | null;
  alignedM5Momentum1Atr: number | null;
  alignedHigherTimeframeAgreement: number | null;
}
const numberOrNull=(value: number | null | undefined): number | null =>
  value !== null && value !== undefined && Number.isFinite(value) ? value : null;

export function observePlanBReversalM1ContinuationMismatch(
  x: PlanBReversalM1ContinuationShadowInput,
): PlanBReversalM1ContinuationShadowDecision {
  const mismatchObserved =
    x.planBStrategyRoute === 'CONFIRMED_REVERSAL' &&
    x.m1Route === 'M1_TREND_CONTINUATION';
  let reason: PlanBReversalM1ContinuationShadowReason =
    'NOT_A_REVERSAL_CONTINUATION_MISMATCH';

  if (mismatchObserved) {
    if (x.m1Direction !== x.direction || x.trainedExpertOpposed) {
      reason = 'M1_DIRECTION_UNVERIFIED';
    } else if (!x.planBPaperAdmitted || !x.planBGovernanceEligible) {
      reason = 'PLAN_B_NOT_FULLY_ADMITTED';
    } else if (
      x.eventRisk !== 'CLEAR' ||
      x.driftState !== 'NORMAL' ||
      x.executionSpreadEvidenceValid !== true ||
      !Number.isFinite(x.planBNetExpectedR) ||
      x.planBNetExpectedR == null ||
      x.planBNetExpectedR <= 0.1
    ) {
      reason = 'BROKER_COST_OR_EVENT_OR_DRIFT_UNSAFE';
    } else if (
      x.m1Reason !== 'TREND_STRUCTURE_ALIGNED' &&
      x.m1Reason !== 'FRESH_M5_CONTINUATION'
    ) {
      reason = 'M1_DIRECTION_OR_HTF_WEAK';
    } else if (
      !Number.isFinite(x.m1ScoreEdge) ||
      x.m1ScoreEdge < 0.3 ||
      !Number.isFinite(x.directionQuality) ||
      x.directionQuality < 0.68 ||
      !Number.isFinite(x.alignedHigherTimeframeAgreement) ||
      x.alignedHigherTimeframeAgreement < 0.2 ||
      x.failedBreakoutWithDirection
    ) {
      reason = 'M1_DIRECTION_OR_HTF_WEAK';
    } else if (
      !Number.isFinite(x.alignedM5Momentum1Atr) ||
      x.alignedM5Momentum1Atr < 0.18 ||
      !Number.isFinite(x.alignedM5Momentum3Atr) ||
      x.alignedM5Momentum3Atr < 0.1 ||
      !Number.isFinite(x.alignedM5BodyPressure3) ||
      x.alignedM5BodyPressure3 < 0.12 ||
      !Number.isFinite(x.alignedM5LatestBodyPressure) ||
      x.alignedM5LatestBodyPressure == null ||
      x.alignedM5LatestBodyPressure < 0.3
    ) {
      reason = 'COMPLETED_M5_NOT_CONFIRMING';
    } else {
      // FOR OFFLINE COHORT COUNTING ONLY. Never consumed by canExecute.
      reason = 'M1_CONFIRMED_M5_CONFIRMED_SHADOW_ONLY';
    }
  }

  return {
    artifact: PLANB_REVERSAL_M1_CONTINUATION_SHADOW_ARTIFACT,
    shadowOnly: true,
    modifiesExecution: false,
    brokerOrderAuthority: 'NONE',
    automaticPromotionEligible: false,
    mismatchObserved,
    eligibleForProspectiveStudy:
      reason === 'M1_CONFIRMED_M5_CONFIRMED_SHADOW_ONLY',
    reason,
    instrument: x.instrument,
    direction: x.direction,
    m1Route: x.m1Route,
    m1Reason: x.m1Reason,
    scoreEdge: numberOrNull(x.m1ScoreEdge),
    alignedM5Momentum1Atr: numberOrNull(x.alignedM5Momentum1Atr),
    alignedHigherTimeframeAgreement: numberOrNull(x.alignedHigherTimeframeAgreement),
  };
}
