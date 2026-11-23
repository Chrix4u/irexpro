import {
  evaluatePepperstoneLiveMicroRisk as check,
  pepperstoneLivePilotIsScoped,
} from './pepperstone-live-micro-risk';

describe('Pepperstone LIVE 0.01–1.00 lots: account-scoped risk-sized execution', () => {
  const base = {equityUsd:'1000',lots:'0.1',brokerMinimumLots:'0.01',grossRiskAtStopUsd:'5'};
  it('applies only to exact Pepperstone USD LIVE, never DEMO', () => {
    expect(pepperstoneLivePilotIsScoped({brokerId:'pepperstone-ctrader',accountType:'LIVE',accountCurrency:'USD'})).toBe(true);
    for(const [brokerId,accountType,accountCurrency] of [
      ['pepperstone-ctrader','DEMO','USD'],['ctrader','LIVE','USD'],['pepperstone-ctrader','LIVE','EUR'],
    ]) expect(pepperstoneLivePilotIsScoped({brokerId,accountType,accountCurrency})).toBe(false);
  });
  it('permits 0.10 lots when account equity and costs fit 2% risk', () => {
    expect(check(base)).toEqual({allowed:true,code:null,projectedCostInclusiveRiskUsd:'7',maximumRiskUsd:'20'});
  });
  it('permits up to 1 lot ONLY with enough equity and stop-loss budget', () => {
    expect(check({...base,equityUsd:'5000',lots:'1',grossRiskAtStopUsd:'50'})).toEqual({
      allowed:true,code:null,projectedCostInclusiveRiskUsd:'68.2',maximumRiskUsd:'100',
    });
  });
  it('rejects DEMO-sized 4 or 7 lot leakage on LIVE', () => {
    expect(check({...base,lots:'4'}).code).toBe('LIVE_LOT_RANGE_LIMIT');
    expect(check({...base,lots:'7'}).code).toBe('LIVE_LOT_RANGE_LIMIT');
  });
  it('permits 0.01, 0.02, 0.05 for $50 only when their own stop and costs fit', () => {
    expect(check({...base,equityUsd:'50',lots:'0.01',grossRiskAtStopUsd:'0.3'}).allowed).toBe(true);
    expect(check({...base,equityUsd:'50',lots:'0.02',grossRiskAtStopUsd:'0.3'}).allowed).toBe(true);
    expect(check({...base,equityUsd:'50',lots:'0.05',grossRiskAtStopUsd:'0.3'}).allowed).toBe(true);
  });
  it('does not force a risk-sized sub-minimum volume UP to 0.01', () => {
    expect(check({...base,lots:'0.005',grossRiskAtStopUsd:'0.1'}).code).toBe('LIVE_LOT_RANGE_LIMIT');
  });
  it('fails closed on broker minimum > 1 lot rather than overriding broker rules', () => {
    expect(check({...base,brokerMinimumLots:'2'}).code).toBe('LIVE_LOT_BROKER_MIN_TOO_LARGE');
  });
  it('rejects a 0.1 lot trade on the existing $50 equity with a 5-pip stop', () => {
    expect(check({...base,equityUsd:'50'}).code).toBe('LIVE_COST_INCLUSIVE_RISK_LIMIT');
    expect(check({...base,equityUsd:'50'}).maximumRiskUsd).toBe('1');
  });
  it('scales risk budget up with equity instead of permanently capping at $1', () => {
    expect(check({...base,equityUsd:'1000'}).maximumRiskUsd).toBe('20');
    expect(check({...base,equityUsd:'5000'}).maximumRiskUsd).toBe('100');
  });
  it('includes volume-scaled cost reserve, not the same $0.20 for one lot', () => {
    const one=check({...base,equityUsd:'5000',lots:'1',grossRiskAtStopUsd:'50'});
    expect(one.projectedCostInclusiveRiskUsd).toBe('68.2');
  });
  it('requires actual positive verified stop distance and equity', () => {
    for (const grossRiskAtStopUsd of ['0','-1','bad']) {
      expect(()=>check({...base,grossRiskAtStopUsd})).toThrow();
    }
    expect(()=>check({...base,equityUsd:'0'})).toThrow();
  });
});
