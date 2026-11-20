'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SQL,touch,pathSegment,classify,aggregate}=require('./audit-owner-demo-20261120-0430-tp-first.cjs');
const start=Date.parse('2026-11-20T06:00:00Z');
const iso=at=>new Date(at).toISOString();
const quote=(at,bid,ask)=>({source:start+at*1000,captured:start+at*1000+300,instrument:'EURUSD',bid,ask});
const trade=(extra={})=>({
 trade_id:'t-1',opened_at:iso(start),closed_at:iso(start+120000),
 status:'CLOSED',instrument:'EURUSD',direction:'BUY',lot_size:'2',
 fill_price:'1.1000',exit_price:'1.1003',
 close_reason:'PROFIT_PROTECTION',realised_pnl:'60',commission:'-10',swap:'0',
 original_stop:'1.0990',original_target:'1.1010',
 last_recorded_stop:'1.0992',last_recorded_target:'1.1009',
 route:'CONFIRMED_REVERSAL',...extra});
test('read-only owner scoped USD DEMO query retains intent and modified barrier pairs',()=>{
 for(const part of ['t.user_id=$1','b.user_id=$1',
  "b.broker_id='pepperstone-ctrader'","b.account_type='DEMO'",
  "b.account_currency='USD'","t.account_currency='USD'",
  'ti.stop_loss AS original_stop','ti.take_profit AS original_target',
  't.stop_loss AS last_recorded_stop','t.take_profit AS last_recorded_target',
  't.opened_at>=$2::timestamptz','t.opened_at<=$3::timestamptz'
 ])assert.ok(SQL.includes(part),part);
 assert.equal(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(SQL),false);
});
test('BUY uses BID, SELL uses ASK for target and stop, not the favorable half spread',()=>{
 const q=quote(1,1.10095,1.10105);
 assert.deepEqual(touch(q,trade(),1.101,1.099),
  {tp:false,sl:false,closeSide:1.10095});
 const s=trade({direction:'SELL',original_target:'1.099',original_stop:'1.101'});
 const qq=quote(2,1.09895,1.09903);
 assert.equal(touch(qq,s,1.099,1.101).tp,false);
 assert.equal(touch(quote(3,1.09891,1.09899),s,1.099,1.101).tp,true);
});
test('first observed TP before SL is an observed path, never an actual broker fill',()=>{
 const q=[quote(1,1.1001,1.1002),quote(6,1.1011,1.1012),
  quote(11,1.0990,1.0991),quote(15,1.0991,1.0992)];
 const r=pathSegment(trade(),q,start,start+15000,1.099,1.101);
 assert.equal(r.pathCoverage,'CONTIGUOUS_SAMPLED_PATH');
 assert.equal(r.firstTouch,'TP_FIRST_SAMPLED');
 assert.equal(r.firstTargetAt,iso(start+6000));
 assert.equal(r.firstStopAt,iso(start+11000));
 assert.equal(r.firstTouchProvesExecution,false);
});
test('first observed SL before TP remains SL even if price eventually reaches target',()=>{
 const q=[quote(1,1.100,1.1001),quote(6,1.0989,1.099),
  quote(11,1.1011,1.1012),quote(15,1.1012,1.1013)];
 const r=pathSegment(trade(),q,start,start+15000,1.099,1.101);
 assert.equal(r.firstTouch,'SL_FIRST_SAMPLED');
 assert.equal(r.firstStopAt,iso(start+6000));
 assert.equal(r.firstTargetAt,iso(start+11000));
});
test('missing quote coverage is never counted as a provable target-first outcome',()=>{
 const q=[quote(1,1.1001,1.1002),quote(81,1.1011,1.1012),
  quote(85,1.1001,1.1002)];
 const r=pathSegment(trade(),q,start,start+90000,1.099,1.101);
 assert.equal(r.firstTouch,'TP_FIRST_SAMPLED');
 assert.equal(r.pathCoverage,'INCOMPLETE_SAMPLED_PATH');
 assert.equal(r.maxGapSeconds,80);
});
test('original stop and later recorded modified stop can give different first-hit results',()=>{
 const t=trade({closed_at:iso(start+10000),original_stop:'1.0990',
  last_recorded_stop:'1.0996',original_target:'1.1010',
  last_recorded_target:'1.1012'});
 const q=[quote(1,1.1002,1.1003),quote(6,1.1005,1.1006),
  quote(11,1.1001,1.1002),quote(16,1.0995,1.0996),
  quote(21,1.1011,1.1012),quote(26,1.1013,1.1014)];
 const result=classify(t,q,start+30000);
 assert.equal(result.afterCloseOriginalBarriers.firstTouch,'TP_FIRST_SAMPLED');
 assert.equal(result.afterCloseLastRecordedBarriers.firstTouch,'SL_FIRST_SAMPLED');
 assert.equal(result.netUsdSettled,50);
 assert.equal(result.cannotProveHypotheticalFill,true);
});
test('aggregate counts verified TP/SL path separately from incomplete and excludes unsettled',()=>{
 const base=trade({closed_at:iso(start+10000)});
 const first=classify(base,[quote(1,1.1001,1.1002),quote(6,1.1002,1.1003),
   quote(11,1.1004,1.1005),quote(16,1.1011,1.1012),
   quote(21,1.1008,1.1009)],start+25000);
 const second=classify(trade({trade_id:'second'}),[
  quote(1,1.1001,1.1002),quote(30,1.1001,1.1002),
  quote(119,1.1002,1.1003),quote(123,1.0991,1.0992),
 ],start+130000);
 const open=classify(trade({trade_id:'open',status:'OPEN',closed_at:null,
  realised_pnl:null,commission:null,swap:null}),[
  quote(1,1.1002,1.1003),quote(6,1.1002,1.1003)
 ],start+8000);
 const r=aggregate([first,second,open],start+130000);
 assert.equal(r.positions,3);assert.equal(r.closed,2);
 assert.equal(r.profitProtection.count,2);
 assert.equal(r.profitProtection.firstTpAfterClose,1);
 assert.equal(r.profitProtection.incompletePostClosePath,1);
 assert.equal(r.brokerOrders,false);assert.equal(r.noSqlWrites,true);
});
