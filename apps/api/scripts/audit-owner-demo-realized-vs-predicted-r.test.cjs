'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ARTIFACT,SQL,normalize,metrics,group,audit}
 =require('./audit-owner-demo-realized-vs-predicted-r.cjs');
const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
const SINCE='2026-11-16T00:00:00.000Z',THROUGH='2026-11-19T03:00:00.000Z';
const trade={
 opened_at:'2026-11-19T01:08:00.000Z',
 closed_at:'2026-11-19T01:13:00.000Z',
 instrument:'USDCAD',direction:'SELL',lot_size:'1.4',
 route:'CONFIRMED_REVERSAL',expected_r:'0.25',
 estimated_cost_r:'0.08',initial_risk:'50',
 realised_pnl:'-30',commission:'-8.4',swap:'0',
 close_reason:'AI_CLOSE_SIGNAL',
};
test('after-cost broker R is based on pre-entry stop-risk, not a directional label',()=>{
 const r=normalize(trade);
 assert.equal(r.modelPlanBExpectedR,.25);
 assert.equal(r.modelExecutionCostR,.08);
 assert.equal(r.brokerNetUsd,-38.4);
 assert.equal(r.brokerNetR,-.768);
 assert.equal(r.excludesLateCapitalAllocation,true);
});
test('commission deducted exactly once and not double counted with estimatedCostR',()=>{
 const r=metrics([normalize(trade),normalize({
  ...trade,instrument:'EURUSD',realised_pnl:'55',commission:'-10',initial_risk:'100',
  expected_r:'0.3',estimated_cost_r:'.07'})]);
 assert.equal(r.brokerGrossUsd,25);
 assert.equal(r.commissionUsd,-18.4);
 assert.equal(r.brokerNetUsd,6.6);
 assert.equal(r.wins,1);
 assert.equal(r.losses,1);
 assert.equal(r.avgPlanBExpectedR,.275);
 assert.equal(r.avgActualBrokerNetR,-.159);
 assert.equal(r.avgExpectedMinusObservedR,.434);
 assert.equal(r.meetsDemoProfitFactorThreshold,false);
});
test('missing or invalid capital risk never becomes a fabricated zero-risk profitable trade',()=>{
 for(const value of [null,'','0','-8','NaN']){
  const r=normalize({...trade,initial_risk:value});
  assert.equal(r.valid,false);
 }
 const a=metrics([normalize({...trade,initial_risk:null})]);
 assert.equal(a.completeComparable,0);
 assert.equal(a.missingOrUnverifiable,1);
 assert.equal(a.brokerNetUsd,null);
 assert.equal(a.winRate,null);
 assert.equal(a.avgPlanBExpectedR,null);
});
test('missing broker commission or swap never assumes a free fill',()=>{
 for(const field of ['commission','swap','realised_pnl']){
  const r=normalize({...trade,[field]:null});
  assert.equal(r.valid,false);
 }
});
test('strategy and UTC-day groups do not mix distinct trading strategies',()=>{
 const rows=[
  normalize(trade),
  normalize({...trade,route:'EARLY_TRANSITION',
    opened_at:'2026-11-18T09:00:00Z',
    closed_at:'2026-11-18T09:10:00Z',realised_pnl:'25'}),
 ];
 const g=group(rows,x=>x.utcDay+' '+x.route);
 assert.equal(g['2026-11-19 CONFIRMED_REVERSAL'].settled,1);
 assert.equal(g['2026-11-18 EARLY_TRANSITION'].settled,1);
});
test('profit-factor readiness requires 30 settled trades, positive net and profit factor >=1.15',()=>{
 const winning=normalize({...trade,realised_pnl:'60'});
 const losing=normalize(trade);
 assert.equal(metrics([winning]).meetsDemoProfitFactorThreshold,false);
 const many=[...Array(25).fill(winning),...Array(5).fill(losing)];
 const r=metrics(many);
 assert.ok(r.profitFactor>1.15);
 assert.equal(r.meetsDemoProfitFactorThreshold,true);
 assert.equal(r.liveReady,false); // other independent LIVE gates still required
 const bad=[...Array(10).fill(winning),...Array(20).fill(losing)];
 assert.equal(metrics(bad).meetsDemoProfitFactorThreshold,false);
});
test('read-only exact-owner broker audit rejects different broker, LIVE and bad identifier',async()=>{
 const commands=[];
 const db={query:async(sql,args)=>{commands.push([sql,args]);if(sql===SQL)
   return {rows:[trade]};return {rows:[]};}};
 const r=await audit(db,{owner:OWNER,since:SINCE,through:THROUGH});
 assert.equal(r.artifact,ARTIFACT);
 assert.equal(r.brokerOrders,0);
 assert.equal(r.changesExecution,false);
 assert.equal(r.autoPromote,false);
 assert.equal(r.byRoute.CONFIRMED_REVERSAL.brokerNetUsd,-38.4);
 assert.ok(commands[0][0].includes('READ ONLY'));
 assert.ok(SQL.includes("b.broker_id='pepperstone-ctrader'"));
 assert.ok(SQL.includes("b.account_type='DEMO'"));
 assert.ok(SQL.includes("b.account_currency='USD'"));
 assert.ok(SQL.includes('ca.created_at<=t.opened_at'));
 assert.equal(commands.some(([sql])=>/\bINSERT INTO\b|\bUPDATE\b|\bDELETE FROM\b/i.test(sql)),false);
 await assert.rejects(audit(db,{owner:'other',since:SINCE,through:THROUGH}),
  /INVALID_OWNER/);
});
test('audit fails rather than silently truncate a large broker cohort',async()=>{
 const db={query:async sql=>({rows:sql===SQL?Array(501).fill(trade):[]})};
 await assert.rejects(audit(db,{owner:OWNER,since:SINCE,through:THROUGH}),
  /TRUNCATED/);
});
test('outdated and reversed time windows fail closed',async()=>{
 const db={query:async()=>{throw Error('should not query');}};
 await assert.rejects(audit(db,{owner:OWNER,since:'2026-11-01T00:00:00Z',
  through:THROUGH}),/INVALID_OWNER_OR_WINDOW/);
 await assert.rejects(audit(db,{owner:OWNER,since:THROUGH,through:SINCE}),
  /INVALID_OWNER_OR_WINDOW/);
});
