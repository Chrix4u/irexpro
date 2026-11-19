import {evaluatePepperstoneDemoExitMonitor as assess} from './pepperstone-demo-exit-signal-monitor';
const now=new Date('2026-11-19T08:43:00Z');
const base={
  enabled:true,ownerPepperstoneUsdDemoVerified:true,
  route:'CONFIRMED_REVERSAL',direction:'BUY' as const,
  brokerDirection:'BUY',instrument:'USDJPY',brokerInstrument:'USDJPY',
  tradeLots:2,brokerLots:2,initialRiskPnl:100,
  peakBrokerNetPnl:130,currentBrokerNetPnl:108,
  entryPrice:159.5,brokerStop:159.45,authoritativeStop:159.45,
  brokerTakeProfit:159.8,authoritativeTakeProfit:159.8,currentPrice:159.7,
  observedAt:now,sameSideContinuationAt:new Date(now.getTime()-40000),
  oppositeExecutableReversal:false,
  m1:{completedBars:3,liveQuoteBars:3,latestAgeSeconds:18,
    adverseBars:0,alignedLatestBodyPressure:.48,alignedMomentum3:.45},
};
describe('Pepperstone DEMO existing-position exit-intelligence monitor',()=>{
  it('recognizes supportive continuation but cannot delay any real close',()=>{
    const x=assess(base);
    expect(x.recommendation).toBe('HEALTHY_CONTINUATION_RESEARCH');
    expect(x.reason).toMatch(/NO_VERIFIED_POSITIVE_BROKER_STOP/);
    expect(x.hypotheticalGraceEligibleOnlyIfProtected).toBe(false);
    expect(x.mode).toBe('SHADOW_ONLY');
    expect([x.closeOrders,x.stopAmendments,x.newOrders]).toEqual([0,0,0]);
    expect(x.changesExecution).toBe(false);
  });
  it('recognizes an already acknowledged positive broker stop separately',()=>{
    const x=assess({...base,brokerStop:159.58,authoritativeStop:159.58});
    expect(x.existingBrokerProfitStopVerified).toBe(true);
    expect(x.hypotheticalGraceEligibleOnlyIfProtected).toBe(true);
    expect(x.changesExecution).toBe(false);
  });
  it('flags independent two-candle adverse momentum and does not reverse orders',()=>{
    const x=assess({...base,m1:{...base.m1,adverseBars:2,
      alignedMomentum3:-.24,alignedLatestBodyPressure:-.53}});
    expect(x.recommendation).toBe('DETERIORATION_REVIEW_NOW');
    expect(x.newOrders).toBe(0);
  });
  it('treats executable opposite reversal as a warning not a broker order',()=>{
    expect(assess({...base,oppositeExecutableReversal:true}).recommendation)
      .toBe('DETERIORATION_REVIEW_NOW');
  });
  it('does not confuse a new-entry veto with a current-position M1 vote',()=>{
    expect(assess({...base,route:'EARLY_TRANSITION'}).recommendation)
      .toBe('HEALTHY_CONTINUATION_RESEARCH');
    expect(assess({...base,route:'TREND_CONTINUATION'}).recommendation)
      .toBe('HEALTHY_CONTINUATION_RESEARCH');
  });
  it('rejects stale quotes and missing independent M1 evidence',()=>{
    for(const m1 of [null,{...base.m1,latestAgeSeconds:130},
      {...base.m1,liveQuoteBars:1}]){
      expect(assess({...base,m1}).recommendation)
        .toBe('STALE_OR_INCOMPLETE_CANDLE_EVIDENCE');
    }
  });
  it('never reaches other brokers or missing/mismatched protective barriers',()=>{
    for(const patch of [{ownerPepperstoneUsdDemoVerified:false},
      {brokerLots:4},{brokerInstrument:'EURUSD'}, {brokerTakeProfit:159.7},
      {brokerStop:null}, {enabled:false}, {initialRiskPnl:null}]){
      expect(assess({...base,...patch}).recommendation)
        .toBe('UNVERIFIED_NO_INFERENCE');
    }
  });
  it('keeps the normal profit lock when no proven trend or small peak',()=>{
    expect(assess({...base,peakBrokerNetPnl:12}).recommendation)
      .toBe('NOT_MEANINGFUL_PROFIT');
    expect(assess({...base,sameSideContinuationAt:null}).recommendation)
      .toBe('INDETERMINATE_KEEP_PROTECTION');
  });
  it('detects real early adverse candlestick warnings before 0.25R',()=>{
    const smallPeak={...base,peakBrokerNetPnl:10,currentBrokerNetPnl:-25,
      m1:{...base.m1,adverseBars:3,alignedMomentum3:-0.42,
        alignedLatestBodyPressure:-0.7}};
    const flagged=assess(smallPeak);
    expect(flagged.recommendation).toBe('DETERIORATION_REVIEW_NOW');
    expect(flagged.peakR).toBeCloseTo(0.1);
    expect(flagged.closeOrders).toBe(0);
    expect(flagged.newOrders).toBe(0);
    expect(flagged.changesExecution).toBe(false);
    expect(assess({...smallPeak,m1: {...smallPeak.m1,liveQuoteBars:1}})
      .recommendation).toBe('STALE_OR_INCOMPLETE_CANDLE_EVIDENCE');
    expect(assess({...smallPeak,m1:{...smallPeak.m1,adverseBars:0,
      alignedMomentum3:0.12,alignedLatestBodyPressure:0.18}})
      .recommendation).toBe('NOT_MEANINGFUL_PROFIT');
  });
});
