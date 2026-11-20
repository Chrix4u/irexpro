/**
 * Owner Pepperstone USD DEMO ONLY. Route-specific fitted win probability
 * on actual closed after-fee trades. SHADOW ONLY: no broker authority.
 * A fitted win probability is not the probability of a profitable live fill.
 */
import { createHash } from 'node:crypto';
import { OWNER_DEMO_ENTRY_OUTCOME_FITTED } from './owner-demo-entry-outcome-model.generated';

export const OWNER_DEMO_ENTRY_OUTCOME_ARTIFACT =
  'owner-demo-after-fee-entry-discriminator-v1' as const;
export const ENTRY_OUTCOME_FEATURES = [
  'alignedM5', 'm5Body', 'alignedH1', 'alignedH4',
  'alignedM1Momentum3', 'planBScore', 'forecastNetR',
] as const;
export type EntryOutcomeFeature = typeof ENTRY_OUTCOME_FEATURES[number];
export type EntryOutcomeRoute =
  | 'CONFIRMED_REVERSAL'
  | 'EARLY_TRANSITION'
  | 'TREND_CONTINUATION';
export type EntryOutcomeVector = Record<EntryOutcomeFeature, number>;
export interface EntryOutcomeExample {
  route: EntryOutcomeRoute;
  instrument: string;
  direction: 'BUY' | 'SELL';
  decisionAt: string;
  resolvedAt: string;
  netUsd: number;
  features: EntryOutcomeVector;
}
export interface FittedEntryOutcomeRoute {
  samples: number;
  wins: number;
  losses: number;
  coefficients: number[];
  intercept: number;
  modelVersion: string;
  /** Lowest 25% threshold derived ONLY from pre-Nov19 TRAINING. */
  researchLowScoreThreshold?: number;
}
export interface FittedEntryOutcomeArtifact {
  artifact: typeof OWNER_DEMO_ENTRY_OUTCOME_ARTIFACT;
  trainingCutoffUtc: string;
  source: 'EXACT_OWNER_BROKER_SETTLED_AFTER_FEE_FILLS';
  brokerConnectionFingerprint: string;
  status: 'RESEARCH_ONLY';
  routes: Partial<Record<EntryOutcomeRoute, FittedEntryOutcomeRoute>>;
}
export interface EntryOutcomeObservation {
  artifact: typeof OWNER_DEMO_ENTRY_OUTCOME_ARTIFACT;
  shadowOnly: true;
  modifiesExecution: false;
  grantsTradeAuthority: false;
  vetoRecommended: false;
  status: 'FITTED_SHADOW_UNQUALIFIED' | 'INSUFFICIENT_ROUTE_TRAINING' |
    'INVALID_ENTRY_FEATURES' | 'TRAINING_NOT_CAUSAL' | 'MODEL_UNAVAILABLE' |
    'MODEL_SCOPE_MISMATCH';
  route: EntryOutcomeRoute | null;
  probabilityOfAfterFeeWinningTrade: number | null;
  probabilityOfAfterFeeLosingTrade: number | null;
  researchLowScoreThreshold: number | null;
  researchLowScoreFlag: boolean | null;
  trainingCount: number;
  modelVersion: string | null;
  trainingCutoffUtc: string | null;
  source: 'HISTORICAL_EXECUTED_FILLS_NOT_ALL_CANDIDATES';
  /** Original, frozen decision-time evidence, never post-close P&L. */
  features: EntryOutcomeVector | null;
}
/** Irreversible, context-separated UUID fingerprint; NEVER stores raw broker ID. */
export function fingerprintOwnerDemoEntryBroker(connectionId: string): string {
  return createHash('sha256')
    .update('irexpro-owner-demo-entry-outcome-v1|' + connectionId.trim())
    .digest('hex');
}
function finite(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n=Number(x);
  return Number.isFinite(n)?n:null;
}
function clip(x: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, x));
}
export function encodeEntryOutcomeFeatures(values: Partial<Record<EntryOutcomeFeature,unknown>>):
  EntryOutcomeVector | null {
  const floats=ENTRY_OUTCOME_FEATURES.map(key=>finite(values[key]));
  if (floats.some(x=>x==null)) return null;
  const [m5,body,h1,h4,momentum,score,netR]=floats as number[];
  return {
    alignedM5:clip(m5,-1,1),
    m5Body:clip(body,-1,1),
    alignedH1:clip(h1,-1,1),
    alignedH4:clip(h4,-1,1),
    alignedM1Momentum3:clip(momentum/2,-1,1),
    planBScore:clip((score-.6)/.2,-2,2),
    forecastNetR:clip(netR,-1.5,1.5),
  };
}
export function entryOutcomeLinearPredictor(
  features: EntryOutcomeVector, model: FittedEntryOutcomeRoute,
): number | null {
  if (model.coefficients.length !== ENTRY_OUTCOME_FEATURES.length ||
      !Number.isFinite(model.intercept) ||
      !model.coefficients.every(Number.isFinite)) return null;
  return ENTRY_OUTCOME_FEATURES.reduce(
    (sum,key,index)=>sum+features[key]*model.coefficients[index]!,
    model.intercept,
  );
}
export function entryOutcomeWinProbability(
  features: EntryOutcomeVector, model: FittedEntryOutcomeRoute,
): number | null {
  const linear=entryOutcomeLinearPredictor(features,model);
  return linear==null?null:1/(1+Math.exp(-clip(linear,-30,30)));
}
export function scoreOwnerDemoEntryOutcome(input: {
  brokerConnectionId: string;
  route: EntryOutcomeRoute | null;
  evaluatedAt: Date;
  featureValues: Partial<Record<EntryOutcomeFeature,unknown>>;
  fitted?: FittedEntryOutcomeArtifact;
}): EntryOutcomeObservation {
  const fitted=input.fitted??OWNER_DEMO_ENTRY_OUTCOME_FITTED;
  const features=encodeEntryOutcomeFeatures(input.featureValues);
  const model=input.route?fitted?.routes?.[input.route]:null;
  const base:EntryOutcomeObservation={
    artifact:OWNER_DEMO_ENTRY_OUTCOME_ARTIFACT,
    shadowOnly:true,modifiesExecution:false,grantsTradeAuthority:false,
    vetoRecommended:false,
    status:'MODEL_UNAVAILABLE',route:input.route,
    probabilityOfAfterFeeWinningTrade:null,
    probabilityOfAfterFeeLosingTrade:null,
    researchLowScoreThreshold:model?.researchLowScoreThreshold??null,
    researchLowScoreFlag:null,
    trainingCount:model?.samples??0,
    modelVersion:model?.modelVersion??null,
    trainingCutoffUtc:fitted?.trainingCutoffUtc??null,
    source:'HISTORICAL_EXECUTED_FILLS_NOT_ALL_CANDIDATES',
    features,
  };
  if(!features)return {...base,status:'INVALID_ENTRY_FEATURES'};
  if(!fitted||fitted.artifact!==OWNER_DEMO_ENTRY_OUTCOME_ARTIFACT ||
      fitted.status!=='RESEARCH_ONLY')return base;
  if(!input.brokerConnectionId || !fitted.brokerConnectionFingerprint ||
      fingerprintOwnerDemoEntryBroker(input.brokerConnectionId)!==fitted.brokerConnectionFingerprint)
    return {...base,status:'MODEL_SCOPE_MISMATCH'};
  if(!Number.isFinite(input.evaluatedAt.getTime())||
    input.evaluatedAt.getTime()<=new Date(fitted.trainingCutoffUtc).getTime())
    return {...base,status:'TRAINING_NOT_CAUSAL'};
  if(!model||model.samples<24||model.wins<8||model.losses<8)
    return {...base,status:'INSUFFICIENT_ROUTE_TRAINING'};
  const probability=entryOutcomeWinProbability(features,model);
  if(probability==null)return base;
  return {...base,status:'FITTED_SHADOW_UNQUALIFIED',
    probabilityOfAfterFeeWinningTrade:Number(probability.toFixed(5)),
    probabilityOfAfterFeeLosingTrade:Number((1-probability).toFixed(5)),
    researchLowScoreFlag:model.researchLowScoreThreshold==null?null:
      probability<=model.researchLowScoreThreshold};
}
