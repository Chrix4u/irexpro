import { evaluateCandleAwareProfitExitShadow as check } from './candle-aware-profit-patience-shadow';

const m1 = [
  { startedAt:new Date('2026-11-23T12:13:00Z'),timeframeMinutes:1 as const, open:159.084,high:159.086,low:159.042,close:159.044,brokerNativeSampleCount:245 },
  { startedAt:new Date('2026-11-23T12:14:00Z'),timeframeMinutes:1 as const, open:159.045,high:159.048,low:159.030,close:159.044,brokerNativeSampleCount:296 },
];
const m5 = { startedAt:new Date('2026-11-23T12:10:00Z'),timeframeMinutes:5 as const,open:159.099,high:159.109,low:159.030,close:159.044,brokerNativeSampleCount:1095 };
const input = { brokerId:'pepperstone-ctrader',accountType:'DEMO',direction:'SELL' as const,
  asOf:new Date('2026-11-23T12:15:00.495Z'), openedAt:new Date('2026-11-23T12:13:24.014Z'),
  entryPrice:159.072,currentPrice:159.052,originalStopPrice:159.119,takeProfitPrice:158.989,
  grossCurrentPnl:89.03,grossPeakPnl:128.65,initialRiskPnl:220,
  conservativeEstimatedCosts:42,lastTwoCompletedM1:m1,lastCompletedM5:m5,
};
describe('as-of broker-native USDJPY candle-aware profit-exit research',()=>{
  it('identifies a research candidate IF both M1 and M5 were genuinely available as-of 12:15',()=>{
    const out=check(input);
    expect(out).toMatchObject({mode:'SHADOW_ONLY',reason:'SAME_DIRECTION_PULLBACK_CANDIDATE',
      wouldResearchProtectedGrace:true,maxGraceSeconds:180,
      needsBrokerAcknowledgedPositiveStop:true,noTradeAuthority:true,changesLiveExit:false,m5Aligned:true});
  });
  it('does not claim the candidate is an executable delayed close',()=>{
    const out=check(input);
    expect(out.changesLiveExit).toBe(false);
    expect(out.noTradeAuthority).toBe(true);
  });
  it('does not infer the unavailable 12:10 M5 candle from a row created at 12:17',()=>{
    // Actual M5 broker-native storage created_at=12:17:29, after 12:15 close.
    // The DB as-of loader must refuse it, producing no eligible M5 snapshot.
    expect(check({...input,lastCompletedM5:null}).reason).toBe('NO_AS_OF_M1_OR_M5');
  });
  it('rejects M5 opposite or weak trend',()=>{
    expect(check({...input,lastCompletedM5:{...m5,open:159.044,close:159.095}}).reason).toBe('M5_OPPOSES_TRADE');
  });
  it('rejects two-minute profit panic if latest M1 actually reverses materially',()=>{
    expect(check({...input,lastTwoCompletedM1:[m1[0],{...m1[1],open:159.033,close:159.047}]}).reason).toBe('M1_REVERSAL_OR_WEAK_STRUCTURE');
  });
  it('rejects incomplete, post-decision or stale candles without look-ahead',()=>{
    expect(check({...input,lastTwoCompletedM1:[m1[0],{...m1[1],startedAt:new Date('2026-11-23T12:15:00Z')}]}).reason)
      .toBe('CANDLE_NOT_BROKER_NATIVE_OR_FRESH');
    expect(check({...input,lastCompletedM5:{...m5,startedAt:new Date('2026-11-23T12:15:00Z')}}).reason)
      .toBe('CANDLE_NOT_BROKER_NATIVE_OR_FRESH');
  });
  it('rejects nonconsecutive M1 bars, zero source quotes and adverse M1 structure',()=>{
    expect(check({...input,lastTwoCompletedM1:[{...m1[0],startedAt:new Date('2026-11-23T12:12:00Z')},m1[1]]}).reason)
      .toBe('CANDLE_NOT_BROKER_NATIVE_OR_FRESH');
    expect(check({...input,lastTwoCompletedM1:[{...m1[0],brokerNativeSampleCount:0},m1[1]]}).reason)
      .toBe('CANDLE_NOT_BROKER_NATIVE_OR_FRESH');
  });
  it('rejects missing cost, large giveback, nonpositive or very young profit',()=>{
    expect(check({...input,conservativeEstimatedCosts:null}).reason).toBe('NOT_MATURE_PROFIT');
    expect(check({...input,grossCurrentPnl:65}).reason).toBe('TOO_MUCH_GIVEBACK');
    expect(check({...input,grossCurrentPnl:40}).reason).toBe('NOT_MATURE_PROFIT');
    expect(check({...input,openedAt:new Date('2026-11-23T12:14:30Z')}).reason).toBe('NOT_MATURE_PROFIT');
  });
  it('never applies to LIVE or unrelated brokers',()=>{
    expect(check({...input,accountType:'LIVE'}).reason).toBe('UNVERIFIED_SCOPE');
    expect(check({...input,brokerId:'another-broker'}).reason).toBe('UNVERIFIED_SCOPE');
  });
});

describe('mutable broker candle persistence must never create look-ahead',()=>{
  it('as-of loader explicitly excludes quote bars created or updated after decision',()=>{
    const fs=require('fs');
    const source=fs.readFileSync(require('path').join(__dirname,'live-demo-profit-protection.service.ts'),'utf8');
    expect(source).toContain('AND created_at <= $4::timestamptz');
    expect(source).toContain('AND updated_at <= $4::timestamptz');
    expect(source).toContain('AND last_sample_at <= $4::timestamptz');
    expect(source).toContain('WHERE connection_id=$1');
  });
});
