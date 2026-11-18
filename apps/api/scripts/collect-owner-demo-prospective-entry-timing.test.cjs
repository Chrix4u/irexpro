'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {
 ARTIFACT,SQL,STAGES,normalize,readQuotesAt,stageKey,event,
 plan,derive,loadActivation,recover,append,prune,readCandidates,tick,
}=require('./collect-owner-demo-prospective-entry-timing.cjs');
const started=Date.parse('2026-11-18T13:00:00Z');
const owner='2caa0c64-00dd-48fb-babb-06b39cb74068';
const tradeKey='b0d690b5-5a09-4d7f-a7b9-68f81f6bf615';
const timestamp=x=>new Date(x).toISOString();
const row=(overrides={})=>({
 trade_key:tradeKey,instrument:'EURUSD',direction:'BUY',status:'OPEN',
 opened_at:timestamp(started),closed_at:null,
 fill_price:'1.10005',stop_loss:'1.09955',take_profit:'1.10085',
 lot_size:'1.8',realised_pnl:null,commission:null,swap:null,
 intent_at:timestamp(started-3000),allocation_at:timestamp(started-5000),
 risk_at_stop:'75',metadata:{
  multimodel_plan_b_route:'EARLY_TRANSITION',
  multimodel_governance_net_expected_r:'0.31',
  signal_suggested_entry_price:'1.1000',m1_tactical_route:'ABSTAIN',
  multimodel_trained_expert_state:'ABSTAIN',
  multimodel_trained_expert_long_votes:'3',
  multimodel_trained_expert_short_votes:'0',
  multimodel_execution_authority_path:'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE',
 },...overrides,
});
const quote=(at,bid,seen=at)=>({
 at,observed:seen,bid,ask:bid+.0001,
 mid:bid+.00005,spread:.0001,
});
const qmap=()=>({EURUSD:[
 quote(started-300000,1.0990),
 quote(started-60000,1.09980),
 quote(started-15000,1.09990),
 quote(started-4500,1.1,started-3500),
 quote(started+59000,1.10008),
 quote(started+179000,1.1005),
 quote(started+299000,1.1004),
 quote(started+599000,1.1006),
 ],AUDUSD:[],USDJPY:[],USDCAD:[]});
test('SELECT is owner-scoped, read-only, one broker DEMO USD, no LIVE or orders',()=>{
 assert.match(SQL,/t.user_id=\$1 AND b.user_id=\$1/);
 assert.match(SQL,/b.broker_id='pepperstone-ctrader'/);
 assert.match(SQL,/b.account_type='DEMO'/);
 assert.match(SQL,/t.account_currency='USD'/);
 assert.match(SQL,/t.opened_at >= \$2::timestamptz/);
 assert.doesNotMatch(SQL,/UPDATE|DELETE|INSERT/);
 assert.equal(STAGES.length,4);
 assert.equal(ARTIFACT.startsWith('irexpro-prospective'),true);
});
test('entry metadata is taken from original intent, and never needs final profit',()=>{
 const x=normalize(row());
 assert.equal(x.valid,true);
 assert.equal(x.expectedNetR,.31);
 assert.equal(x.plannedEntry,1.1);
 assert.equal(x.m1TacticalRoute,'ABSTAIN');
 assert.equal(x.closedAt,Infinity);
 assert.equal(x.lotSize,1.8);
 assert.equal(normalize(row({intent_at:timestamp(started+300)})).valid,false);
 assert.equal(normalize(row({stop_loss:'1.101'})).valid,false);
});
test('after activation an OPEN trade can enroll within 90 seconds only',()=>{
 assert.equal(plan(row(),new Set(),started+90000)[0].kind,'ENTRY');
 assert.equal(plan(row(),new Set(),started+90001)[0].stage,'ENTRY_MISSED');
 assert.equal(plan(row({status:'CLOSED'}),new Set(),started+15000)[0].stage,'ENTRY_MISSED');
 assert.equal(plan(row(),new Set(),started-1).length,0);
});
test('entry snapshot freezes strictly pre-intent price context, no outcome',()=>{
 const r=derive(row(),{kind:'ENTRY',trade:normalize(row())},qmap(),started+10000);
 assert.equal(r.stage,'ENTRY');
 assert.equal(r.route,'EARLY_TRANSITION');
 assert.equal(r.causalPreIntentQuote.status,'FRESH_ASOF_BROKER_QUOTE');
 assert.ok(r.causalPreIntentQuote.latestObservedAt<r.intentAt);
 assert.equal(r.noOutcomeAtEntryCaptured,true);
 assert.equal(r.noTradeAuthority,true);
 assert.equal(r.modifiesExecution,false);
});
test('only prospectively eligible enrolled trades produce checkpoint events',()=>{
 const seen=new Set([stageKey(tradeKey,'ENTRY')]);
 assert.deepEqual(plan(row(),seen,started+10000),[]);
 const a=plan(row(),seen,started+72000);
 assert.equal(a.length,1);
 assert.equal(a[0].kind,'CHECKPOINT_60S');
 const x=derive(row(),a[0],qmap(),started+72000);
 assert.equal(x.stage,'CHECKPOINT_60S');
 assert.equal(x.checkpoint.artifact.startsWith('irexpro-owner'),true);
 assert.equal(x.checkpoint.noTradeAuthority,true);
 const missed=plan(row(),seen,started+101000);
 assert.equal(missed[0].stage,'CHECKPOINT_60S_MISSED');
 assert.equal(missed[0].reason,'CAPTURE_DEADLINE_EXCEEDED');
});
test('a late restarted collector will not forge previously missed entry stages',()=>{
 const seen=new Set([stageKey(tradeKey,'ENTRY_MISSED')]);
 assert.deepEqual(plan(row(),seen,started+600000),[]);
});
test('3/5/10m outcome marks must be on time; after real trade close is censored',()=>{
 const enrolled=new Set([stageKey(tradeKey,'ENTRY'),stageKey(tradeKey,'CHECKPOINT_60S')]);
 const at=started+180000+12000;
 const stages=plan(row(),enrolled,at);
 assert.equal(stages[0].kind,'MARK_3M');
 const e=derive(row(),stages[0],qmap(),at);
 assert.equal(e.stage,'MARK_3M');
 assert.equal(e.observation.status,'SAMPLED_MARK_ONLY');
 assert.equal(e.observation.afterActualExit,false);
 assert.equal(e.noHypotheticalBrokerFill,true);
 const closed=derive(row({closed_at:timestamp(started+120000),status:'CLOSED',
  realised_pnl:'20',commission:'-10',swap:'0'}),
  stages[0],qmap(),at);
 assert.equal(closed.observation.afterActualExit,true);
 assert.equal(closed.actualTradeWasClosedBeforeMarketMark,true);
});
test('settlement uses signed actual settled costs and does not reenter closed trade',()=>{
 const seen=new Set([stageKey(tradeKey,'ENTRY')]);
 const x=plan(row({status:'CLOSED',closed_at:timestamp(started+200000),
  realised_pnl:'-70',commission:'-10',swap:'0'}),seen,started+214000);
 const settled=x.find(z=>z.stage==='SETTLED');
 assert.ok(settled);
 assert.equal(settled.settledNetUsd,-80);
 assert.equal(settled.eventualOutcomeOnly,true);
 assert.equal(settled.modifiesExecution,false);
});
test('private immutable activation is owner-bound and cannot be replaced silently',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-entry-'));
 try{
  const first=loadActivation(root,owner,started);
  const later=loadActivation(root,owner,started+10000);
  assert.deepEqual(first,later);
  assert.equal(first.activatedAt,timestamp(started));
  assert.throws(()=>loadActivation(root,
   'e5d3a9e9-44e7-4b49-b177-f33b3eb77d12',started+10000),
  /MISMATCHED/);
  assert.equal(fs.statSync(path.join(root,'activation.json')).mode&0o777,0o600);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('append-only private journal survives restart and is idempotent',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-journal-'));
 try{
  const seen=new Set();
  const e=event(tradeKey,'ENTRY',started,{example:'causal'});
  assert.equal(append(root,e,seen),true);
  assert.equal(append(root,e,seen),false);
  const restored=recover(root,started+50000);
  assert.ok(restored.has(stageKey(tradeKey,'ENTRY')));
  const file=path.join(root,'2026-11-18.jsonl');
  assert.equal(fs.readFileSync(file,'utf8').trim().split('\n').length,1);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('readonly query and timing loop never call mutation and enforce bounded rows',async()=>{
 const calls=[];
 const client={query:async(sql,params)=>{
  calls.push({sql,params});
  if(sql===SQL)return {rows:[row()]};
  return {rows:[]};
 }};
 const r=await readCandidates(client,owner,timestamp(started-1000),started+20000);
 assert.equal(r.length,1);
 assert.equal(calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(calls.at(-1).sql,'COMMIT');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-tick-'));
 try{
  const marker={activatedAt:timestamp(started-1000)};
  const seen=new Set();
  const first=await tick({client,owner,marker,root,seen,
   now:started+20000,quoteLoader:qmap});
  assert.equal(first.states.ENTRY,1);
  const again=await tick({client,owner,marker,root,seen,
   now:started+21000,quoteLoader:qmap});
  assert.equal(again.events,0);
  assert.equal(recover(root,started+22000).size,1);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('no real trading modes are enabled or promoted by the collection design',()=>{
 const status=event(tradeKey,'ENTRY',started);
 assert.equal(status.noTradeAuthority,true);
 assert.equal(status.modifiesLotSize,false);
 assert.equal(status.researchOnly,true);
 assert.equal(SQL.includes('LIVE'),false);
});
