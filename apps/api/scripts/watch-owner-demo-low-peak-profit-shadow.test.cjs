'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ARTIFACT,SQL,evaluateCrossing:cross,frozenEntry,observed,setup,
 plan,summary,read,tick}=require('./watch-owner-demo-low-peak-profit-shadow.cjs');
const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
const NOW=Date.parse('2026-11-19T01:42:30.000Z');
const MARKER={activatedAt:'2026-11-19T01:42:00.000Z'};
const row={
 trade_id:'6a64fbdb-84e1-4d86-9459-608809753aa0',
 opened_at:'2026-11-19T01:42:20.000Z',
 closed_at:null,status:'OPEN',instrument:'AUDUSD',direction:'BUY',
 lot_size:'1.72',path_last_observed_at:'2026-11-19T01:42:20.000Z',
 path_observation_count:8,max_favorable_pnl:'25.80',profit_giveback:'2.00',
 realised_pnl:null,commission:null,swap:null,close_reason:null,
 metadata:{multimodel_plan_b_route:'CONFIRMED_REVERSAL'},
 sizing_inputs:{finalRiskAtStop:'86',
  demoExecutionRiskEnvelope:{historicalFeePerLot:'6'}},
};
const input={risk:86,fee:10.32,peak:25.8,previous:23.8,current:14.8,
 previousAt:NOW-10000,currentAt:NOW-2000,observations:12};
test('0.30R observed broker-net decline becomes research crossing, not order authority',()=>{
 const r=cross(input);
 assert.equal(r.eligible,true);
 assert.equal(r.reason,'OBSERVED_PNL_CROSSING_SHADOW_ONLY');
 assert.equal(r.hypotheticalFloorBrokerNet,15.91);
 assert.equal(r.cannotProveBrokerFill,true);
 assert.equal(r.brokerOrders,0);
});
test('no shadow crossing if already eligible for original 0.50R threshold',()=>{
 assert.equal(cross({...input,peak:60}).eligible,false);
});
test('no shadow crossing below lower fee-adjusted peak threshold',()=>{
 assert.equal(cross({...input,peak:7.52,risk:48.84,fee:8.4}).eligible,false);
});
test('no signal when reserve leaves insufficient positive profit',()=>{
 assert.equal(cross({...input,current:11.6}).eligible,false);
});
test('no false closing evidence from stale, equal or out-of-order marks',()=>{
 for(const currentAt of [input.previousAt, input.previousAt+21000]){
  assert.equal(cross({...input,currentAt}).eligible,false);
 }
});
test('no crossing without observed decline or sufficient path observations',()=>{
 assert.equal(cross({...input,current:24}).eligible,false);
 assert.equal(cross({...input,observations:2}).eligible,false);
});
test('freeze verifies future OPEN position and causal fee/risk',()=>{
 const r=frozenEntry(row,Date.parse(MARKER.activatedAt),NOW);
 assert.equal(r.route,'CONFIRMED_REVERSAL');
 assert.equal(r.frozenStopRisk,86);
 assert.equal(r.frozenFeeReserve,10.32);
 assert.equal(frozenEntry({...row,status:'CLOSED'},Date.parse(MARKER.activatedAt),NOW),null);
 assert.equal(frozenEntry({...row,
  opened_at:'2026-11-19T01:41:50Z'},Date.parse(MARKER.activatedAt),NOW),null);
 assert.equal(frozenEntry({...row,sizing_inputs:{}},Date.parse(MARKER.activatedAt),NOW),null);
});
test('only new and causally updated broker PnL marks count',()=>{
 assert.deepEqual(observed(row,NOW),{
  at:Date.parse('2026-11-19T01:42:20.000Z'),
  peak:25.8,current:23.8,observations:8,
 });
 assert.equal(observed({...row,path_last_observed_at:'2026-11-19T01:40:00Z'},NOW),null);
});
test('prospective planner records crossing once and only when position was seen OPEN',()=>{
 const first=plan(row,null,MARKER,NOW);
 assert.equal(first.events.length,1);
 assert.equal(first.events[0].stage,'ENROLLED');
 const next=plan({...row,
  path_last_observed_at:'2026-11-19T01:42:28.000Z',
  path_observation_count:12,profit_giveback:'11'},first.state,MARKER,NOW);
 assert.equal(next.events.length,1);
 assert.equal(next.events[0].stage,'LOW_PEAK_CROSSING_OBSERVED');
 assert.equal(next.events[0].hasTradeAuthority,false);
 assert.equal(next.events[0].hasBrokerCloseAuthority,false);
 const replay=plan({...row,
  path_last_observed_at:'2026-11-19T01:42:28.000Z',
  path_observation_count:12,profit_giveback:'11'},next.state,MARKER,NOW);
 assert.equal(replay.events.length,0);
 const closed=plan({...row,status:'CLOSED',realised_pnl:'-29.24',
  commission:'-10.32',swap:'0',
  closed_at:'2026-11-19T01:42:40.000Z'},next.state,MARKER,NOW+12000);
 assert.equal(closed.events.length,1);
 assert.equal(closed.events[0].stage,'SETTLED');
 assert.equal(closed.state.settled.netUsd,-39.56);
 assert.equal(plan({...row,status:'CLOSED',
  closed_at:'2026-11-19T01:42:40.000Z'},null,MARKER,NOW+12000).events.length,0);
});
test('activation is owner-bound, survives restart, no historical replay',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-low-peak-test-'));
 try{
  const p=setup(root,OWNER,NOW);
  assert.equal(p.marker.artifact,ARTIFACT);
  assert.equal(p.marker.brokerOrderAuthority,'NONE');
  assert.equal(setup(root,OWNER,NOW+10000).marker.activatedAt,
   p.marker.activatedAt);
  assert.throws(()=>setup(root,'00000000-0000-4000-8000-000000000001',NOW+10000),
   /TAMPERED/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('broker SQL is read-only and scoped to owner ACTIVE FULL_AUTO Pepperstone USD DEMO',async()=>{
 const commands=[];
 const db={query:async(sql,args)=>{
  commands.push([sql,args]);
  return {rows:sql===SQL?[row]:[]};
 }};
 const result=await read(db,OWNER,MARKER.activatedAt);
 assert.equal(result.length,1);
 assert.ok(commands[0][0].includes('READ ONLY'));
 for(const required of ["s.status='ACTIVE'","s.execution_mode='FULL_AUTO'",
  "b.broker_id='pepperstone-ctrader'","b.account_type='DEMO'",
  "b.account_currency='USD'","b.status='CONNECTED'",
  "b.authorization_status='ACTIVE'"]){assert.ok(SQL.includes(required),required);}
 assert.equal(commands.some(([sql])=>/INSERT INTO|UPDATE |DELETE FROM/i.test(sql)),false);
});
test('new observer writes only research journal and summary; no order',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-low-peak-tick-'));
 try{
  const {marker,state}=setup(root,OWNER,NOW-30000);
  const db={query:async sql=>({rows:sql===SQL?[row]:[]})};
  const report=await tick(db,root,OWNER,marker,state,NOW);
  assert.equal(report.enrolled,1);
  assert.equal(report.brokerOrders,0);
  assert.equal(report.modifiesExecution,false);
  assert.equal(report.estimatedSavedProfit,null);
  assert.equal(report.observedCrossings,0);
  assert.equal(fs.readdirSync(root).some(x=>x.endsWith('.jsonl')),true);
  assert.equal(fs.statSync(path.join(root,'state.json')).mode&0o777,0o600);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
