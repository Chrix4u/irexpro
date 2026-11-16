'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const{SQL,normalize,aggregate,study}=require('./audit-pepperstone-directional-consensus.cjs');
const input=overrides=>({
 id:'t1',instrument:'USDJPY',direction:'SELL',
 opened_at:'2026-11-13T10:03:00Z',closed_at:'2026-11-13T10:08:00Z',
 intent_at:'2026-11-13T10:02:00Z',decision_at:'2026-11-13T10:01:00Z',
 signal_side:'SELL',intent_side:'SELL',m1_side:'SELL',order_side:'SELL',
 route:'TREND_CONTINUATION',m1_route:'M1_TREND_CONTINUATION',
 realised_pnl:'50',commission:'-6',swap:'0',
 planb_quality:'0.56',selected_m1_quality:'0.61',selected_m1_score:'0.77',
 other_side:'BUY',other_at:'2026-11-13T10:01:05Z',other_m1_score:'0.62',
 ...overrides,
});
test('full provenance preserves a valid sell and actual fee-inclusive outcome',()=>{
 const r=normalize(input());
 assert.equal(r.direction,undefined);
 assert.equal(r.side,'SELL');
 assert.equal(r.realizedNetUsd,44);
 assert.equal(r.oppositeAvailableAsOfIntent,true);
 assert.ok(r.oppositeScoreMargin>0);
});
test('wrong order side is not counted as a trading win or loss',()=>{
 assert.throws(()=>normalize(input({order_side:'BUY'})),/DIRECTION_INVERSION_DETECTED/);
});
test('invalid signal identity is rejected before any study',()=>{
 assert.throws(()=>normalize(input({signal_side:null})),/UNVERIFIED_TRADE_PROVENANCE/);
});
test('opposite scorer computed after the trade intent cannot be used as if known before entry',()=>{
 const r=normalize(input({other_at:'2026-11-13T10:02:15Z',
  other_m1_score:'0.99'}));
 assert.equal(r.oppositeWasRecorded,true);
 assert.equal(r.oppositeAvailableAsOfIntent,false);
 assert.equal(r.oppositeScoreMargin,null);
});
test('missing commission cannot become a zero-cost profitable trade',()=>{
 const r=normalize(input({commission:null}));
 assert.equal(r.realizedNetUsd,null);
 assert.equal(aggregate([r]).unpriced,1);
 assert.equal(aggregate([r]).netUsd,null);
});
test('aggregate reports actual net and profit factor correctly',()=>{
 const one=normalize(input()),two=normalize(input({
  id:'t2',opened_at:'2026-11-16T10:03:00Z',
  closed_at:'2026-11-16T10:08:00Z',
  intent_at:'2026-11-16T10:02:00Z',
  decision_at:'2026-11-16T10:01:00Z',
  other_at:'2026-11-16T10:01:05Z',
  realised_pnl:'-80',commission:'-6',
  planb_quality:'0.45',selected_m1_quality:'0.49',
 }));
 const r=study([one,two]);
 assert.equal(r.total.trades,2);
 assert.equal(r.total.netUsd,-42);
 assert.equal(r.total.profitFactor,+(44/86).toFixed(3));
 assert.equal(r.scenarios.PLANB_055.included.netUsd,44);
 assert.equal(r.scenarios.PLANB_055.excluded.netUsd,-86);
 assert.equal(r.pairedOpposite.availableAtIntent,2);
 assert.equal(r.byDay['2026-11-13'].netUsd,44);
});
test('a loser with a stronger score remains a loss, not a guaranteed winner',()=>{
 const one=normalize(input({realised_pnl:'-120',commission:'-6',
  planb_quality:'0.90',selected_m1_quality:'0.92'}));
 assert.equal(study([one]).scenarios.PLANB_055.included.netUsd,-126);
});
test('read-only SQL restricts user, broker DEMO, USD, sample size and position status',()=>{
 assert.match(SQL,/t\.user_id=\$1/);
 assert.match(SQL,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(SQL,/b\.account_type='DEMO'/);
 assert.match(SQL,/t\.account_currency=\$2/);
 assert.match(SQL,/t\.status='CLOSED'/);
 assert.match(SQL,/LIMIT 2001/);
 assert.doesNotMatch(SQL,/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
});
