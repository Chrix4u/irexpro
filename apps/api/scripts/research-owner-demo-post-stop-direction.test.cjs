'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {classifyClosedStopTrade:classify,summarizeStopFollowups:summarize}=
  require('./research-owner-demo-post-stop-direction.cjs');

const closed={
  status:'CLOSED',account_currency:'USD',instrument:'EURUSD',
  direction:'BUY',strategy_route:'EARLY_TRANSITION',
  opened_at:'2026-11-17T08:00:00Z',closed_at:'2026-11-17T08:02:00Z',
  fill_price:'1.1000',stop_loss:'1.0990',exit_price:'1.09898',
  close_reason:'STOP_LOSS_HIT',lot_size:'1.5',
  realised_pnl:'-102.00',commission:'-9.00',swap:'0',
  initial_risk:'100.00',max_favorable_pnl:'24.00',
};
const mark=(bid,ask)=>({bid,ask,closedAtMs:Date.parse('2026-11-17T08:08:00Z')});
test('genuine stop and later favorable entry reclaim is price evidence, not a wider-stop proof',()=>{
  const r=classify(closed,{1:mark(1.0988,1.0990),
    3:mark(1.09945,1.09965),5:mark(1.1002,1.1004)});
  assert.equal(r.state,'STOP_THEN_ENTRY_RECLAIMED');
  assert.equal(r.confirmedStop,true);
  assert.equal(r.netAfterCommissionAndSwap,-111);
  assert.equal(r.peakRiskUnits,.24);
  assert.equal(r.profitThenNetLoss,true);
  assert.ok(r.postExitPricesInRiskUnits['5m'].fromOriginalFillR>.1);
  assert.equal(r.provenance.changesExecution,false);
});
test('quote bouncing from exit but not reclaiming the original entry is partial only',()=>{
  const r=classify(closed,{1:mark(1.09905,1.09910),5:mark(1.09925,1.0993)});
  assert.equal(r.state,'STOP_THEN_PARTIAL_BOUNCE');
  assert.ok(r.postExitPricesInRiskUnits['5m'].fromOriginalFillR<0);
});
test('no followup quotes is NOT an assumption of a wrong prediction',()=>{
  const r=classify(closed,{});
  assert.equal(r.state,'STOP_FOLLOWUP_MISSING');
  assert.equal(r.observedHorizonCount,0);
});
test('a broker-close near SL must not be called a broker-confirmed stop',()=>{
  const r=classify({...closed,close_reason:'BROKER_CLOSE'},{
    5:mark(1.1004,1.1006),
  });
  assert.equal(r.state,'BROKER_CLOSE_NEAR_STOP_UNCONFIRMED');
  assert.equal(r.confirmedStop,false);
  assert.equal(r.potentialStop,true);
});
test('take profit, profit protection and manual exits are not false stop-losses',()=>{
  for(const [close_reason,state] of [
    ['TAKE_PROFIT_HIT','TAKE_PROFIT_CLOSE'],
    ['PROFIT_PROTECTION','PROFIT_PROTECTION_CLOSE'],
    ['MANUAL_CLOSE','OTHER_BROKER_CLOSE'],
  ]){
    const r=classify({...closed,close_reason}, {5:mark(1.101,1.1012)});
    assert.equal(r.state,state);
    assert.equal(r.confirmedStop,false);
  }
});
test('SELL compares broker ask (not bid) and uses directionally signed R',()=>{
  const sell={...closed,direction:'SELL',fill_price:'1.1000',
    stop_loss:'1.1010',exit_price:'1.10102'};
  const r=classify(sell,{3:mark(1.0995,1.0998)});
  assert.equal(r.state,'STOP_THEN_ENTRY_RECLAIMED');
  assert.ok(r.postExitPricesInRiskUnits['3m'].fromOriginalFillR>=.1);
});
test('unsettled fees never count as zero or a confirmed net win',()=>{
  const r=classify({...closed,commission:null},{5:mark(1.1005,1.1007)});
  assert.equal(r.settled,false);
  assert.equal(r.netAfterCommissionAndSwap,null);
  assert.equal(r.profitThenNetLoss,false);
});
test('invalid stop side, missing fill or non-USD/OPEN positions are excluded',()=>{
  assert.equal(classify({...closed,status:'OPEN'},{}).state,'OUT_OF_SCOPE');
  assert.equal(classify({...closed,account_currency:'EUR'},{}).state,'OUT_OF_SCOPE');
  assert.equal(classify({...closed,stop_loss:'1.1008'},{}).state,'INCOMPLETE');
  assert.equal(classify({...closed,fill_price:null},{}).state,'INCOMPLETE');
});
test('missing bid or ask is never deemed a direction reclaim',()=>{
  const r=classify(closed,{1:mark('1.1005',null)});
  assert.equal(r.state,'STOP_FOLLOWUP_MISSING');
});
test('report groups outcomes by actual strategy route and does not count uncertain BROKER_CLOSE as SL',()=>{
  const rows=[
    classify(closed,{3:mark(1.1005,1.1007)}),
    classify({...closed,close_reason:'BROKER_CLOSE'},{5:mark(1.1002,1.1004)}),
    classify({...closed,strategy_route:'CONFIRMED_REVERSAL',
      max_favorable_pnl:'0'},{3:mark(1.0980,1.0982)}),
  ];
  const g=summarize(rows);
  assert.equal(g.evaluatedClosedTrades,3);
  assert.equal(g.byStrategyRoute.EARLY_TRANSITION.confirmedStops,1);
  assert.equal(g.byStrategyRoute.EARLY_TRANSITION.unconfirmedBrokerCloseNearStop,1);
  assert.equal(g.byStrategyRoute.EARLY_TRANSITION.stopWithPriceReclaim,1);
  assert.equal(g.byStrategyRoute.CONFIRMED_REVERSAL.stopWithoutObservedRecovery,1);
  assert.equal(g.modifiesExecution,false);
});
