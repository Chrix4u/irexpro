'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {FIRST_PROSPECTIVE,q,eligibleRow,episodes,summary,audit}=
 require('./audit-planb-reversal-continuation-prospective.cjs');
const USER='11111111-1111-4111-8111-111111111111';
const row=(at='2026-11-13T01:00:00.000Z',patch={})=>({
 id:'id',evaluatedAt:at,instrument:'AUDUSD',direction:'SELL',
 route:'M1_TREND_CONTINUATION',
 shadow:{artifact:'planb-reversal-m1-continuation-asof-shadow-v1',
  shadowOnly:true,modifiesExecution:false,brokerOrderAuthority:'NONE',
  automaticPromotionEligible:false,mismatchObserved:true,
  eligibleForProspectiveStudy:true,reason:'M1_CONFIRMED_M5_CONFIRMED_SHADOW_ONLY',
  direction:'SELL',instrument:'AUDUSD'},
 ...patch
});
test('recognizes only decision-time frozen, non-executing research records',()=>{
 assert.equal(eligibleRow(row()),true);
 assert.equal(eligibleRow(row(undefined,{shadow:{...row().shadow,brokerOrderAuthority:'DEMO'}})),false);
 assert.equal(eligibleRow(row(undefined,{shadow:{...row().shadow,modifiesExecution:true}})),false);
 assert.equal(eligibleRow(row(undefined,{shadow:{...row().shadow,automaticPromotionEligible:true}})),false);
 assert.equal(eligibleRow(row(undefined,{shadow:{...row().shadow,artifact:'wrong'}})),false);
 assert.equal(eligibleRow(row(undefined,{instrument:'GBPUSD'})),false);
 assert.equal(eligibleRow(row(undefined,{direction:'BUY'})),false);
 assert.equal(eligibleRow(row(undefined,{shadow:null})),false);
});
test('uses first chronological independent 30-minute pair/side episode without hindsight label selection',()=>{
 const rows=[
  row('2026-11-13T01:27:00Z'),
  row('2026-11-13T01:01:00Z',{shadow:{...row().shadow,eligibleForProspectiveStudy:false,reason:'COMPLETED_M5_NOT_CONFIRMING'}}),
  row('2026-11-13T01:29:00Z'),
  row('2026-11-13T01:31:00Z'),
  row('2026-11-13T01:31:30Z',{instrument:'EURUSD',shadow:{...row().shadow,instrument:'EURUSD'}}),
 ];
 const x=episodes(rows);
 assert.deepEqual(x.map(t=>t.evaluatedAt),[
  '2026-11-13T01:01:00Z','2026-11-13T01:31:00Z','2026-11-13T01:31:30Z']);
 assert.equal(x[0].shadow.eligibleForProspectiveStudy,false);
});
test('outcome summaries do not equate missing quotes with trades or allow automatic promotion',()=>{
 const cases=[
  {...row('2026-11-13T01:01:00Z'),observation:{state:'OBSERVED_M1_MIDPOINT_PROXY',outcome:'TP',netR:1.3}},
  {...row('2026-11-13T02:01:00Z'),observation:{state:'OBSERVED_M1_MIDPOINT_PROXY',outcome:'SL',netR:-0.8}},
  {...row('2026-11-13T03:01:00Z'),observation:{state:'MISSING_15_CONSECUTIVE_VERIFIED_BROKER_CANDLES'}},
 ];
 const x=summary(cases);
 assert.equal(x.episodeLeaders,3);
 assert.equal(x.observed,2);
 assert.equal(x.unobservable,1);
 assert.equal(x.wins,1);assert.equal(x.losses,1);
 assert.equal(x.estimatedNetR,0.5);
 assert.equal(x.proxyProfitFactor,1.625);
 assert.equal(x.minimumSampleMature,false);
 assert.equal(x.brokerOrderAuthority,'NONE');
 assert.equal(x.autoPromotionAllowed,false);
});
test('rejects pre-freeze, overlong or malformed windows before querying',async()=>{
 const db={query(){throw Error('query should not run')}};
 await assert.rejects(audit(db,USER,'2026-11-12T23:00:00Z','2026-11-13T01:00:00Z'),/INVALID_OWNER/);
 await assert.rejects(audit(db,USER,FIRST_PROSPECTIVE,'2026-11-17T00:00:00Z'),/INVALID_OWNER/);
 await assert.rejects(audit(db,'not-a-user',FIRST_PROSPECTIVE,'2026-11-13T01:00:00Z'),/INVALID_OWNER/);
});
test('read-only query is strictly owner + broker-connection scoped and produces nonauthoritative report',async()=>{
 const queries=[];
 const db={async query(sql,params){
  queries.push([sql,params]);
  if(sql===q.scope)return {rows:[{id:'owner-broker',broker:'pepperstone-ctrader',account:'DEMO',currency:'USD'}]};
  return {rows:[]};
 }};
 const x=await audit(db,USER,FIRST_PROSPECTIVE,'2026-11-13T01:10:00Z',
  Date.parse('2026-11-13T01:20:00Z'));
 assert.equal(x.brokerOrderAuthority,'NONE');
 assert.equal(x.autoPromotionAllowed,false);
 assert.equal(x.rawMismatchDecisions,0);
 assert.match(queries[0][0],/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
 assert.deepEqual(queries.find(v=>v[0]===q.decisions)[1],[USER,'owner-broker',FIRST_PROSPECTIVE,'2026-11-13T01:10:00Z']);
 assert.ok(queries.find(v=>v[0]===q.fees)[1][0]===USER);
 assert.ok(queries.find(v=>v[0]==='COMMIT'));
 assert.ok(!queries.some(v=>/\b(INSERT|UPDATE|DELETE)\b|\bALTER\s+TABLE\b/i.test(v[0])));
});
test('existing safe scoring source and immutable observer cannot write broker orders',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/modules/ai/planb-reversal-m1-continuation-shadow.ts'),'utf8');
 assert.match(source,/brokerOrderAuthority: 'NONE'/);
 assert.match(source,/automaticPromotionEligible: false/);
 assert.ok(q.decisions.includes("mismatchObserved"));
 assert.ok(q.quotes.includes("ctrader-broker-native"));
});
