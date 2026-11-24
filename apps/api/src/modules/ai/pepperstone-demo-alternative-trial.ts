/**
 * Explicit owner Pepperstone DEMO-only, timeboxed alternate timing trial.
 *
 * Permit a paper-admitted reversal/early-transition Plan-B candidate with
 * independently strong, fresh, broker-native expert direction evidence to
 * be tested even if the separate M1 label is ABSTAIN/another transition.
 * This grants NO LIVE authority and never waives account/broker risk gates.
 */
export const DEMO_ALTERNATIVE_TRIAL_ARTIFACT =
  'pepperstone-demo-alternative-timing-trial-v1' as const;
export const DEMO_ALTERNATIVE_TRIAL_START = '2026-11-16T20:00:00.000Z';
export const DEMO_ALTERNATIVE_TRIAL_END = '2026-11-16T21:00:00.000Z';
export const DEMO_ALTERNATIVE_TRIAL_LOT_CAP = 0.01;
export const DEMO_ALTERNATIVE_TRIAL_ENTRY_LIMIT = 6;

export type DemoAlternativeTrialReason =
  | 'DISABLED'
  | 'OUTSIDE_WINDOW'
  | 'STALE_CANDIDATE'
  | 'WRONG_BROKER'
  | 'ROUTE_NOT_ALLOWED'
  | 'MODEL_OR_MARKET_NOT_QUALIFIED'
  | 'M1_QUALITY_NOT_QUALIFIED'
  | 'EXPERT_NOT_CONFIRMED'
  | 'ENTRY_LIMIT_REACHED'
  | 'LIMIT_CHECK_UNAVAILABLE'
  | 'ELIGIBLE';

export interface DemoAlternativeTrialDecision {
  artifact: typeof DEMO_ALTERNATIVE_TRIAL_ARTIFACT;
  eligible: boolean;
  reason: DemoAlternativeTrialReason;
  route: string | null;
  maxLot: number;
  endsAt: string;
  bypassesBrokerRisk: false;
  bypassesModelAdmission: false;
  modifiesOpenPositions: false;
}

export function evaluateDemoAlternativeTrial(input: {
  enabled: boolean;
  brokerVerified: boolean;
  now: Date;
  decisionTime: Date;
  route: string | null;
  m1Route: string;
  ensembleScore: number | null;
  planbDirectionQuality: number | null;
  paperAdmitted: boolean;
  governanceEligible: boolean;
  portfolioSnapshotAvailable: boolean;
  executionSpreadEvidenceValid: boolean;
  paperExecutionCostUsable: boolean;
  netExpectedR: number | null;
  eventRisk: string;
  sleeveState: string;
  m1Confidence: number;
  m1DirectionQuality: number;
  side: 'BUY' | 'SELL';
  expertSide: 'BUY' | 'SELL' | null;
  expertNative: boolean;
  expertConfidence: number | null;
  expertFreshness: number | null;
  expertLongVotes: number | null;
  expertShortVotes: number | null;
}): DemoAlternativeTrialDecision {
  const base = {
    artifact: DEMO_ALTERNATIVE_TRIAL_ARTIFACT,
    route: input.route,
    maxLot: DEMO_ALTERNATIVE_TRIAL_LOT_CAP,
    endsAt: DEMO_ALTERNATIVE_TRIAL_END,
    bypassesBrokerRisk: false as const,
    bypassesModelAdmission: false as const,
    modifiesOpenPositions: false as const,
  };
  const deny = (reason: DemoAlternativeTrialReason): DemoAlternativeTrialDecision => ({
    ...base,
    eligible: false,
    reason,
  });
  if (!input.enabled) return deny('DISABLED');
  const now = input.now.getTime();
  const candleTime = input.decisionTime.getTime();
  if (
    !Number.isFinite(now) ||
    now < Date.parse(DEMO_ALTERNATIVE_TRIAL_START) ||
    now >= Date.parse(DEMO_ALTERNATIVE_TRIAL_END)
  )
    return deny('OUTSIDE_WINDOW');
  // Never unlock 478+ old rejected scans or a stale scanner catch-up batch.
  if (
    !Number.isFinite(candleTime) ||
    candleTime > now + 5000 ||
    now - candleTime > 120_000 ||
    candleTime < Date.parse(DEMO_ALTERNATIVE_TRIAL_START)
  )
    return deny('STALE_CANDIDATE');
  if (input.route !== 'CONFIRMED_REVERSAL' && input.route !== 'EARLY_TRANSITION')
    return deny('ROUTE_NOT_ALLOWED');
  if (!input.brokerVerified) return deny('WRONG_BROKER');
  if (
    !input.paperAdmitted ||
    !input.governanceEligible ||
    !input.portfolioSnapshotAvailable ||
    !input.executionSpreadEvidenceValid ||
    !input.paperExecutionCostUsable ||
    input.eventRisk !== 'CLEAR' ||
    input.sleeveState === 'BLOCKED' ||
    !Number.isFinite(input.ensembleScore) ||
    (input.ensembleScore ?? 0) < 0.6 ||
    !Number.isFinite(input.planbDirectionQuality) ||
    (input.planbDirectionQuality ?? 0) < 0.54 ||
    !Number.isFinite(input.netExpectedR) ||
    (input.netExpectedR ?? 0) < 0.12
  )
    return deny('MODEL_OR_MARKET_NOT_QUALIFIED');
  // This is a semantic label mismatch trial only, not an override for
  // M1 continuation or a contradictory M1 confirmed reversal.
  if (input.m1Route !== 'ABSTAIN' && input.m1Route !== 'M1_EARLY_TRANSITION')
    return deny('M1_QUALITY_NOT_QUALIFIED');
  if (
    !Number.isFinite(input.m1Confidence) ||
    input.m1Confidence < 0.67 ||
    !Number.isFinite(input.m1DirectionQuality) ||
    input.m1DirectionQuality < 0.55
  )
    return deny('M1_QUALITY_NOT_QUALIFIED');
  const long = input.expertLongVotes,
    short = input.expertShortVotes;
  const aligned = input.side === 'BUY' ? long : short;
  const other = input.side === 'BUY' ? short : long;
  if (
    !input.expertNative ||
    input.expertSide !== input.side ||
    !Number.isInteger(long) ||
    !Number.isInteger(short) ||
    !Number.isInteger(aligned) ||
    !Number.isInteger(other) ||
    (aligned ?? 0) < 3 ||
    other !== 0 ||
    !Number.isFinite(input.expertConfidence) ||
    (input.expertConfidence ?? 0) < 0.65 ||
    !Number.isFinite(input.expertFreshness) ||
    (input.expertFreshness ?? -1) < 0 ||
    (input.expertFreshness ?? 999) > 300
  )
    return deny('EXPERT_NOT_CONFIRMED');
  return { ...base, eligible: true, reason: 'ELIGIBLE' };
}
