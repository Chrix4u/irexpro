import { evaluatePepperstoneDemoAdvisoryQuality as check } from './pepperstone-demo-advisory-quality-risk';

const at = new Date('2026-11-17T09:40:00Z');
const bars = (minutes: number, steps: number[]) =>
  steps.map((v, i) => ({
    timestamp: new Date(at.getTime() - (steps.length - i) * minutes * 60_000),
    close: String(1.1000 + v),
  }));
const qualified = {
  route:'CONFIRMED_REVERSAL',m1Route:'ABSTAIN',expertState:'ABSTAIN',
  expertDirection:'BUY',signalDirection:'BUY' as const,expertProbability:0.34,
  decisionTime:at,stopDistance:0.0005,
};

describe('owner DEMO continuous advisory quality-weighted exposure',()=>{
  it('halves size for independent M1 and expert ABSTAIN without blocking the entry',()=>{
    const d=check(qualified);
    expect(d.riskFraction).toBe(0.5);
    expect(d.rationale).toContain('DOUBLE_ABSTAIN_HALF_RISK');
  });
  it('uses only completed M5/H1 closes to reduce risk of contrary momentum',()=>{
    const d=check({...qualified,
      m5:bars(5,[0.0008,0.0004,0]),
      h1:bars(60,[0.001,0.0006,0]),
    });
    // H1 may not be complete for given time arrangement; never invent freshness.
    expect(d.m5Direction).toBe('AGAINST');
    expect(d.riskFraction).toBeLessThanOrEqual(0.5);
  });
  it('compounds after-fee historical caution on same route / pair / direction',()=>{
    const d=check({...qualified,recent:{samples:5,losing:4,winning:1,averageNetR:-0.62}});
    expect(d.riskFraction).toBe(0.35);
    expect(d.recentLossEvidenceUsed).toBe(true);
  });
  it('cautions on conflicting M1 continuation versus Plan-B reversal, without veto',()=>{
    const d=check({...qualified,m1Route:'M1_TREND_CONTINUATION'});
    expect(d.riskFraction).toBeCloseTo(0.75*0.65,4);
  });
  it('ignores fewer than 3 paid-fee completed position samples',()=>{
    expect(check({...qualified,recent:{samples:2,losing:2,winning:0,averageNetR:-1}}).riskFraction).toBe(0.5);
  });
  it('never increases original cap, changes non-alternate routes, or presumes opposition on missing context',()=>{
    const d=check({...qualified,route:'TREND_CONTINUATION'});
    expect(d.riskFraction).toBe(1);
    const missing=check({...qualified,m5:[],h1:[]});
    expect(missing.m5Direction).toBe('UNAVAILABLE');
    expect(missing.h1Direction).toBe('UNAVAILABLE');
    expect(missing.riskFraction).toBe(0.5);
  });
  it('ignores future and incomplete bars rather than using lookahead momentum',()=>{
    const future=[{timestamp:new Date(at.getTime()-4*60_000),close:'1.1002'},
      {timestamp:new Date(at.getTime()-60_000),close:'1.1001'},
      {timestamp:new Date(at.getTime()+60_000),close:'1.098'}];
    const d=check({...qualified,m5:future});
    expect(d.m5Direction).toBe('UNAVAILABLE');
  });
  it('preserves full size for both independently confirming models and positive reliable outcomes',()=>{
    const d=check({...qualified,m1Route:'M1_EARLY_TRANSITION',
      expertState:'CONFIRM',recent:{samples:5,losing:1,winning:4,averageNetR:0.6}});
    expect(d.riskFraction).toBe(1);
  });
});
