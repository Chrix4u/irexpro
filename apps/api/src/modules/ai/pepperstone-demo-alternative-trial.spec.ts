import {
  evaluateDemoAlternativeTrial as evaluate,
  DEMO_ALTERNATIVE_TRIAL_END,
  DEMO_ALTERNATIVE_TRIAL_LOT_CAP,
  DEMO_ALTERNATIVE_TRIAL_ENTRY_LIMIT,
} from './pepperstone-demo-alternative-trial';

const input = () => ({
  enabled:true,brokerVerified:true,
  now:new Date('2026-11-16T20:20:00Z'),
  decisionTime:new Date('2026-11-16T20:19:00Z'),
  route:'CONFIRMED_REVERSAL',
  m1Route:'ABSTAIN',
  ensembleScore:0.66,planbDirectionQuality:0.69,
  paperAdmitted:true,governanceEligible:true,
  portfolioSnapshotAvailable:true,executionSpreadEvidenceValid:true,
  paperExecutionCostUsable:true,netExpectedR:0.21,
  eventRisk:'CLEAR',sleeveState:'COLLECTING',
  m1Confidence:0.75,m1DirectionQuality:0.65,
  side:'BUY' as const,expertSide:'BUY' as 'BUY'|'SELL'|null,
  expertNative:true,expertConfidence:0.72,expertFreshness:100,
  expertLongVotes:3,expertShortVotes:0,
});
describe('timeboxed Pepperstone DEMO alternate timing admission',()=>{
  it('allows a fully admitted reversal to resolve an M1 ABSTAIN label with independent expert unanimity',()=>{
    expect(evaluate(input())).toMatchObject({
      eligible:true,reason:'ELIGIBLE',route:'CONFIRMED_REVERSAL',
      maxLot:0.01,endsAt:DEMO_ALTERNATIVE_TRIAL_END,
      bypassesBrokerRisk:false,bypassesModelAdmission:false,
      modifiesOpenPositions:false,
    });
    expect(DEMO_ALTERNATIVE_TRIAL_ENTRY_LIMIT).toBe(6);
    expect(DEMO_ALTERNATIVE_TRIAL_LOT_CAP).toBe(0.01);
  });
  it('allows early transition with equivalent full proof',()=>{
    expect(evaluate({...input(),route:'EARLY_TRANSITION',m1Route:'M1_EARLY_TRANSITION'}).eligible).toBe(true);
  });
  it('never authorizes continuation or M1 continuation semantic conflicts',()=>{
    expect(evaluate({...input(),route:'TREND_CONTINUATION'}).eligible).toBe(false);
    expect(evaluate({...input(),m1Route:'M1_TREND_CONTINUATION'}).eligible).toBe(false);
  });
  it('refuses historical rescoring, stale candidates, future decisions and any decision after 21:00 UTC',()=>{
    const base=input();
    expect(evaluate({...base,decisionTime:new Date('2026-11-16T19:15:00Z')}).reason).toBe('STALE_CANDIDATE');
    expect(evaluate({...base,decisionTime:new Date('2026-11-16T20:10:00Z')}).reason).toBe('STALE_CANDIDATE');
    expect(evaluate({...base,decisionTime:new Date('2026-11-16T20:20:10Z')}).reason).toBe('STALE_CANDIDATE');
    expect(evaluate({...base,now:new Date('2026-11-16T21:00:00Z')}).reason).toBe('OUTSIDE_WINDOW');
    expect(evaluate({...base,now:new Date('2026-11-16T19:59:59Z')}).reason).toBe('OUTSIDE_WINDOW');
  });
  it('fails closed for wrong broker or disabled flag',()=>{
    expect(evaluate({...input(),brokerVerified:false}).reason).toBe('WRONG_BROKER');
    expect(evaluate({...input(),enabled:false}).reason).toBe('DISABLED');
  });
  it.each([
    {paperAdmitted:false},{governanceEligible:false},{portfolioSnapshotAvailable:false},
    {executionSpreadEvidenceValid:false},{paperExecutionCostUsable:false},
    {eventRisk:'UNVERIFIED'},{eventRisk:'HIGH_IMPACT_BLOCK'},
    {sleeveState:'BLOCKED'},{ensembleScore:0.59},
    {planbDirectionQuality:0.53},{netExpectedR:0.1},
  ])('does not bypass actual model/market/cost prerequisites: %j',(bad)=>{
    expect(evaluate({...input(),...bad}).reason).toBe('MODEL_OR_MARKET_NOT_QUALIFIED');
  });
  it.each([
    {m1Confidence:0.6},{m1DirectionQuality:0.4},{m1Route:'M1_CONFIRMED_REVERSAL'},
  ])('requires minimum M1 feature quality: %j',(bad)=>{
    expect(evaluate({...input(),...bad}).eligible).toBe(false);
  });
  it.each([
    {expertSide:'SELL' as const}, {expertNative:false}, {expertConfidence:0.64},
    {expertFreshness:301}, {expertFreshness:null},
    {expertLongVotes:2,expertShortVotes:1},
    {expertLongVotes:null},
  ])('requires unanimous, timestamped, aligned broker-native expert votes: %j',(bad)=>{
    expect(evaluate({...input(),...bad}).reason).toBe('EXPERT_NOT_CONFIRMED');
  });
});
