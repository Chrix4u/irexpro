import {
  evaluatePepperstoneLiveMicroRisk as check,
  pepperstoneLivePilotIsScoped,
  evaluatePepperstoneLivePortfolioBudget as portfolio,
  affordablePepperstoneLiveLots as downsize,
} from './pepperstone-live-micro-risk';

describe('Pepperstone LIVE broker-minimum–1.00 lots: account-scoped risk-sized execution', () => {
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
  it.each(['0.01', '0.02', '0.03', '0.05', '0.08'])('accepts a smaller broker-valid %s lot candidate when costs fit', lots => {
    expect(check({...base,lots,grossRiskAtStopUsd:'0.3'}).allowed).toBe(true);
  });
  it('rejects a below-broker-minimum lot size rather than rounding up', () => {
    expect(check({...base,lots:'0.005'}).code).toBe('LIVE_LOT_RANGE_LIMIT');
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

describe('LIVE multi-position portfolio admission: same-account evidence', () => {
  const base = {
    equityUsd: '50',
    proposedCostInclusiveRiskUsd: '0.40',
    existingCostInclusiveRisksUsd: ['0.45'],
    providerOpenPositions: 1,
    locallyProvenOpenPositions: 1,
    pendingOrUncertainOrders: false,
    maxOpenPositions: 3,
  };
  it('allows one additional small trade when BOTH total under the 2% budget', () => {
    expect(portfolio(base)).toEqual({
      allowed: true, reason: null, projectedTotalRiskUsd: '0.85', riskCapUsd: '1',
    });
  });
  it('refuses combined stops above the account budget', () => {
    expect(portfolio({...base,proposedCostInclusiveRiskUsd:'0.60'}).reason)
      .toBe('LIVE_PORTFOLIO_STOP_RISK_LIMIT');
  });
  it('allows a third only if the owner risk profile permits three AND total stop risk fits', () => {
    expect(portfolio({...base,providerOpenPositions:2,locallyProvenOpenPositions:2,
      existingCostInclusiveRisksUsd:['0.1','0.1']}).allowed).toBe(true);
  });
  it('respects the configured max_open_trades instead of a separate hardcoded two', () => {
    expect(portfolio({...base,providerOpenPositions:2,locallyProvenOpenPositions:2,
      maxOpenPositions:2,existingCostInclusiveRisksUsd:['0.1','0.1']}).reason)
      .toBe('LIVE_POSITION_LIMIT');
  });
  it('rejects untracked manual positions or provider/ledger mismatch', () => {
    expect(portfolio({...base,providerOpenPositions:2}).reason)
      .toBe('LIVE_POSITION_COUNT_UNPROVABLE');
  });
  it('blocks pending or uncertain execution rather than double submitting', () => {
    expect(portfolio({...base,pendingOrUncertainOrders:true}).reason)
      .toBe('LIVE_POSITION_COUNT_UNPROVABLE');
  });
  it('does not invent a previous position risk that was never persisted', () => {
    expect(()=>portfolio({...base,existingCostInclusiveRisksUsd:[]})).toThrow();
    expect(()=>portfolio({...base,existingCostInclusiveRisksUsd:['-0.5']})).toThrow();
  });
});

describe('LIVE broker-step auto-downsizing before broker order', () => {
  const base = {
    equityUsd: '50', proposedLots: '0.10', brokerLotStep: '0.01', stopRiskPerLotUsd: '25',
  };
  it('scales 0.10 DOWN to 0.02 when $50 supports 0.02 after costs', () => {
    expect(downsize(base)).toBe('0.02');
  });
  it('scales to 0.01 with a wider valid stop instead of refusing merely below 0.10', () => {
    expect(downsize({...base,stopRiskPerLotUsd:'55'})).toBe('0.01');
  });
  it('returns zero rather than round UP when even 0.01 is unaffordable', () => {
    expect(downsize({...base,stopRiskPerLotUsd:'120'})).toBe('0');
  });
  it('never raises a model 0.01 request and respects 0.001 broker steps', () => {
    expect(downsize({...base,proposedLots:'0.01'})).toBe('0.01');
    expect(downsize({...base,brokerLotStep:'0.001',stopRiskPerLotUsd:'55'})).toBe('0.01');
  });
  it('never exceeds 1.0 lot even for a huge equity and requested volume', () => {
    expect(downsize({...base,equityUsd:'1000000',proposedLots:'7'})).toBe('1');
  });
  it('refuses unproven equity, step, or model stop risk', () => {
    for(const item of [
      {...base,equityUsd:'0'},
      {...base,brokerLotStep:'0'},
      {...base,stopRiskPerLotUsd:'garbage'},
    ]) expect(()=>downsize(item)).toThrow();
  });
});
