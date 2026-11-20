'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),
 fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PAIRS,usdPolarity,toBars}=require('./audit-owner-demo-usd-crosspair-factor.cjs');
const {ARTIFACT,tradeSql,freeze,entrySlot,signalAtEntry,settledOutcome,
 plan,summarize,snapshot,step}=require('./watch-owner-demo-usd-trade-alignment.cjs');
const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
const CONN='9a14f702-4f46-42d1-9aee-eb282b3f5321';
const TRADE='6a64fbdb-84e1-4d86-9459-608809753aa0';
const MIN=60000,T0=Date.parse('2026-11-19T02:00:00.000Z');
const activatedAt='2026-11-19T02:05:00.000Z';
const MARKER={artifact:ARTIFACT,activatedAt};
const OPEN=new Date(T0+19*MIN+30000).toISOString(),
 NOW=new Date(T0+20*MIN).toISOString();
const basic={
 trade_id:TRADE,opened_at:OPEN,closed_at:null,status:'OPEN',
 instrument:'USDJPY',direction:'BUY',lot_size:'1.4',
 route:'CONFIRMED_REVERSAL',realised_pnl:null,commission:null,swap:null,
};
function bars(now=NOW){
 const rows=[];
 for(let i=0;i<24;i++){
  const t=T0+i*MIN;
  for(const pair of PAIRS){
   const m=(pair==='USDJPY'?150:1.2)*
     Math.exp(i*0.00018*usdPolarity(pair));
   rows.push({instrument:pair,bucket_time:new Date(t).toISOString(),
    bid_close:m-0.00001,ask_close:m+0.00001,
    last_quote_sample_at:new Date(t+42000).toISOString(),
    positive_quote_sample_count:12});
  }
 }
 return toBars(rows,now).bars;
}
test('pre-entry slot always ends at least three seconds before order',()=>{
 assert.equal(entrySlot(OPEN),T0+18*MIN);
 assert.equal(entrySlot(new Date(T0+19*MIN+1000).toISOString()),T0+17*MIN);
 assert.equal(entrySlot('invalid'),null);
});
test('trades can only be captured while OPEN after frozen activation',()=>{
 const m=bars();
 const f=signalAtEntry(basic,m,MARKER,NOW);
 assert.equal(f.factorState,'USD_STRONG');
 assert.equal(f.signalAligned,true);
 assert.equal(f.consensusPairDirection,'BUY');
 assert.equal(f.targetExcluded,true);
 assert.ok(f.peerPairs.every(pair=>pair!=='USDJPY'));
 assert.equal(f.preEntryAsOf,new Date(T0+19*MIN).toISOString());
 assert.equal(signalAtEntry({...basic,status:'CLOSED'},m,MARKER,NOW),null);
 assert.equal(signalAtEntry({...basic,opened_at:activatedAt},m,MARKER,NOW),null);
 assert.equal(signalAtEntry({...basic,opened_at:new Date(T0+17*MIN).toISOString()},
   m,MARKER,NOW),null);
});
test('factor signal can disagree with trade but does not veto or reverse orders',()=>{
 const f=signalAtEntry({...basic,direction:'SELL'},bars(),MARKER,NOW);
 assert.equal(f.signalAligned,false);
 assert.equal(f.consensusPairDirection,'BUY');
});
test('no confirmed consensus returns neutral, not an invented agreement',()=>{
 const m=bars();
 for(const pair of PAIRS.filter(x=>x!=='USDJPY'&&x!=='USDCHF')){
  m.get(pair).clear();
 }
 const f=signalAtEntry(basic,m,MARKER,NOW);
 assert.equal(f.factorState,'UNAVAILABLE');
 assert.equal(f.signalAligned,null);
});
test('broker settlement only after CLOSED and complete after-cost fields',()=>{
 const closed={...basic,status:'CLOSED',
  closed_at:new Date(T0+26*MIN).toISOString(),
  realised_pnl:'-29.24',commission:'-10.32',swap:'0',close_reason:'AI_CLOSE_SIGNAL'};
 assert.equal(settledOutcome(basic),null);
 assert.equal(settledOutcome({...closed,commission:null}),null);
 assert.equal(settledOutcome(closed).netUsd,-39.56);
});
test('entry factor frozen before broker PnL outcome, never recomputed at close',()=>{
 const first=plan([basic],bars(),MARKER,{artifact:ARTIFACT,trades:{}},NOW);
 assert.equal(first.events.length,1);
 assert.equal(first.events[0].kind,'FROZEN_PRE_ENTRY_FACTOR');
 assert.equal(first.events[0].hasExecutionAuthority,false);
 const later={...basic,status:'CLOSED',
  closed_at:new Date(T0+26*MIN).toISOString(),
  realised_pnl:'-29.24',commission:'-10.32',swap:'0'};
 const rec=first.state.trades[TRADE];
 const frozen=JSON.stringify(rec.entry);
 const second=plan([later],new Map(),MARKER,first.state,
  new Date(T0+27*MIN).toISOString());
 assert.equal(second.events.length,1);
 assert.equal(second.events[0].kind,'BROKER_SETTLED_OUTCOME');
 assert.equal(JSON.stringify(second.state.trades[TRADE].entry),frozen);
 assert.equal(second.state.trades[TRADE].settled.netUsd,-39.56);
 assert.equal(plan([later],new Map(),MARKER,second.state,
  new Date(T0+28*MIN).toISOString()).events.length,0);
});
test('first seeing a completed trade cannot retroactively cherry-pick features',()=>{
 const r=plan([{...basic,status:'CLOSED',
  realised_pnl:30,commission:-9,swap:0,
  closed_at:new Date(T0+26*MIN).toISOString()}],
  bars(),MARKER,{artifact:ARTIFACT,trades:{}},
  new Date(T0+27*MIN).toISOString());
 assert.equal(r.events.length,0);
 assert.deepEqual(Object.keys(r.state.trades),[]);
});
test('summary shows winning and losing aligned AND opposed trades separately',()=>{
 const a=signalAtEntry(basic,bars(),MARKER,NOW);
 const b={...a,tradeId:'f30c5678-0eda-4f08-94ee-76699b922111',
  signalAligned:false,route:'EARLY_TRANSITION'};
 const r=summarize({trades:{
  [a.tradeId]:{entry:a,settled:{netUsd:10}},
  [b.tradeId]:{entry:b,settled:{netUsd:-30}},
 }},MARKER);
 assert.equal(r.all.closed,2);
 assert.equal(r.byAlignment.aligned.settledNetUsd,10);
 assert.equal(r.byAlignment.opposed.settledNetUsd,-30);
 assert.equal(r.byRoute.EARLY_TRANSITION.opposed.closed,1);
 assert.equal(r.brokerOrders,0);
 assert.equal(r.modifiesExecution,false);
 assert.equal(r.changesRiskGates,false);
});
test('activation is immutable, broker-owner bound and private',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-usd-trade-'));
 try{
  const {marker}=freeze(dir,OWNER,CONN,T0+5*MIN);
  assert.equal(marker.brokerOrderAuthority,'NONE');
  assert.equal(fs.statSync(path.join(dir,'activation.json')).mode&0o777,0o600);
  assert.equal(freeze(dir,OWNER,CONN,T0+6*MIN).marker.activatedAt,
   marker.activatedAt);
  assert.throws(()=>freeze(dir,OWNER,TRADE,T0+6*MIN),/FROZEN_ACTIVATION/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('read-only query scoped to connected owner broker and no future data in feature',async()=>{
 const sampleRows=[];
 for(const [p,byTime] of bars())for(const [t,v] of byTime)sampleRows.push({
  instrument:p,bucket_time:new Date(t).toISOString(),
  bid_close:v.mid-v.spreadBps*v.mid/20000,
  ask_close:v.mid+v.spreadBps*v.mid/20000,
  last_quote_sample_at:new Date(t+42000).toISOString(),
  positive_quote_sample_count:12});
 const commands=[];
 const db={query:async(sql,args)=>{
  commands.push([sql,args]);
  if(sql===require('./audit-owner-demo-usd-crosspair-factor.cjs').q.scope)
   return {rows:[{connection_id:CONN,snapshot_at:NOW}]};
  if(sql===require('./audit-owner-demo-usd-crosspair-factor.cjs').q.candles)
   return {rows:sampleRows};
  if(sql===tradeSql)return {rows:[basic]};
  return {rows:[]};
 }};
 const data=await snapshot(db,OWNER);
 assert.equal(data.trades.length,1);
 assert.ok(commands[0][0].includes('READ ONLY'));
 assert.ok(commands.some(([sql])=>sql.includes("b.broker_id='pepperstone-ctrader'")));
 assert.ok(tradeSql.includes('t.user_id=$1'));
 assert.ok(tradeSql.includes('t.broker_connection_id=$2'));
 assert.ok(commands.every(([sql])=>!/(^|\s)(UPDATE|DELETE|INSERT)\s/i.test(sql)));
 assert.equal(signalAtEntry(basic,data.bars,MARKER,NOW).signalAligned,true);
});
test('read-only worker saves private state, no orders',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-usd-trade-save-'));
 try{
  const raws=[];
  for(const [p,byTime] of bars())for(const [t,v] of byTime)raws.push({
   instrument:p,bucket_time:new Date(t).toISOString(),
   bid_close:v.mid-.00001,ask_close:v.mid+.00001,
   last_quote_sample_at:new Date(t+42000).toISOString(),
   positive_quote_sample_count:12});
  const db={query:async sql=>{
   const {q}=require('./audit-owner-demo-usd-crosspair-factor.cjs');
   if(sql===q.scope)return {rows:[{connection_id:CONN,snapshot_at:NOW}]};
   if(sql===q.candles)return {rows:raws};
   if(sql===tradeSql)return {rows:[basic]};
   return {rows:[]};
  }};
  const result=await step(db,dir,OWNER);
  assert.equal(result.report.brokerOrders,0);
  assert.equal(result.report.all.trades,0); // exact activation excludes existing position
  assert.equal(result.newEvents,0);
  assert.equal(fs.statSync(path.join(dir,'state.json')).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
