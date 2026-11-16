import {
  evaluateAdvisoryAlternateTrial as evaluate,
  ADVISORY_ALTERNATE_START,ADVISORY_ALTERNATE_END,
  ADVISORY_ALTERNATE_MAX_LOT,ADVISORY_ALTERNATE_ENTRY_LIMIT,
} from './pepperstone-demo-advisory-alternate-trial';
const input=()=>({
  enabled:true,brokerVerified:true,
  now:new Date('2026-11-17T16:15:45.000Z'),
  decisionTime:new Date('2026-11-17T16:15:00.000Z'),
  route:'CONFIRMED_REVERSAL',side:'SELL' as const,
  paperAdmitted:true,governanceEligible:true,portfolioSnapshotAvailable:true,
  ensembleScore:0.69,planbDirectionQuality:0.7,netExpectedR:0.2,
  executionSpreadEvidenceValid:true,paperExecutionCostUsable:true,
  eventRisk:'CLEAR',driftState:'IN_DISTRIBUTION',sleeveState:'COLLECTING',
  m1Route:'ABSTAIN',m1Confidence:0.72,m1DirectionQuality:0.64,
  stopDistance:0.0007,targetDistance:0.0013,
  expertSide:'SELL' as 'BUY' | 'SELL' | null,
  expertState:'ABSTAIN',expertNative:true,expertAdmitted:false,
  expertFreshness:45,expertProbability:0.29,
  expertLongVotes:1,expertShortVotes:2,
});
describe('Pepperstone DEMO advisory alternate entry pilot',()=>{
  it('allows separately admitted reversal with same-side majority when expert ABSTAINS',()=>{
    expect(evaluate(input())).toMatchObject({
      eligible:true,reason:'ELIGIBLE',route:'CONFIRMED_REVERSAL',
      maxLot:4,bypassesBrokerRisk:false,bypassesModelAdmission:false,
      modifiesOpenPositions:false,
    });
    expect(ADVISORY_ALTERNATE_MAX_LOT).toBe(4);
    expect(ADVISORY_ALTERNATE_ENTRY_LIMIT).toBe(4);
  });
  it('permits independently admitted EARLY_TRANSITION on same evidence',()=>{
    expect(evaluate({...input(),route:'EARLY_TRANSITION'}).eligible).toBe(true);
  });
  it('cannot authorize LIVE, unknown broker or research-only non-admitted candidate',()=>{
    expect(evaluate({...input(),brokerVerified:false}).reason).toBe('WRONG_ACCOUNT');
    expect(evaluate({...input(),paperAdmitted:false}).reason)
      .toBe('NOT_ADMITTED_REVERSAL_OR_TRANSITION');
    expect(evaluate({...input(),route:'TREND_CONTINUATION'}).reason)
      .toBe('NOT_ADMITTED_REVERSAL_OR_TRANSITION');
  });
  it('cannot execute before or after the authorized Tuesday session',()=>{
    expect(ADVISORY_ALTERNATE_START).toBe('2026-11-17T15:00:00.000Z');
    expect(ADVISORY_ALTERNATE_END).toBe('2026-11-17T20:00:00.000Z');
    expect(evaluate({...input(),now:new Date('2026-11-16T23:40:00.000Z')}).reason)
      .toBe('OUTSIDE_WINDOW');
    expect(evaluate({...input(),now:new Date(ADVISORY_ALTERNATE_END)}).reason)
      .toBe('OUTSIDE_WINDOW');
    expect(evaluate({...input(),decisionTime:new Date('2026-11-17T16:12:00.000Z')}).reason)
      .toBe('STALE_DECISION');
  });
  it('fails closed on negative after-cost economics, unsafe market or spread',()=>{
    expect(evaluate({...input(),netExpectedR:-0.2}).reason)
      .toBe('NEGATIVE_AFTER_FEE_OR_MARKET_RISK');
    expect(evaluate({...input(),eventRisk:'HIGH_IMPACT_BLOCK'}).reason)
      .toBe('NEGATIVE_AFTER_FEE_OR_MARKET_RISK');
    expect(evaluate({...input(),executionSpreadEvidenceValid:false}).reason)
      .toBe('NEGATIVE_AFTER_FEE_OR_MARKET_RISK');
    expect(evaluate({...input(),driftState:'OUT_OF_DISTRIBUTION'}).reason)
      .toBe('NEGATIVE_AFTER_FEE_OR_MARKET_RISK');
  });
  it('cannot trade a contradicted expert side or a final expert error',()=>{
    expect(evaluate({...input(),expertSide:'BUY'}).reason)
      .toBe('EXPERT_DIRECTION_NOT_ALIGNED');
    expect(evaluate({...input(),expertLongVotes:2,expertShortVotes:1}).reason)
      .toBe('EXPERT_DIRECTION_NOT_ALIGNED');
    expect(evaluate({...input(),expertState:'UNAVAILABLE'}).reason)
      .toBe('EXPERT_DIRECTION_NOT_ALIGNED');
    expect(evaluate({...input(),expertProbability:0.04}).reason)
      .toBe('EXPERT_DIRECTION_NOT_ALIGNED');
  });
  it('cannot bridge weak M1 direction or missing protective stop/target',()=>{
    expect(evaluate({...input(),m1DirectionQuality:0.3}).reason)
      .toBe('M1_DIRECTION_OR_STOP_NOT_QUALIFIED');
    expect(evaluate({...input(),stopDistance:0}).reason)
      .toBe('M1_DIRECTION_OR_STOP_NOT_QUALIFIED');
    expect(evaluate({...input(),targetDistance:0.0004}).reason)
      .toBe('M1_DIRECTION_OR_STOP_NOT_QUALIFIED');
  });
  it('cannot override a confirmed opposite M1 route or weak model',()=>{
    expect(evaluate({...input(),m1Route:'M1_TREND_CONTINUATION'}).reason)
      .toBe('M1_DIRECTION_OR_STOP_NOT_QUALIFIED');
    expect(evaluate({...input(),ensembleScore:0.5}).reason)
      .toBe('NEGATIVE_AFTER_FEE_OR_MARKET_RISK');
  });
});