'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QUERY,analyze,run}=require('./audit-owner-demo-route-brake-diagnostics.cjs');
const at=new Date('2026-11-18T22:00:00Z');
const row=(changes={})=>({
 evaluated_at:'2026-11-18T20:59:00Z',instrument:'USDJPY',direction:'SELL',
 strategy:'CONFIRMED_REVERSAL',
 blockers:['M1_MULTIMODEL_LOSS_STREAK_BRAKE'],
 brake:{active:true,reason:'PERSISTENT_NEGATIVE_PAYOFF',
  payoffClosedTrades:8,cumulativeRealisedPnl:31.13,profitFactor:.4895,
  persistentNegativePayoff:true,recentLosses:0,recentWins:2,
  latestClosedAt:'2026-11-18T14:22:47Z',cooldownRemainingSeconds:19428},
 ...changes,
});
test('read-only query is owner-scoped to Pepperstone DEMO USD',()=>{
 assert.match(QUERY,/d\.user_id=\$1 AND b\.user_id=\$1/);
 assert.match(QUERY,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(QUERY,/b\.account_type='DEMO'/);
 assert.match(QUERY,/b\.account_currency='USD'/);
 assert.doesNotMatch(QUERY,/\b(?:UPDATE|DELETE|INSERT)\b/i);
});
test('persistent negative payoff is distinguished from ordinary cooldown',()=>{
 const s=analyze([row(),row({evaluated_at:'2026-11-18T19:59:00Z'})],at);
 assert.equal(s.blockedModelDecisions,2);
 assert.equal(s.brakes.length,1);
 assert.equal(s.brakes[0].reason,'PERSISTENT_NEGATIVE_PAYOFF');
 assert.equal(s.brakes[0].reportedCooldownRemainingSeconds,19428);
 assert.equal(s.brakes[0].persistentNegativePayoff,true);
 assert.equal(s.modifiesExecution,false);
});
test('non-braked and unrelated research rows are not counted',()=>{
 const s=analyze([row({brake:{active:false}}),
  row({blockers:['DRIFT_OUT_OF_DISTRIBUTION']})],at);
 assert.equal(s.blockedModelDecisions,0);
 assert.equal(s.distinctBlockedPairSideRoutes,0);
});
test('different direction or instrument is not merged into a single global brake',()=>{
 const s=analyze([row(),
  row({instrument:'EURUSD',direction:'BUY',brake:{
    ...row().brake,reason:'RECENT_MULTIMODEL_LOSS_STREAK'}})],at);
 assert.equal(s.distinctBlockedPairSideRoutes,2);
 assert(s.brakes.some(x=>x.instrument==='EURUSD'&&x.direction==='BUY'));
});
test('repeatable-read transaction never writes, and no broker action',async()=>{
 const calls=[];
 const fake={query:async(q,params)=>{
  calls.push(q);return {rows:q===QUERY?[row()]:[]};
 }};
 const s=await run(fake,'43b8eea6-7044-47de-8e07-2da96f2903e7',at);
 assert.equal(calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1),'COMMIT');
 assert.equal(s.brokerOrders,0);
 assert.equal(s.modifiesExecution,false);
});
