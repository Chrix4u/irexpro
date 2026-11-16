import type { HighConvictionOverlay } from './high-conviction-overlay';

/** One owner-scoped, DEMO-only executable counter-direction pilot.
 * The expert's opposite vote alone is NEVER an order signal. Both
 * independent own-side models and normal broker/risk gates must agree.
 */
export const COUNTER_PILOT_ARTIFACT = 'pepperstone-demo-independent-counter-entry-v1' as const;
export const COUNTER_PILOT_START = '2026-11-16T21:00:00.000Z';
export const COUNTER_PILOT_END = '2026-11-17T00:00:00.000Z';
export const COUNTER_PILOT_LOT_CAP = 0.01;
export const COUNTER_PILOT_ENTRY_LIMIT = 4;

export type CounterPilotReason =
  | 'DISABLED' | 'OUTSIDE_WINDOW' | 'STALE_SIGNAL' | 'WRONG_ACCOUNT'
  | 'NO_OPPOSING_ADMITTED_REVERSAL' | 'EXPERT_DID_NOT_CONFIRM'
  | 'COUNTER_NOT_QUALIFIED' | 'COUNTER_M1_NOT_QUALIFIED'
  | 'INDEPENDENT_STOP_TARGET_MISSING' | 'ELIGIBLE'
  | 'ENTRY_LIMIT_REACHED' | 'LIMIT_CHECK_UNAVAILABLE';

export interface CounterPilotDecision {
  artifact: typeof COUNTER_PILOT_ARTIFACT;
  eligible: boolean;
  reason: CounterPilotReason;
  route: string | null;
  maxLot: number;
  endsAt: string;
  startsAt: string;
  entryLimit: number;
  sourceSide: 'BUY' | 'SELL' | null;
  sourceRoute: string | null;
  bypassesBrokerRisk: false;
  bypassesModelAdmission: false;
  modifiesOpenPositions: false;
}

export interface CounterPilotModel {
  ensemble: {
    strategyRoute: string;
    paperAdmitted: boolean;
    ensembleScore: number;
    directionQuality: number;
  };
  governance: {
    paperExecutionEligible: boolean;
    netExpectedR: number;
    paperExecutionCostUsable?: boolean;
    executionSpreadEvidenceValid?: boolean;
    eventRisk: string;
    driftState: string;
  };
  trainedExpert: HighConvictionOverlay;
  portfolioSnapshotAvailable: boolean;
}

export function evaluateCounterPilot(input: {
  enabled: boolean;
  brokerVerified: boolean;
  now: Date;
  decisionTime: Date;
  side: 'BUY' | 'SELL';
  m1Route: string;
  m1Confidence: number;
  m1DirectionQuality: number;
  stopDistance: number;
  targetDistance: number;
  candidate: CounterPilotModel | null;
  opposingSource: CounterPilotModel | null;
}): CounterPilotDecision {
  const sourceSide: 'BUY' | 'SELL' = input.side === 'BUY' ? 'SELL' : 'BUY';
  const base = {
    artifact: COUNTER_PILOT_ARTIFACT,
    route: input.candidate?.ensemble.strategyRoute ?? null,
    maxLot: COUNTER_PILOT_LOT_CAP,
    endsAt: COUNTER_PILOT_END,
    startsAt: COUNTER_PILOT_START,
    entryLimit: COUNTER_PILOT_ENTRY_LIMIT,
    sourceSide,
    sourceRoute: input.opposingSource?.ensemble.strategyRoute ?? null,
    bypassesBrokerRisk: false as const,
    bypassesModelAdmission: false as const,
    modifiesOpenPositions: false as const,
  };
  const deny = (reason: CounterPilotReason): CounterPilotDecision =>
    ({...base,eligible:false,reason});
  if(!input.enabled)return deny('DISABLED');
  const now=input.now.getTime(),time=input.decisionTime.getTime();
  if(!Number.isFinite(now)||now<Date.parse(COUNTER_PILOT_START)||
     now>=Date.parse(COUNTER_PILOT_END))return deny('OUTSIDE_WINDOW');
  if(!Number.isFinite(time)||time<Date.parse(COUNTER_PILOT_START)||
     time>now+5000||now-time>120000)return deny('STALE_SIGNAL');
  // Diagnose genuine signal failures before a verified-account veto.
  // All executable outcomes still require verified DEMO identity below.
  const original=input.opposingSource, own=input.candidate;
  if(!original || !['CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(
      original.ensemble.strategyRoute) ||
      original.ensemble.paperAdmitted!==true ||
      original.governance.paperExecutionEligible!==true ||
      original.trainedExpert.direction!==input.side)
    return deny('NO_OPPOSING_ADMITTED_REVERSAL');
  const ex=own?.trainedExpert;
  const aligned=input.side==='BUY'?ex?.longVotes:ex?.shortVotes;
  const against=input.side==='BUY'?ex?.shortVotes:ex?.longVotes;
  if(!ex||ex.state!=='CONFIRM'||ex.admitted!==true||
     ex.direction!==input.side||ex.allBrokerNative!==true||
     aligned!==3||against!==0 ||
     !Number.isFinite(ex.ensembleConfidence) ||
     (ex.ensembleConfidence??0)<0.65 ||
     !Number.isFinite(ex.meanOpportunityProbability) ||
     (ex.meanOpportunityProbability??0)<0.6 ||
     !Number.isFinite(ex.freshnessSeconds) ||
     (ex.freshnessSeconds??999)>180 ||
     (ex.freshnessSeconds??-1)<0)
    return deny('EXPERT_DID_NOT_CONFIRM');
  if(!own||!['CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(own.ensemble.strategyRoute)||
     own.ensemble.paperAdmitted!==true||
     own.governance.paperExecutionEligible!==true||
     own.portfolioSnapshotAvailable!==true||
     !(own.ensemble.ensembleScore>=0.6)||
     !(own.ensemble.directionQuality>=0.54)||
     !(own.governance.netExpectedR>=0.12)||
     own.governance.executionSpreadEvidenceValid!==true ||
     own.governance.paperExecutionCostUsable!==true ||
     own.governance.eventRisk!=='CLEAR' ||
     own.governance.driftState==='OUT_OF_DISTRIBUTION')
    return deny('COUNTER_NOT_QUALIFIED');
  // This bridges a semantic M1 timing label only; do not grant authority
  // to continuation or to objectively weak opposite-side M1 features.
  if(!['ABSTAIN','M1_EARLY_TRANSITION'].includes(input.m1Route)||
     !(input.m1Confidence>=0.67)||!(input.m1DirectionQuality>=0.55))
    return deny('COUNTER_M1_NOT_QUALIFIED');
  if(!(Number.isFinite(input.stopDistance)&&input.stopDistance>0)||
     !(Number.isFinite(input.targetDistance)&&
       input.targetDistance>input.stopDistance))
    return deny('INDEPENDENT_STOP_TARGET_MISSING');
  // Mandatory final fail-closed exact-owner Pepperstone DEMO broker check.
  // A confirmed expert and strong score can NEVER authorize another account.
  if(!input.brokerVerified)return deny('WRONG_ACCOUNT');
  return {...base,eligible:true,reason:'ELIGIBLE'};
}
