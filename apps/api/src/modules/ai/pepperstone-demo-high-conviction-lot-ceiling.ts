/**
 * Pure owner-DEMO optional 6-lot CEILING, never an order size or a risk override.
 * A real cTrader position still needs separate server-side risk-at-stop,
 * currency exposure, broker margin, per-symbol max and SL/TP validation.
 */
export const PEPPERSTONE_DEMO_HIGH_CONVICTION_CEILING_ARTIFACT =
  'pepperstone-owner-demo-high-conviction-6lot-ceiling-v1' as const;
const BASE_CEILING_LOTS = 4;
export const HIGH_CONVICTION_CEILING_LOTS = 6;
export type HighConvictionCeilingReason =
  | 'DISABLED_OR_WRONG_ACCOUNT'
  | 'NOT_CONTINUOUS_ALTERNATE'
  | 'WEAKER_EXISTING_CAP'
  | 'INDEPENDENT_EXPERT_UNCONFIRMED'
  | 'PLAN_B_QUALITY_UNPROVEN'
  | 'M1_OR_DIRECTION_NOT_CONFIRMED'
  | 'SHORT_STOP_OR_INADEQUATE_TARGET'
  | 'UNSUPPORTED_RISK_OR_REGIME'
  | 'ADMISSION_UNAVAILABLE'
  | 'ELIGIBLE';
export function evaluatePepperstoneDemoHighConvictionCeiling(input: {
  enabled: boolean;
  ownerVerifiedPepperstoneUsdDemo: boolean;
  continuousAlternate: boolean;
  baseVolumeCap: number;
  route: string | null;
  direction: 'BUY' | 'SELL';
  planBAdmitted: boolean;
  governanceEligible: boolean;
  planBScore: number | null;
  planBDirectionQuality: number | null;
  netExpectedR: number | null;
  spreadEvidenceValid: boolean;
  eventRisk: string;
  driftState: string;
  expertState: string | null;
  expertDirection: string | null;
  expertAdmitted: boolean | null;
  expertNative: boolean;
  expertProbability: number | null;
  expertFreshnessSeconds: number | null;
  m1Route: string;
  m1Confidence: number;
  m1DirectionQuality: number;
  m5Direction: string | null;
  h1Direction: string | null;
  qualityRiskFraction: number | null;
  patternHypothesis: string | null;
  stopDistance: number;
  m1Atr14: number;
  brokerSpreadPrice: number | null;
  targetDistance: number;
  guardedPullback: boolean;
}): {
  artifact: typeof PEPPERSTONE_DEMO_HIGH_CONVICTION_CEILING_ARTIFACT;
  eligible: boolean;
  reason: HighConvictionCeilingReason;
  maxLotCeiling: number;
  changesStopLoss: false;
  changesRiskAtStopLimit: false;
} {
  const result = (reason: HighConvictionCeilingReason, eligible = false) => ({
    artifact: PEPPERSTONE_DEMO_HIGH_CONVICTION_CEILING_ARTIFACT,
    eligible,
    reason,
    maxLotCeiling: eligible ? HIGH_CONVICTION_CEILING_LOTS : input.baseVolumeCap,
    changesStopLoss: false as const,
    changesRiskAtStopLimit: false as const,
  });
  if (!input.enabled || !input.ownerVerifiedPepperstoneUsdDemo)
    return result('DISABLED_OR_WRONG_ACCOUNT');
  if (
    !input.continuousAlternate ||
    !['EARLY_TRANSITION', 'CONFIRMED_REVERSAL'].includes(input.route ?? '')
  )
    return result('NOT_CONTINUOUS_ALTERNATE');
  // Never supersede a narrower rescue, fallback or protective probation cap.
  if (
    !Number.isFinite(input.baseVolumeCap) ||
    input.baseVolumeCap < BASE_CEILING_LOTS ||
    input.baseVolumeCap > BASE_CEILING_LOTS
  )
    return result('WEAKER_EXISTING_CAP');
  if (
    input.expertState !== 'CONFIRM' ||
    input.expertAdmitted !== true ||
    input.expertDirection !== input.direction ||
    input.expertNative !== true ||
    !Number.isFinite(input.expertProbability) ||
    (input.expertProbability ?? 0) < 0.7 ||
    !Number.isFinite(input.expertFreshnessSeconds) ||
    (input.expertFreshnessSeconds ?? Infinity) > 90
  )
    return result('INDEPENDENT_EXPERT_UNCONFIRMED');
  if (
    !input.planBAdmitted ||
    !input.governanceEligible ||
    !Number.isFinite(input.planBScore) ||
    (input.planBScore ?? 0) < 0.8 ||
    !Number.isFinite(input.planBDirectionQuality) ||
    (input.planBDirectionQuality ?? 0) < 0.68 ||
    !Number.isFinite(input.netExpectedR) ||
    (input.netExpectedR ?? 0) < 0.45
  )
    return result('PLAN_B_QUALITY_UNPROVEN');
  // M1 confidence tops out at 0.738 in the currently active M1 policy.
  if (
    input.m1Route !== 'M1_EARLY_TRANSITION' ||
    !Number.isFinite(input.m1Confidence) ||
    input.m1Confidence < 0.7 ||
    !Number.isFinite(input.m1DirectionQuality) ||
    input.m1DirectionQuality < 0.62 ||
    input.m5Direction !== 'WITH' ||
    input.h1Direction === 'AGAINST' ||
    input.h1Direction === 'UNAVAILABLE'
  )
    return result('M1_OR_DIRECTION_NOT_CONFIRMED');
  if (
    ![input.stopDistance, input.m1Atr14, input.targetDistance].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !(Number.isFinite(input.brokerSpreadPrice) && input.brokerSpreadPrice! > 0) ||
    input.stopDistance < Math.max(1.5 * input.m1Atr14, 3 * input.brokerSpreadPrice!) ||
    input.targetDistance / input.stopDistance < 1.5
  )
    return result('SHORT_STOP_OR_INADEQUATE_TARGET');
  if (
    input.eventRisk !== 'CLEAR' ||
    input.driftState === 'OUT_OF_DISTRIBUTION' ||
    input.spreadEvidenceValid !== true ||
    input.guardedPullback ||
    input.qualityRiskFraction !== 1 ||
    ['POSSIBLE_FALSE_REVERSAL', 'POSSIBLE_FALSE_CONTINUATION'].includes(
      input.patternHypothesis ?? '',
    )
  )
    return result('UNSUPPORTED_RISK_OR_REGIME');
  return result('ELIGIBLE', true);
}
