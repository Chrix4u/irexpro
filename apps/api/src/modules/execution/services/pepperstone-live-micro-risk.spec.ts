import {
  evaluatePepperstoneLiveMicroRisk as check,
  pepperstoneLivePilotIsScoped,
} from './pepperstone-live-micro-risk';

describe('Pepperstone LIVE 50 USD micro risk preparation only', () => {
  const base = { equityUsd:'50', lots:'0.01', brokerMinimumLots:'0.01', grossRiskAtStopUsd:'0.50' };
  it('scopes ONLY exact Pepperstone USD LIVE identity, never DEMO', () => {
    expect(pepperstoneLivePilotIsScoped({brokerId:'pepperstone-ctrader',accountType:'LIVE',accountCurrency:'USD'})).toBe(true);
    for(const [brokerId,accountType,accountCurrency] of [
      ['pepperstone-ctrader','DEMO','USD'],['ctrader','LIVE','USD'],['pepperstone-ctrader','LIVE','EUR'],
    ]) expect(pepperstoneLivePilotIsScoped({brokerId,accountType,accountCurrency})).toBe(false);
  });
  it('accepts proven 0.01 lots with conservative costs inside 2%-up-to-$1', () => {
    expect(check(base)).toEqual({allowed:true,code:null,projectedCostInclusiveRiskUsd:'0.8',maximumRiskUsd:'1'});
  });
  it('rejects direct copy of large DEMO lot size', () => {
    expect(check({...base,lots:'7'}).code).toBe('LIVE_MICRO_LOT_LIMIT');
  });
  it('fails closed rather than rounding UP broker minimum above 0.01', () => {
    expect(check({...base,brokerMinimumLots:'0.10'}).code).toBe('LIVE_MICRO_BROKER_MIN_TOO_LARGE');
  });
  it('rejects an oversized protective-stop distance including cost allowance', () => {
    expect(check({...base,grossRiskAtStopUsd:'0.75'}).code).toBe('LIVE_MICRO_COST_INCLUSIVE_RISK_LIMIT');
  });
  it('shrinks dollar risk with falling equity, never silently risks $1 on $20', () => {
    expect(check({...base,equityUsd:'20'}).code).toBe('LIVE_MICRO_COST_INCLUSIVE_RISK_LIMIT');
    expect(check({...base,equityUsd:'20',grossRiskAtStopUsd:'0.10'}).allowed).toBe(true);
  });
  it('caps $100+ equity at $1 until separate live pilot approval', () => {
    expect(check({...base,equityUsd:'1000'}).maximumRiskUsd).toBe('1');
  });
  it.each(['0','-1','not-a-number'])('fails closed with invalid stop evidence %s',grossRiskAtStopUsd => {
    expect(()=>check({...base,grossRiskAtStopUsd})).toThrow();
  });
});
