import {
  evaluatePepperstoneDemoRolloverExposure,
  isForexFinalTenMinutesBeforeRollover,
  type PepperstoneRolloverExposureInput,
} from './pepperstone-rollover-exposure-shadow';

const at = new Date('2026-11-12T21:55:10.000Z');
const initial: PepperstoneRolloverExposureInput = {
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  observedAt: at,
  direction: 'SELL' as const,
  instrument: 'AUDUSD',
  positionSizeLots: 0.01,
  initialRiskPnl: 0.48,
  currentBrokerNetPnl: -0.32,
  entryPrice: 0.68053,
  authoritativeStop: 0.68101,
  brokerStop: 0.68101,
  bid: 0.68084,
  ask: 0.68086,
  quoteObservedAt: new Date('2026-11-12T21:55:05.000Z'),
};
const evaluate = (patch: Partial<PepperstoneRolloverExposureInput> = {}) =>
  evaluatePepperstoneDemoRolloverExposure({ ...initial, ...patch });

describe('Pepperstone DEMO pre-rollover position stop-exposure SHADOW (no close authority)', () => {
  it.each([
    ['2026-11-12T21:49:59Z',false],
    ['2026-11-12T21:50:00Z',true],
    ['2026-11-12T21:59:59Z',true],
    ['2026-11-12T22:00:00Z',false],
    ['2026-07-15T20:49:59Z',false],
    ['2026-07-15T20:50:00Z',true],
    ['2026-07-15T20:59:59Z',true],
    ['2026-07-15T21:00:00Z',false],
  ] as const)('NY local 16:50–16:59 shadow at %s = %s',
    (time,expected) =>
      expect(isForexFinalTenMinutesBeforeRollover(new Date(time))).toBe(expected));

  it('flags the observed SELL rollover risk using broker ASK not mid, with no authority', () => {
    const result = evaluate();
    expect(result).toMatchObject({
      reason:'NEAR_STOP_AND_ADVERSE',
      mode:'SHADOW_ONLY',wouldConsiderPreRolloverClose:true,
      noBrokerTradeAuthority:true,modifiesOpenPositions:false,
    });
    expect(result.stopDistancePips).toBeCloseTo(1.5, 3);
    expect(result.observedSpreadPips).toBeCloseTo(0.2, 3);
    expect(result.initialStopPips).toBeCloseTo(4.8, 3);
    expect(result.currentR).toBeCloseTo(-2/3, 3);
  });

  it('detects spread already larger than the remaining stop buffer',()=>{
    expect(evaluate({bid:0.68079,ask:0.68095}).reason).toBe('SPREAD_THREATENS_STOP');
  });
  it('does not flag an otherwise healthy runner just because rollover is near',()=>{
    expect(evaluate({
      bid:0.68039,ask:0.68041,currentBrokerNetPnl:0.24,
    }).wouldConsiderPreRolloverClose).toBe(false);
  });
  it('fails closed on stale/missing broker quote, mismatched protective stop, invalid risk',()=>{
    expect(evaluate({quoteObservedAt:new Date('2026-11-12T21:54:00Z')})
      .reason).toBe('STALE_OR_INVALID_BROKER_QUOTE');
    expect(evaluate({bid:0,ask:0}).reason).toBe('STALE_OR_INVALID_BROKER_QUOTE');
    expect(evaluate({brokerStop:0.68150}).reason).toBe('BROKER_STOP_NOT_VERIFIED');
    expect(evaluate({initialRiskPnl:null}).reason).toBe('MISSING_BROKER_RISK');
  });
  it('never acts on LIVE/other broker or outside the exact NY risk window',()=>{
    for(const patch of [{accountType:'LIVE'}, {brokerId:'ctrader'}]){
      expect(evaluate(patch).reason).toBe('NOT_VERIFIED_PEPPERSTONE_DEMO');
    }
    expect(evaluate({observedAt:new Date('2026-11-12T18:55:00Z')}).reason)
      .toBe('OUTSIDE_RISK_WINDOW');
  });
  it('uses BID on a BUY and the correct pip unit for JPY pairs',()=>{
    const result=evaluate({
      instrument:'USDJPY',direction:'BUY',entryPrice:152.20,
      authoritativeStop:152.15,brokerStop:152.15,
      bid:152.165,ask:152.17,currentBrokerNetPnl:-0.32,
    });
    expect(result.stopDistancePips).toBeCloseTo(1.5,3);
    expect(result.initialStopPips).toBeCloseTo(5,3);
    expect(result.reason).toBe('NEAR_STOP_AND_ADVERSE');
    expect(result.modifiesOpenPositions).toBe(false);
  });
  it('does not preempt provider-owned SL/TP if the quote already crossed broker stop',()=>{
    expect(evaluate({bid:0.68099,ask:0.68102}).reason).toBe('STOP_ALREADY_CROSSED');
  });
});
