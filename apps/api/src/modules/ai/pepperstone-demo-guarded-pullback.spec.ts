import {evaluateGuardedPullback, GUARDED_PULLBACK_LOT_CAP} from './pepperstone-demo-guarded-pullback';
const now=new Date('2026-11-17T02:15:00Z');
const good=()=>({
  enabled:true,brokerVerified:true,decisionTime:now,
  priorExtendedAt:new Date('2026-11-17T02:07:00Z'),
  planBRoute:'TREND_CONTINUATION',planBRegime:'TREND_HEALTHY',
  paperAdmitted:true,governanceEligible:true,portfolioSnapshotAvailable:true,
  driftState:'IN_DISTRIBUTION',eventRisk:'CLEAR',
  spreadVerified:true,costsUsable:true,netExpectedR:0.28,
  confidence:0.72,directionQuality:0.72,
  extensionAtr:0.72,rsi14:57,alignedEmaSeparationAtr:0.76,alignedM15:0.4,
  alignedMomentum1Atr:0.19,alignedMomentum3Atr:0.51,
  alignedM5LatestBodyPressure:0.30,m1Route:'M1_TREND_CONTINUATION',
  direction:'BUY' as const,expertDirection:'BUY' as 'BUY'|'SELL'|null,
  expertNative:true,expertFreshnessSeconds:40,expertLongVotes:2,expertShortVotes:1,
  stopDistance:0.0005,targetDistance:0.0009
});
describe('DEMO guarded trend pullback recovery',()=>{
  it('enables a cooled-off, reaccelerating in-distribution continuation with a small hard lot cap',()=>{
    expect(evaluateGuardedPullback(good())).toMatchObject({
      eligible:true,reason:'GUARDED_PULLBACK_RECOVERY',
      lotCap:0.2,bypassesPlanBAdmission:false,bypassesBrokerRisk:false
    });
    expect(GUARDED_PULLBACK_LOT_CAP).toBe(0.2);
  });
  it.each([
    [{enabled:false},'DISABLED_OR_UNVERIFIED'],
    [{brokerVerified:false},'DISABLED_OR_UNVERIFIED'],
    [{priorExtendedAt:null},'NO_PRIOR_EXTENDED_TREND'],
    [{priorExtendedAt:new Date('2026-11-17T02:14:00Z')},'NO_PRIOR_EXTENDED_TREND'],
    [{priorExtendedAt:new Date('2026-11-17T01:45:00Z')},'NO_PRIOR_EXTENDED_TREND'],
    [{paperAdmitted:false},'NOT_ADMITTED_CONTINUATION'],
    [{planBRoute:'EARLY_TRANSITION'},'NOT_ADMITTED_CONTINUATION'],
    [{planBRegime:'TREND_EXTENDED'},'NOT_ADMITTED_CONTINUATION'],
    [{governanceEligible:false},'NOT_ADMITTED_CONTINUATION'],
    [{driftState:'OUT_OF_DISTRIBUTION'},'CURRENT_MARKET_NOT_NORMAL'],
    [{extensionAtr:2.9},'WEAK_OR_EXCESSIVE_PULLBACK'],
    [{rsi14:85},'WEAK_OR_EXCESSIVE_PULLBACK'],
    [{rsi14:25},'WEAK_OR_EXCESSIVE_PULLBACK'],
    [{alignedMomentum3Atr:-0.4},'M1_REACCELERATION_MISSING'],
    [{m1Route:'ABSTAIN'},'M1_REACCELERATION_MISSING'],
    [{expertDirection:'SELL'},'EXPERT_NOT_ALIGNED'],
    [{expertLongVotes:1,expertShortVotes:2},'EXPERT_NOT_ALIGNED'],
    [{expertNative:false},'EXPERT_NOT_ALIGNED'],
    [{eventRisk:'HIGH_IMPACT_BLOCK'},'MARKET_OR_COST_UNSAFE'],
    [{spreadVerified:false},'MARKET_OR_COST_UNSAFE'],
    [{netExpectedR:-0.1},'MARKET_OR_COST_UNSAFE'],
    [{targetDistance:0.00055},'MARKET_OR_COST_UNSAFE'],
  ] as const)('rejects unsafe or unqualified reentry %o', (patch,reason)=>{
    expect(evaluateGuardedPullback({...good(),...patch} as ReturnType<typeof good>))
      .toMatchObject({eligible:false,reason,lotCap:0});
  });
});
