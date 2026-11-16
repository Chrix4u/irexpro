/**
 * One-shot, owner-scoped Pepperstone DEMO trial:
 * admitted reversal/early transition can bridge an M1 route-label mismatch
 * even when the independent native expert's final state is ABSTAIN.
 * Expert must still vote WITH the side, not against; all broker/account and
 * after-fee risk controls remain downstream and are not bypassed.
 *
 * No stale replay or LIVE broker authority.
 */
export const ADVISORY_ALTERNATE_ARTIFACT =
  'pepperstone-demo-advisory-alternate-bridge-v1' as const;
export const ADVISORY_ALTERNATE_START = '2026-11-17T15:00:00.000Z';
export const ADVISORY_ALTERNATE_END = '2026-11-17T20:00:00.000Z';
export const ADVISORY_ALTERNATE_MAX_LOT = 4;
export const ADVISORY_ALTERNATE_ENTRY_LIMIT = 4;
export type AdvisoryAlternateTrialReason =
  | 'DISABLED' | 'OUTSIDE_WINDOW' | 'STALE_DECISION'
  | 'WRONG_ACCOUNT' | 'NOT_ADMITTED_REVERSAL_OR_TRANSITION'
  | 'NEGATIVE_AFTER_FEE_OR_MARKET_RISK'
  | 'M1_DIRECTION_OR_STOP_NOT_QUALIFIED'
  | 'EXPERT_DIRECTION_NOT_ALIGNED'
  | 'ELIGIBLE' | 'ENTRY_LIMIT_REACHED' | 'LIMIT_CHECK_UNAVAILABLE';

export interface AdvisoryAlternateTrialDecision {
  artifact: typeof ADVISORY_ALTERNATE_ARTIFACT;
  eligible: boolean;
  reason: AdvisoryAlternateTrialReason;
  route: string | null;
  maxLot: number;
  startsAt: string;
  endsAt: string;
  entryLimit: number;
  bypassesBrokerRisk: false;
  bypassesModelAdmission: false;
  modifiesOpenPositions: false;
}

export function evaluateAdvisoryAlternateTrial(input: {
  enabled: boolean;
  brokerVerified: boolean;
  now: Date;
  decisionTime: Date;
  route: string | null;
  side: 'BUY' | 'SELL';
  paperAdmitted: boolean;
  governanceEligible: boolean;
  portfolioSnapshotAvailable: boolean;
  ensembleScore: number | null;
  planbDirectionQuality: number | null;
  netExpectedR: number | null;
  executionSpreadEvidenceValid: boolean;
  paperExecutionCostUsable: boolean;
  eventRisk: string;
  driftState: string;
  sleeveState: string;
  m1Route: string;
  m1Confidence: number;
  m1DirectionQuality: number;
  stopDistance: number;
  targetDistance: number;
  expertSide: 'BUY' | 'SELL' | null;
  expertState: string | null;
  expertNative: boolean;
  expertAdmitted: boolean | null;
  expertFreshness: number | null;
  expertProbability: number | null;
  expertLongVotes: number | null;
  expertShortVotes: number | null;
}): AdvisoryAlternateTrialDecision {
  const base = {
    artifact: ADVISORY_ALTERNATE_ARTIFACT,
    route: input.route,
    maxLot: ADVISORY_ALTERNATE_MAX_LOT,
    startsAt: ADVISORY_ALTERNATE_START,
    endsAt: ADVISORY_ALTERNATE_END,
    entryLimit: ADVISORY_ALTERNATE_ENTRY_LIMIT,
    bypassesBrokerRisk: false as const,
    bypassesModelAdmission: false as const,
    modifiesOpenPositions: false as const,
  };
  const deny = (reason: AdvisoryAlternateTrialReason): AdvisoryAlternateTrialDecision =>
    ({ ...base, eligible:false, reason });
  if (!input.enabled) return deny('DISABLED');
  const now=input.now.getTime(),at=input.decisionTime.getTime();
  if (!Number.isFinite(now) || now<Date.parse(ADVISORY_ALTERNATE_START) ||
      now>=Date.parse(ADVISORY_ALTERNATE_END)) return deny('OUTSIDE_WINDOW');
  if (!Number.isFinite(at) || at<Date.parse(ADVISORY_ALTERNATE_START) ||
      at>now+5000 || now-at>120_000) return deny('STALE_DECISION');
  if (!input.brokerVerified) return deny('WRONG_ACCOUNT');
  if (!['CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(input.route??'') ||
      input.paperAdmitted!==true || input.governanceEligible!==true ||
      input.portfolioSnapshotAvailable!==true)
    return deny('NOT_ADMITTED_REVERSAL_OR_TRANSITION');
  if (!(Number.isFinite(input.ensembleScore) && (input.ensembleScore??0)>=0.60) ||
      !(Number.isFinite(input.planbDirectionQuality) && (input.planbDirectionQuality??0)>=0.54) ||
      !(Number.isFinite(input.netExpectedR) && (input.netExpectedR??0)>=0.12) ||
      input.executionSpreadEvidenceValid!==true ||
      input.paperExecutionCostUsable!==true ||
      input.eventRisk!=='CLEAR' ||
      input.driftState==='OUT_OF_DISTRIBUTION' ||
      input.sleeveState==='BLOCKED')
    return deny('NEGATIVE_AFTER_FEE_OR_MARKET_RISK');
  if (!['ABSTAIN','M1_EARLY_TRANSITION'].includes(input.m1Route) ||
      !Number.isFinite(input.m1Confidence) || input.m1Confidence<0.67 ||
      !Number.isFinite(input.m1DirectionQuality) || input.m1DirectionQuality<0.55 ||
      !Number.isFinite(input.stopDistance) || input.stopDistance<=0 ||
      !Number.isFinite(input.targetDistance) ||
      input.targetDistance<=input.stopDistance)
    return deny('M1_DIRECTION_OR_STOP_NOT_QUALIFIED');
  const yes=input.side==='BUY' ? input.expertLongVotes : input.expertShortVotes;
  const no=input.side==='BUY' ? input.expertShortVotes : input.expertLongVotes;
  // ABSTAIN is not a confirmed trade forecast. For a small DEMO test,
  // its DIRECTIONAL evidence may corroborate independently approved Plan B.
  if (!input.expertNative ||
      input.expertSide!==input.side ||
      (input.expertState!=='ABSTAIN' && input.expertState!=='CONFIRM') ||
      !Number.isInteger(yes) || !Number.isInteger(no) ||
      (yes??0)<2 || (no??0)>1 ||
      !Number.isFinite(input.expertProbability) ||
      (input.expertProbability??0)<0.25 ||
      !Number.isFinite(input.expertFreshness) ||
      (input.expertFreshness??-1)<0 ||
      (input.expertFreshness??999)>300 ||
      (input.expertState==='CONFIRM' && input.expertAdmitted!==true))
    return deny('EXPERT_DIRECTION_NOT_ALIGNED');
  return {...base, eligible:true, reason:'ELIGIBLE'};
}
