'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {select,label,band,stats,quoteValue,firstInWindow,SQL}=
  require('./audit-owner-demo-expert-abstain-forward.cjs');
const row=(overrides={})=>({
 created_at:'2026-11-20T20:01:00Z',instrument:'EURUSD',direction:'SELL',route:'ABSTAIN',
 governance:{multimodelTrainedExpert:{state:'ABSTAIN',admitted:false,
  allBrokerNative:true,direction:'SELL',
  decisionTime:'2026-11-20T20:00:25Z',
  meanOpportunityProbability:0.34,ensembleConfidence:0.79,
  shortVotes:3,longVotes:0},
  multimodelEnsemble:{strategyRoute:'TREND_CONTINUATION',paperAdmitted:false}},
 ...overrides
});
const quote=(t,bid,ask)=>({t:Date.parse(t),bid,ask});
test('5-minute deterministic episodes collapse repeated decisions, not different slots',()=>{
 const a=row(),b=row({created_at:'2026-11-20T20:02:00Z'}),
  c=row({created_at:'2026-11-20T20:06:00Z',
   governance:{...row().governance,multimodelTrainedExpert:{
    ...row().governance.multimodelTrainedExpert,decisionTime:'2026-11-20T20:05:30Z'}}});
 const s=select([c,b,a]);assert.equal(s.length,2);
 assert.equal(s[0].signalAt,'2026-11-20T20:01:00Z');
 assert.equal(s[0].expertP,0.34);
});
test('rejects opposite-side mismatch, stale expert, missing model probabilities and non-native data',()=>{
 const ex=row().governance.multimodelTrainedExpert;
 const rows=[
  row({direction:'BUY'}),
  row({governance:{...row().governance,multimodelTrainedExpert:{...ex,decisionTime:'2026-11-20T19:40:00Z'}}}),
  row({governance:{...row().governance,multimodelTrainedExpert:{...ex,meanOpportunityProbability:null}}}),
  row({governance:{...row().governance,multimodelTrainedExpert:{...ex,allBrokerNative:false}}}),
 ];
 assert.equal(select(rows).length,0);
});
test('broker event time and tight spread validation are mandatory',()=>{
 assert.equal(quoteValue(['2026-11-20T20:01:00Z','2026-11-20T20:01:01Z','EURUSD',1.1,1.099]),null);
 assert.equal(quoteValue(['fake','x','EURUSD',1.1,1.1001]),null);
 assert.deepEqual(quoteValue(['2026-11-20T20:01:00Z','x','EURUSD',1.1,1.1001]),
  {t:Date.parse('2026-11-20T20:01:00Z'),bid:1.1,ask:1.1001});
});
test('never uses a quote before decision or after 12-second entry/exit tolerance',()=>{
 const qs=[quote('2026-11-20T20:00:59Z',1.1,1.1001),
           quote('2026-11-20T20:01:13Z',1.1,1.1001)];
 assert.equal(firstInWindow(qs,Date.parse('2026-11-20T20:01:00Z'),12000),null);
 assert.equal(firstInWindow(qs,Date.parse('2026-11-20T20:00:59Z'),12000)?.t,
  Date.parse('2026-11-20T20:00:59Z'));
});
test('SELL uses entry bid and exit ask, charges extra after bid/ask spread',()=>{
 const s=select([row()])[0],quotes={EURUSD:[
  quote('2026-11-20T20:01:03Z',1.1000,1.1002),
  quote('2026-11-20T20:06:04Z',1.0990,1.0992),
 ]};
 const x=label(s,quotes);assert.equal(x.outcome,'SAMPLED_5M_MARK_NOT_BROKER_FILL');
 assert.equal(x.netPips,7);assert.equal(x.positive,true);
 const buy={...s,side:'BUY'},y=label(buy,quotes);
 assert.equal(y.netPips,-13);assert.equal(y.positive,false);
});
test('forward horizons use only sampled prices at the respective 5-, 10-, 15-minute mark',()=>{
 const s=select([row()])[0],quotes={EURUSD:[
  quote('2026-11-20T20:01:03Z',1.1000,1.1002),
  quote('2026-11-20T20:06:04Z',1.0990,1.0992),
  quote('2026-11-20T20:11:05Z',1.0980,1.0982),
  quote('2026-11-20T20:16:06Z',1.0970,1.0972),
 ]};
 assert.equal(label(s,quotes,300000).netPips,7);
 assert.equal(label(s,quotes,600000).netPips,17);
 assert.equal(label(s,quotes,900000).netPips,27);
 assert.equal(label(s,quotes,180000).outcome,'UNKNOWN_EXIT_QUOTE');
});
test('missing future or entry price remains unknown, not zero-fee win or loss',()=>{
 const s=select([row()])[0];
 const x=label(s,{EURUSD:[]});assert.equal(x.outcome,'UNKNOWN_ENTRY_QUOTE');
 assert.equal(x.netPips,null);
 const y=label(s,{EURUSD:[quote('2026-11-20T20:01:01Z',1.100,1.101)]});
 assert.equal(y.outcome,'UNKNOWN_EXIT_QUOTE');assert.equal(y.netPips,null);
 assert.equal(stats([x,y]).observed,0);
 assert.equal(stats([x,y]).unknown,2);
});
test('owner/account SQL is exact USD DEMO and read-only study contains no order mutation',()=>{
 assert.match(SQL,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(SQL,/b\.account_type='DEMO'/);
 assert.match(SQL,/b\.account_currency='USD'/);
 assert.match(SQL,/d\.user_id=\$1/);
 assert.match(SQL,/d\.broker_connection_id=\$2/);
 assert.doesNotMatch(SQL,/\b(INSERT|UPDATE|DELETE|EXECUTE)\b/i);
 assert.equal(band(0.2),'0.20-0.30');assert.equal(band(0.4),'0.40-1.00');
});
