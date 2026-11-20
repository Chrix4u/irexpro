'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {BEGIN,END,QUERY,summarize}=require('./audit-owner-pepperstone-demo-noon-lot-trial.cjs');
const row=(overrides={})=>({
 intent_id:'intent',created_at:'2026-11-20T04:06:08Z',instrument:'AUDUSD',
 direction:'SELL',requested_lot_size:'4.20',requested_screen_cap:'4.2',
 trial_expires_at:END,pre_screen_risk_percent:'0.75',
 strategy_route:'CONFIRMED_REVERSAL',trade_id:'filled',
 opened_at:'2026-11-20T04:06:13Z',closed_at:null,
 trade_status:'OPEN',filled_lots:'3.44',realised_pnl:null,
 commission:null,swap:null,risk_at_stop:'172',actual_risk_percent:'0.5',
 ...overrides
});
test('only the precise owner DEMO and source-artifact intents can be read',()=>{
 for(const fragment of [
  'ti.user_id=$1','b.user_id=$1','ti.broker_connection_id=$2',
  "b.broker_id='pepperstone-ctrader'","b.account_type='DEMO'",
  "b.account_currency='USD'",'ti.created_at<$5::timestamptz',
  'ti.created_at>=$4::timestamptz',"ti.metadata->>'m1_owner_demo_noon_lot_trial_artifact'=$3"
 ])assert.ok(QUERY.includes(fragment),fragment);
});
test('separates requested 4.20 from actual 3.44 fill, no invented open P&L',()=>{
 const r=summarize([row()],new Date('2026-11-20T04:10:00Z'));
 assert.equal(r.phase,'ACTIVE');
 assert.equal(r.requestedFourLotsOrMore,1);
 assert.equal(r.filledFourLotsOrMore,0);
 assert.equal(r.filledBelowFourLots,1);
 assert.equal(r.settled,0);assert.equal(r.brokerNetUsdSettled,0);
 assert.equal(r.latest[0].requestedLots,4.2);
 assert.equal(r.latest[0].filledLots,3.44);
 assert.equal(r.latest[0].closedNetUsd,null);
 assert.equal(r.noLiveTradingAuthority,true);
 assert.equal(r.modifiesOrders,false);
});
test('broker settlement counts net after commission and swap, excludes pending',()=>{
 const rows=[
  row({closed_at:'2026-11-20T04:10:00Z',trade_status:'CLOSED',filled_lots:'4.05',
   realised_pnl:'65',commission:'-24',swap:'-1'}),
  row({intent_id:'second',trade_id:'second-trade',created_at:'2026-11-20T04:11:00Z',
   trade_status:'RECONCILIATION_PENDING',realised_pnl:'9999',
   commission:null,swap:null}),
  row({intent_id:'third',trade_id:null,created_at:'2026-11-20T04:12:00Z',
   filled_lots:null,opened_at:null}),
 ];
 const r=summarize(rows,new Date('2026-11-20T04:15:00Z'));
 assert.equal(r.signals,3);assert.equal(r.filled,2);
 assert.equal(r.filledFourLotsOrMore,1);
 assert.equal(r.unfilled,1);assert.equal(r.unreconciled,1);
 assert.equal(r.settled,1);assert.equal(r.settledWins,1);
 assert.equal(r.brokerNetUsdSettled,40);
 assert.equal(r.commissionUsdSettled,-24);
});
test('after exactly noon report expires, no new high-lot proposals permitted by API',()=>{
 const r=summarize([],new Date(END));
 assert.equal(r.phase,'EXPIRED_AUTOMATICALLY');
 assert.equal(r.signals,0);assert.equal(r.filledFourLotsOrMore,0);
 assert.equal(summarize([],new Date(BEGIN)).phase,'ACTIVE');
});
test('economic decomposition uses actual filled lots, signed fees and settled outcomes only',()=>{
 const records=[
  row({trade_status:'CLOSED',closed_at:'2026-11-20T04:10:00Z',
   filled_lots:'4.05',realised_pnl:'65',commission:'-24',swap:'-1'}),
  row({intent_id:'loss-intent',trade_id:'loss-trade',created_at:'2026-11-20T04:12:00Z',
   instrument:'USDJPY',strategy_route:'EARLY_TRANSITION',filled_lots:'3.44',
   trade_status:'CLOSED',closed_at:'2026-11-20T04:17:00Z',
   realised_pnl:'-80',commission:'-20',swap:'0'}),
  row({intent_id:'open-intent',trade_id:'open-trade',created_at:'2026-11-20T04:20:00Z',
   filled_lots:'6',trade_status:'OPEN',realised_pnl:'100000',commission:'-10',swap:'0'}),
 ];
 const s=summarize(records,new Date('2026-11-20T04:23:00Z'));
 assert.equal(s.economics.settled,2);
 assert.equal(s.economics.wins,1);assert.equal(s.economics.losses,1);
 assert.equal(s.economics.netUsd,-60);
 assert.equal(s.economics.grossBrokerPnlUsd,-15);
 assert.equal(s.economics.commissionUsd,-44);
 assert.equal(s.economics.swapUsd,-1);
 assert.equal(s.economics.profitFactor,0.4);
 assert.equal(s.economics.averageWinnerUsd,40);
 assert.equal(s.economics.averageLoserUsd,-100);
 assert.equal(s.economics.breakEvenWinRateAtObservedPayoffs,0.7143);
 assert.equal(s.economics.settledLotTotal,7.49);
 assert.equal(s.economics.netUsdPerSettledLot,-8.01);
 assert.equal(s.byLotBucket.ACTUAL_FOUR_PLUS.netUsd,40);
 assert.equal(s.byLotBucket.ACTUAL_BELOW_FOUR.netUsd,-100);
 assert.equal(s.byStrategyInstrument['CONFIRMED_REVERSAL|AUDUSD'].netUsd,40);
 assert.equal(s.byStrategyInstrument['EARLY_TRANSITION|USDJPY'].netUsd,-100);
 assert.equal(s.byInstrument.USDJPY.economics.losses,1);
 assert.equal(s.noLiveTradingAuthority,true);assert.equal(s.modifiesOrders,false);
});
test('all-open and all-winning cohorts do not invent break-even or profit factor',()=>{
 const empty=summarize([row()],new Date('2026-11-20T05:00:00Z'));
 assert.equal(empty.economics.settled,0);
 assert.equal(empty.economics.profitFactor,null);
 assert.equal(empty.economics.breakEvenWinRateAtObservedPayoffs,null);
 const win=summarize([row({trade_status:'CLOSED',closed_at:'2026-11-20T04:18:00Z',
   realised_pnl:'20',commission:'-4',swap:'0'})],new Date('2026-11-20T05:00:00Z'));
 assert.equal(win.economics.profitFactor,null);
 assert.equal(win.economics.breakEvenWinRateAtObservedPayoffs,null);
 assert.equal(win.economics.winRate,1);
});
test('rejects a supposed trial signal outside the exact authorized window',()=>{
 assert.throws(()=>summarize([
  row({created_at:'2026-11-20T12:00:00Z'}),
 ],new Date('2026-11-20T12:00:01Z')), /OUTSIDE_TRIAL_WINDOW/);
});
