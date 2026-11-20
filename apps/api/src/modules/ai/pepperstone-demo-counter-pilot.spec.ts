import {
  evaluateCounterPilot as evaluate,
  COUNTER_PILOT_START,COUNTER_PILOT_END,
  COUNTER_PILOT_LOT_CAP,COUNTER_PILOT_ENTRY_LIMIT,
} from './pepperstone-demo-counter-pilot';
import type { CounterPilotModel } from './pepperstone-demo-counter-pilot';
import { capM1DemoRequestedVolumeByRisk } from './m1-tactical-currency-exposure';
const expert = {
  state:'CONFIRM' as const,reason:null,
  admitted:true,allBrokerNative:true,direction:'SELL' as const,
  longVotes:0,shortVotes:3,ensembleConfidence:0.76,
  meanOpportunityProbability:0.74,freshnessSeconds:25,
  decisionTime:'2026-11-16T21:14:00.000Z',
  regime:'active_clean',modifiesExecution:false as const,
};
const model=():CounterPilotModel=>({
  ensemble:{strategyRoute:'EARLY_TRANSITION',paperAdmitted:true,
    ensembleScore:0.74,directionQuality:0.73},
  governance:{paperExecutionEligible:true,netExpectedR:0.26,
    paperExecutionCostUsable:true,executionSpreadEvidenceValid:true,
    eventRisk:'CLEAR',driftState:'IN_DISTRIBUTION'},
  trainedExpert:{...expert},
  portfolioSnapshotAvailable:true,
});
const input=()=>({
  enabled:true,brokerVerified:true,
  now:new Date('2026-11-16T21:15:30Z'),
  decisionTime:new Date('2026-11-16T21:15:00Z'),
  side:'SELL' as const,m1Route:'ABSTAIN',
  m1Confidence:0.73,m1DirectionQuality:0.68,
  stopDistance:0.0008,targetDistance:0.0013,
  candidate:model(),
  opposingSource:{...model(),
    ensemble:{...model().ensemble,strategyRoute:'CONFIRMED_REVERSAL'},
    trainedExpert:{...expert,state:'CONFLICT' as const},
  },
});
describe('independent counter-entry Pepperstone DEMO pilot',()=>{
  it('qualifies independently scored opposite SELL with native expert CONFIRM',()=>{
    const r=evaluate(input());
    expect(r).toMatchObject({
      eligible:true,reason:'ELIGIBLE',sourceSide:'BUY',
      sourceRoute:'CONFIRMED_REVERSAL',
      route:'EARLY_TRANSITION',maxLot:4,
      endsAt:COUNTER_PILOT_END,bypassesBrokerRisk:false,
      bypassesModelAdmission:false,modifiesOpenPositions:false,
    });
    expect(COUNTER_PILOT_ENTRY_LIMIT).toBe(4);
    expect(COUNTER_PILOT_LOT_CAP).toBe(4);
  });
  it('allows 4.00 lots only when stop-loss risk remains at or under 0.25% of allocated DEMO capital',()=>{
    const lowStopRisk=capM1DemoRequestedVolumeByRisk({
      allocatedCapital:40000,instrument:'EURUSD',
      entryPrice:1.10,stopLoss:1.1002,requestedVolumeCap:COUNTER_PILOT_LOT_CAP,
    });
    expect(lowStopRisk.volumeCap).toBe(4);
    expect(lowStopRisk.permittedRiskAtStop).toBeCloseTo(80,2);
    const widerStop=capM1DemoRequestedVolumeByRisk({
      allocatedCapital:40000,instrument:'EURUSD',
      entryPrice:1.10,stopLoss:1.1005,requestedVolumeCap:COUNTER_PILOT_LOT_CAP,
    });
    expect(widerStop.volumeCap).toBe(2);
    expect(widerStop.permittedRiskAtStop).toBeCloseTo(100,2);
  });
  it('cannot replay the expired Monday trial or send outside tonight pilot window',()=>{
    expect(COUNTER_PILOT_START).toBe('2026-11-16T21:00:00.000Z');
    const a=input();
    expect(evaluate({...a,now:new Date('2026-11-16T20:59:00Z')}).reason)
      .toBe('OUTSIDE_WINDOW');
    expect(evaluate({...a,now:new Date('2026-11-16T21:40:00Z')}).reason)
      .toBe('STALE_SIGNAL');
    expect(evaluate({...a,now:new Date('2026-11-17T00:00:00Z')}).reason)
      .toBe('OUTSIDE_WINDOW');
    expect(evaluate({...a,decisionTime:new Date('2026-11-16T21:11:00Z')}).reason)
      .toBe('STALE_SIGNAL');
  });
  it('fails closed on disconnected broker, disabled flag or wrong source route',()=>{
    const a=input();
    expect(evaluate({...a,brokerVerified:false}).reason).toBe('WRONG_ACCOUNT');
    expect(evaluate({...a,enabled:false}).reason).toBe('DISABLED');
    expect(evaluate({...a,opposingSource:null}).reason)
      .toBe('NO_OPPOSING_ADMITTED_REVERSAL');
    // Missing candidate evidence is not a broker failure; either way no order.
    expect(evaluate({...a,brokerVerified:false,opposingSource:null}).reason)
      .toBe('NO_OPPOSING_ADMITTED_REVERSAL');
    a.opposingSource.ensemble.strategyRoute='TREND_CONTINUATION';
    expect(evaluate(a).reason).toBe('NO_OPPOSING_ADMITTED_REVERSAL');
  });
  it('rejects unadmitted or abstaining native expert despite three votes',()=>{
    const a=input();
    a.candidate.trainedExpert.state='ABSTAIN';
    a.candidate.trainedExpert.admitted=false;
    expect(evaluate(a).reason).toBe('EXPERT_DID_NOT_CONFIRM');
    const b=input();b.candidate.trainedExpert.meanOpportunityProbability=0.17;
    expect(evaluate(b).reason).toBe('EXPERT_DID_NOT_CONFIRM');
  });
  it('rejects an opposite TREND_CONTINUATION even when it has apparent votes',()=>{
    const a=input();a.candidate.ensemble.strategyRoute='TREND_CONTINUATION';
    expect(evaluate(a).reason).toBe('COUNTER_NOT_QUALIFIED');
  });
  it('requires independent positive after-cost return, broker spreads and drift safety',()=>{
    const a=input();a.candidate.governance.netExpectedR=-0.13;
    expect(evaluate(a).reason).toBe('COUNTER_NOT_QUALIFIED');
    const b=input();b.candidate.governance.executionSpreadEvidenceValid=false;
    expect(evaluate(b).reason).toBe('COUNTER_NOT_QUALIFIED');
    const c=input();c.candidate.governance.driftState='OUT_OF_DISTRIBUTION';
    expect(evaluate(c).reason).toBe('COUNTER_NOT_QUALIFIED');
  });
  it('requires own M1 confirmation and its own protective stop and target',()=>{
    const a=input();a.m1DirectionQuality=0.3;
    expect(evaluate(a).reason).toBe('COUNTER_M1_NOT_QUALIFIED');
    const b=input();b.stopDistance=0;
    expect(evaluate(b).reason).toBe('INDEPENDENT_STOP_TARGET_MISSING');
    const c=input();c.targetDistance=c.stopDistance;
    expect(evaluate(c).reason).toBe('INDEPENDENT_STOP_TARGET_MISSING');
  });
  it('can symmetrically evaluate a BUY counter of an admitted SELL reversal',()=>{
    const a=input();
    a.side='BUY' as any;
    a.candidate.trainedExpert.direction='BUY';
    a.candidate.trainedExpert.longVotes=3;
    a.candidate.trainedExpert.shortVotes=0;
    a.opposingSource.trainedExpert.direction='BUY' as any;
    expect(evaluate(a).eligible).toBe(true);
  });
});