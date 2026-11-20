'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {END,QUERY,summarize}=require('./audit-owner-demo-noon-expiry-integrity.cjs');
const at='2026-11-20T12:15:00.000Z';
const make=(more={})=>({
 created_at:'2026-11-20T11:59:59.999Z',instrument:'USDJPY',
 direction:'BUY',requested_lot_size:'6',trial_artifact:'owner-pepperstone-demo-four-plus-until-20261120t1200z-v1',
 strategy_route:'CONFIRMED_REVERSAL',opened_at:'2026-11-20T11:59:59.999Z',
 filled_lots:'5.5',trade_status:'CLOSED',...more,
});
test('SQL is restricted to owner and exact Pepperstone USD DEMO connection, read-only',()=>{
 for(const v of ['ti.user_id=$1','ti.broker_connection_id=$2','b.user_id=$1',
   'b.account_type=$4','b.account_currency=$5','b.deleted_at IS NULL'])
  assert.ok(QUERY.includes(v),v);
 const r=summarize([],new Date(at));
 assert.equal(r.noOrders,true);assert.equal(r.noSqlWrites,true);assert.equal(r.readOnly,true);
 assert.equal(r.brokerDispatchVerified,false);
 assert.equal(r.phase,'EXPIRED_BY_SERVER_CLOCK');
});
test('pre-expiry intent and pre-expiry fill are NOT post-noon violations',()=>{
 const r=summarize([make()],new Date(at));
 assert.equal(r.beforeNoonIntents,1);
 assert.equal(r.afterNoonIntents,0);
 assert.equal(r.afterNoonFilledAboveFour,0);
 assert.equal(r.requiresExpiryInvestigation,false);
});
test('after-noon requests with an expired trial artifact are flagged',()=>{
 const r=summarize([make({created_at:END,opened_at:'2026-11-20T12:01:00Z'})],new Date(at));
 assert.equal(r.afterNoonIntents,1);
 assert.equal(r.afterNoonExpiredTrialArtifacts,1);
 assert.equal(r.afterNoonRequestedAboveFour,1);
 assert.equal(r.afterNoonFilledAboveFour,1);
 assert.equal(r.requiresExpiryInvestigation,true);
});
test('pre-noon intent filled after noon is separately classified; no claims of illegal fills',()=>{
 const r=summarize([make({opened_at:'2026-11-20T12:01:00Z'})],new Date(at));
 assert.equal(r.afterNoonIntents,0);
 assert.equal(r.preNoonIntentLateFills,1);
 assert.equal(r.afterNoonFilledAboveFour,1);
 assert.equal(r.afterNoonExpiredTrialArtifacts,0);
 assert.equal(r.brokerDispatchVerified,false);
});
test('post-noon small orders with no trial artifact pass without fabricated profit',()=>{
 const r=summarize([make({created_at:'2026-11-20T12:04:00Z',
  opened_at:'2026-11-20T12:04:03Z',trial_artifact:null,
  requested_lot_size:'3.2',filled_lots:'3.2'})],new Date(at));
 assert.equal(r.afterNoonIntents,1);
 assert.equal(r.afterNoonRequestedAboveFour,0);
 assert.equal(r.afterNoonExpiredTrialArtifacts,0);
 assert.equal(r.requiresExpiryInvestigation,false);
});
test('invalid evidence timestamps and excess rows are rejected',()=>{
 assert.throws(()=>summarize([make({created_at:'2026-11-20T13:00:00Z'})],new Date(at)),
  /INVALID_SOURCE_TIME/);
 assert.throws(()=>summarize(Array(301).fill(make()),new Date(at)),/EXCESS_ROWS_REVIEW_REQUIRED/);
});
