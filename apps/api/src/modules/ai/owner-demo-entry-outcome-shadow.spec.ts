import {
  encodeEntryOutcomeFeatures,
  entryOutcomeWinProbability,
  scoreOwnerDemoEntryOutcome,
  type FittedEntryOutcomeArtifact,
} from './owner-demo-entry-outcome-shadow';

const features={
  alignedM5:0.6,m5Body:-0.2,
  alignedH1:0.3,alignedH4:0.4,
  alignedM1Momentum3:1.2,planBScore:0.67,
  forecastNetR:0.17,
};
const model:FittedEntryOutcomeArtifact={
  artifact:'owner-demo-after-fee-entry-discriminator-v1',
  trainingCutoffUtc:'2026-11-19T00:00:00.000Z',
  source:'EXACT_OWNER_BROKER_SETTLED_AFTER_FEE_FILLS',
  status:'RESEARCH_ONLY',
  routes:{
    CONFIRMED_REVERSAL:{
      samples:60,wins:32,losses:28,
      coefficients:[0.2,-0.2,0.1,0.2,-0.1,0.3,0.4],
      intercept:-.1,modelVersion:'test-model',
    },
  },
};
describe('Owner DEMO after-fee entry discriminator SHADOW',()=>{
  it('freezes direction-relative entry features and rejects missing invalid evidence',()=>{
    const a=encodeEntryOutcomeFeatures(features);
    expect(a).not.toBeNull();
    expect(a?.alignedM1Momentum3).toBe(.6);
    expect(a?.planBScore).toBeCloseTo(.35);
    expect(encodeEntryOutcomeFeatures({...features,m5Body:null})).toBeNull();
    expect(encodeEntryOutcomeFeatures({...features,alignedM5:Infinity})).toBeNull();
    expect(encodeEntryOutcomeFeatures({...features,forecastNetR:'NaN'})).toBeNull();
    const extreme=encodeEntryOutcomeFeatures({...features,alignedM5:20});
    expect(extreme?.alignedM5).toBe(1);
  });
  it('scores only after the fixed training cutoff and never grants entry authority',()=>{
    const decision=scoreOwnerDemoEntryOutcome({
      route:'CONFIRMED_REVERSAL',evaluatedAt:new Date('2026-11-19T23:00:00Z'),
      featureValues:features,fitted:model,
    });
    expect(decision.status).toBe('FITTED_SHADOW_UNQUALIFIED');
    expect(decision.probabilityOfAfterFeeWinningTrade).toBeGreaterThan(0);
    expect(decision.probabilityOfAfterFeeLosingTrade).toBeCloseTo(
      1-decision.probabilityOfAfterFeeWinningTrade!,5);
    expect(decision.shadowOnly).toBe(true);
    expect(decision.modifiesExecution).toBe(false);
    expect(decision.grantsTradeAuthority).toBe(false);
    expect(decision.vetoRecommended).toBe(false);
    expect(scoreOwnerDemoEntryOutcome({
      route:'CONFIRMED_REVERSAL',evaluatedAt:new Date('2026-11-18T23:59:00Z'),
      featureValues:features,fitted:model,
    }).status).toBe('TRAINING_NOT_CAUSAL');
  });
  it('does not invent a continuation model or use candidate outcomes',()=>{
    const decision=scoreOwnerDemoEntryOutcome({
      route:'TREND_CONTINUATION',evaluatedAt:new Date('2026-11-19T23:00:00Z'),
      featureValues:features,fitted:model,
    });
    expect(decision.status).toBe('INSUFFICIENT_ROUTE_TRAINING');
    expect(decision.probabilityOfAfterFeeWinningTrade).toBeNull();
    expect(entryOutcomeWinProbability(encodeEntryOutcomeFeatures(features)!,{
      samples:100,wins:55,losses:45,modelVersion:'invalid',
      coefficients:[1],intercept:0,
    })).toBeNull();
  });
});
