import {evaluateBrokerTighterProfitStopPreservation as assess}
  from './broker-tighter-profit-stop-preservation';

const base={
  guardEnabled:true,ownerUserId:'owner',userId:'owner',
  brokerId:'pepperstone-ctrader',accountType:'DEMO',
  accountCurrency:'USD',tradeCurrency:'USD',
  direction:'BUY',instrument:'EURUSD',
  brokerDirection:'BUY',brokerInstrument:'EURUSD',
  tradeLots:'0.10',brokerLots:'0.10',
  entry:'1.10000',mark:'1.10220',
  databaseStop:'1.09800',databaseTakeProfit:'1.10400',
  brokerStop:'1.10120',brokerTakeProfit:'1.10400',
};

describe('owner DEMO stronger broker profit-stop reconciliation guard',()=>{
  it('preserves a verified BUY profit stop without placing or changing an order',()=>{
    expect(assess(base)).toEqual({
      preserveMoreProtectiveBrokerStop:true,
      reason:'MORE_PROTECTIVE_PROFIT_STOP_PENDING_AUTHORITY_SYNC',
      noOrderAction:true,needsAuthoritativeReconciliation:true,
    });
  });
  it('preserves a SELL protected-profit stop only on valid geometry',()=>{
    expect(assess({...base,direction:'SELL',instrument:'USDJPY',
      brokerDirection:'SELL',brokerInstrument:'USDJPY',
      entry:'159.600',mark:'159.510',databaseStop:'159.650',
      databaseTakeProfit:'159.400',brokerStop:'159.540',
      brokerTakeProfit:'159.400',
    }).preserveMoreProtectiveBrokerStop).toBe(true);
  });
  it.each([
    {guardEnabled:false},{ownerUserId:null},{ownerUserId:'other'},
    {brokerId:'ctrader'},{brokerId:'icmarkets-ctrader'},
    {accountType:'LIVE'},{accountCurrency:'EUR'},{tradeCurrency:'EUR'},
    {instrument:'XAUUSD'},{instrument:'EURJPY'},
    {brokerInstrument:'GBPUSD'},{brokerDirection:'SELL'},
    {brokerLots:'0.11'},{tradeLots:'0'},
    {direction:'HOLD'},{entry:null},{mark:null},{brokerStop:null},
    {brokerTakeProfit:'1.10300'},{databaseTakeProfit:null},
    {brokerStop:'1.09900'},{brokerStop:'1.09800'},
    {brokerStop:'1.10219'},{brokerStop:'1.10500'},
    {mark:'1.10050',brokerStop:'1.10120'},
    {databaseStop:'1.10140'},
    {databaseTakeProfit:'1.09800'},
  ])('refuses to mask legitimate protections with invalid proof: %j',patch=>{
    const result=assess({...base,...patch});
    expect(result.preserveMoreProtectiveBrokerStop).toBe(false);
    expect(result.noOrderAction).toBe(true);
  });
  it('does not preserve a weaker or past-mark SELL stop',()=>{
    const sell={...base,direction:'SELL',brokerDirection:'SELL',entry:'1.10000',
      mark:'1.09800',databaseStop:'1.10200',
      databaseTakeProfit:'1.09600',brokerTakeProfit:'1.09600'};
    expect(assess({...sell,brokerStop:'1.10250'}).preserveMoreProtectiveBrokerStop)
      .toBe(false);
    expect(assess({...sell,brokerStop:'1.09799'}).preserveMoreProtectiveBrokerStop)
      .toBe(false);
  });
});
