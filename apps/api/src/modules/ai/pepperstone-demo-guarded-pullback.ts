/**
 * A broker-DEMO, as-of-decision continuation recovery from a previously
 * overextended trend. Never use an OOD/chasing candle as a BUY/SELL entry.
 * This is a second-stage permission to lift the existing continuation pause,
 * NOT permission to bypass independent Plan-B/portfolio/broker gates.
 */
export const GUARDED_PULLBACK_LOT_CAP = 0.2;
export type GuardedPullbackReason =
  | 'DISABLED_OR_UNVERIFIED'
  | 'NO_PRIOR_EXTENDED_TREND'
  | 'NOT_ADMITTED_CONTINUATION'
  | 'CURRENT_MARKET_NOT_NORMAL'
  | 'WEAK_OR_EXCESSIVE_PULLBACK'
  | 'M1_REACCELERATION_MISSING'
  | 'EXPERT_NOT_ALIGNED'
  | 'MARKET_OR_COST_UNSAFE'
  | 'GUARDED_PULLBACK_RECOVERY';

export interface GuardedPullbackDecision {
  artifact: 'pepperstone-demo-guarded-pullback-v1';
  eligible: boolean;
  reason: GuardedPullbackReason;
  lotCap: number;
  bypassesPlanBAdmission: false;
  bypassesBrokerRisk: false;
}
export function evaluateGuardedPullback(input: {
  enabled: boolean;
  brokerVerified: boolean;
  decisionTime: Date;
  priorExtendedAt: Date | null;
  planBRoute: string | null;
  planBRegime: string | null;
  paperAdmitted: boolean;
  governanceEligible: boolean;
  portfolioSnapshotAvailable: boolean;
  driftState: string;
  eventRisk: string;
  spreadVerified: boolean;
  costsUsable: boolean;
  netExpectedR: number | null;
  confidence: number;
  directionQuality: number;
  extensionAtr: number;
  rsi14: number;
  alignedEmaSeparationAtr: number;
  alignedM15: number;
  alignedMomentum1Atr: number;
  alignedMomentum3Atr: number;
  alignedM5LatestBodyPressure: number;
  m1Route: string;
  direction: 'BUY' | 'SELL';
  expertDirection: 'BUY' | 'SELL' | null;
  expertNative: boolean;
  expertFreshnessSeconds: number | null;
  expertLongVotes: number;
  expertShortVotes: number;
  stopDistance: number;
  targetDistance: number;
}): GuardedPullbackDecision {
  const result = (reason: GuardedPullbackReason): GuardedPullbackDecision => ({
    artifact: 'pepperstone-demo-guarded-pullback-v1',
    eligible: reason === 'GUARDED_PULLBACK_RECOVERY',
    reason,
    lotCap: reason === 'GUARDED_PULLBACK_RECOVERY' ? GUARDED_PULLBACK_LOT_CAP : 0,
    bypassesPlanBAdmission: false,
    bypassesBrokerRisk: false,
  });
  if (!input.enabled || !input.brokerVerified) return result('DISABLED_OR_UNVERIFIED');
  const minutes = input.priorExtendedAt
    ? (input.decisionTime.getTime() - input.priorExtendedAt.getTime()) / 60000
    : NaN;
  if (!Number.isFinite(minutes) || minutes < 2 || minutes > 25)
    return result('NO_PRIOR_EXTENDED_TREND');
  if (
    input.planBRoute !== 'TREND_CONTINUATION' ||
    input.planBRegime !== 'TREND_HEALTHY' ||
    !input.paperAdmitted ||
    !input.governanceEligible ||
    !input.portfolioSnapshotAvailable
  )
    return result('NOT_ADMITTED_CONTINUATION');
  if (!['NORMAL', 'IN_DISTRIBUTION'].includes(input.driftState))
    return result('CURRENT_MARKET_NOT_NORMAL');
  if (
    !Number.isFinite(input.extensionAtr) ||
    input.extensionAtr < 0.1 ||
    input.extensionAtr > 1.05 ||
    !Number.isFinite(input.rsi14) ||
    input.rsi14 < 35 ||
    input.rsi14 > 65 ||
    !Number.isFinite(input.alignedEmaSeparationAtr) ||
    input.alignedEmaSeparationAtr < 0.12 ||
    input.alignedEmaSeparationAtr > 1.35
  )
    return result('WEAK_OR_EXCESSIVE_PULLBACK');
  if (
    input.m1Route !== 'M1_TREND_CONTINUATION' ||
    input.confidence < 0.68 ||
    input.directionQuality < 0.66 ||
    input.alignedM15 < 0.18 ||
    input.alignedMomentum1Atr < 0.08 ||
    input.alignedMomentum3Atr < 0.26 ||
    input.alignedM5LatestBodyPressure < 0.1 ||
    ![
      input.confidence,
      input.directionQuality,
      input.alignedM15,
      input.alignedMomentum1Atr,
      input.alignedMomentum3Atr,
      input.alignedM5LatestBodyPressure,
    ].every(Number.isFinite)
  )
    return result('M1_REACCELERATION_MISSING');
  const yes = input.direction === 'BUY' ? input.expertLongVotes : input.expertShortVotes;
  const no = input.direction === 'BUY' ? input.expertShortVotes : input.expertLongVotes;
  if (
    !input.expertNative ||
    input.expertDirection !== input.direction ||
    !Number.isInteger(yes) ||
    !Number.isInteger(no) ||
    yes < 2 ||
    no > 1 ||
    input.expertFreshnessSeconds === null ||
    !Number.isFinite(input.expertFreshnessSeconds) ||
    input.expertFreshnessSeconds < 0 ||
    input.expertFreshnessSeconds > 120
  )
    return result('EXPERT_NOT_ALIGNED');
  if (
    input.eventRisk !== 'CLEAR' ||
    !input.spreadVerified ||
    !input.costsUsable ||
    input.netExpectedR === null ||
    !Number.isFinite(input.netExpectedR) ||
    input.netExpectedR < 0.15 ||
    !Number.isFinite(input.stopDistance) ||
    input.stopDistance <= 0 ||
    !Number.isFinite(input.targetDistance) ||
    input.targetDistance < 1.25 * input.stopDistance
  )
    return result('MARKET_OR_COST_UNSAFE');
  return result('GUARDED_PULLBACK_RECOVERY');
}
