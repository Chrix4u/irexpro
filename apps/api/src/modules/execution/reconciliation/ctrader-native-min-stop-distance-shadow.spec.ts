import {evaluateCtraderStopDistanceProof as assess}
  from './ctrader-native-min-stop-distance-shadow';

const base={
  ownerDemoVerified:true,brokerId:'pepperstone-ctrader',
  accountType:'DEMO',currency:'USD',instrument:'EURUSD',
  direction:'BUY' as const,entryPrice:1.10000,
  originalStop:1.09800,originalTakeProfit:1.10400,
  proposedStop:1.10120,lastBid:1.10230,lastAsk:1.10232,
  observedAt:new Date('2026-11-19T12:10:00Z'),
  quoteObservedAt:new Date('2026-11-19T12:09:58Z'),
  symbol:{symbol:'EUR/USD',description:'Euro-dollar',digits:5,
    minLot:'0.01',maxLot:'100',lotStep:'0.01',
    contractSize:'100000',minStopLossDistance:'20',
    minStopLossDistanceUnit:'POINTS' as const},
};
describe('Pepperstone DEMO cTrader native minimum stop preflight',()=>{
  it('verifies a BUY stop is on broker tick and beyond published point distance',()=>{
    const x=assess(base);
    expect(x).toMatchObject({
      mode:'SHADOW_ONLY',candidateMeetsAdvertisedMinDistance:true,
      reason:'BROKER_MIN_STOP_POINTS_PASSED_REQUIRES_PROVIDER_ACK_AND_READBACK',
      minDistancePrice:0.0002,brokerOrderActions:0,changesExecution:false,
    });
    expect(x.stopHeadroomPrice).toBeGreaterThan(0);
  });
  it('checks SELL from ask, never from bid',()=>{
    const x=assess({...base,direction:'SELL',entryPrice:1.10000,
      originalStop:1.10200,originalTakeProfit:1.09500,
      proposedStop:1.09880,lastBid:1.09750,lastAsk:1.09752});
    expect(x.candidateMeetsAdvertisedMinDistance).toBe(true);
    const tooClose=assess({...base,direction:'SELL',entryPrice:1.10000,
      originalStop:1.10200,originalTakeProfit:1.09500,
      proposedStop:1.09772,lastBid:1.09750,lastAsk:1.09752});
    expect(tooClose.reason).toBe('STOP_TOO_CLOSE_TO_BROKER_MARKET');
  });
  it('handles JPY 3-digit points from true symbol digits, not FX-major heuristics',()=>{
    const x=assess({...base,instrument:'USDJPY',direction:'SELL',
      entryPrice:159.600,originalStop:159.680,
      originalTakeProfit:159.300,proposedStop:159.530,
      lastBid:159.478,lastAsk:159.482,
      symbol:{...base.symbol,symbol:'USDJPY',digits:3,
        minStopLossDistance:'25'}});
    expect(x.candidateMeetsAdvertisedMinDistance).toBe(true);
    expect(x.minDistancePrice).toBe(0.025);
  });
  it.each([
    {ownerDemoVerified:false},{brokerId:'ctrader'},
    {accountType:'LIVE'},{currency:'EUR'},
  ])('never authorizes a non-owner or LIVE scope %j',patch=>{
    expect(assess({...base,...patch}).reason)
      .toBe('NOT_OWNER_PEPPERSTONE_USD_DEMO');
  });
  it('does not guess missing or percentage-based broker minimum stop units',()=>{
    expect(assess({...base,symbol:null}).reason)
      .toBe('SYMBOL_METADATA_MISSING_OR_UNMATCHED');
    expect(assess({...base,symbol:{...base.symbol,
      minStopLossDistance:undefined}}).reason)
      .toBe('MIN_STOP_DISTANCE_UNAVAILABLE');
    expect(assess({...base,symbol:{...base.symbol,
      minStopLossDistanceUnit:'PERCENTAGE' as const}}).reason)
      .toBe('PERCENTAGE_DISTANCE_NOT_NORMALIZED');
  });
  it.each([
    {quoteObservedAt:null},
    {quoteObservedAt:new Date('2026-11-19T12:09:52Z')},
    {quoteObservedAt:new Date('2026-11-19T12:10:03Z')},
    {lastAsk:1.10220},{lastBid:null},
  ])('requires fresh, valid broker-native quotes %j',patch=>{
    expect(assess({...base,...patch}).reason)
      .toBe('STALE_OR_INVALID_BROKER_QUOTE');
  });
  it('rejects off-grid, inside-spread, incorrectly directed and weak stops',()=>{
    for(const patch of [
      {proposedStop:1.101201},
      {proposedStop:1.10000},
      {proposedStop:1.10229},
      {originalStop:1.10150},
      {originalTakeProfit:1.09900},
    ])expect(assess({...base,...patch}).candidateMeetsAdvertisedMinDistance)
      .toBe(false);
  });
});
