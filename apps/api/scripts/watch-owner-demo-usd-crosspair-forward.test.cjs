'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PAIRS,toBars,q}=require('./audit-owner-demo-usd-crosspair-factor.cjs');
const {ARTIFACT,freeze,signalAt,scoreSlot,summarize,snapshot,plan,step}=
 require('./watch-owner-demo-usd-crosspair-forward.cjs');
const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
const BROKER='9a14f702-4f46-42d1-9aee-eb282b3f5321';
const T0=Date.parse('2026-11-19T02:00:00.000Z');
const MIN=60000;
function fakeRows(length=42){
 const rows=[];
 for(let i=0;i<length;i++)for(const pair of PAIRS){
  const t=T0+i*MIN;
  const sign=pair.startsWith('USD')?1:-1;
  const price=(pair==='USDJPY'?150:1.2)*Math.exp(i*sign*.0002);
  rows.push({
   instrument:pair,bucket_time:new Date(t).toISOString(),
   bid_close:price-.00001,ask_close:price+.00001,
   last_quote_sample_at:new Date(t+45000).toISOString(),
   last_positive_bid:price-.00001,last_positive_ask:price+.00001,
   last_positive_sample_at:new Date(t+44000).toISOString(),
   positive_quote_sample_count:9,
  });
 }
 return rows;
}
function barsAt(minutes){
 return toBars(fakeRows(),new Date(T0+minutes*MIN)).bars;
}
test('new frozen activation is owner AND broker bound, private and idempotent',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-usd-forward-'));
 try{
  const a=freeze(root,OWNER,BROKER,T0);
  assert.equal(a.marker.artifact,ARTIFACT);
  assert.equal(a.marker.brokerOrderAuthority,'NONE');
  assert.equal(a.marker.researchOnly,true);
  assert.equal(fs.statSync(path.join(root,'activation.json')).mode&0o777,0o600);
  const b=freeze(root,OWNER,BROKER,T0+5000);
  assert.deepEqual(a.marker,b.marker);
  assert.throws(()=>freeze(root,OWNER,'00000000-0000-4000-8000-000000000001',
   T0+8000),/MISMATCH/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('signalAt excludes target and assigns correct cross-pair direction',()=>{
 const bars=barsAt(18);
 const f=signalAt(bars,'EURUSD',T0+10*MIN);
 assert.equal(f.state,'USD_STRONG');
 assert.equal(f.impliedDirection,'SELL');
 assert.equal(f.excludedOwnPair,true);
 assert.equal(f.evidencePairs.includes('EURUSD'),false);
 assert.equal(f.noExecutionAuthority,true);
 const base=signalAt(bars,'USDJPY',T0+10*MIN);
 assert.equal(base.impliedDirection,'BUY');
 assert.equal(base.evidencePairs.includes('USDJPY'),false);
});
test('plan never backfills an event before activation',()=>{
 const now=T0+11*MIN+6000;
 const state={artifact:ARTIFACT,slots:{}};
 const marker={activatedAt:new Date(T0+12*MIN).toISOString()};
 const result=plan({state,marker,asOf:new Date(T0+13*MIN),
  bars:barsAt(13)});
 assert.equal(result.newEvents.length,0);
});
test('signal events precede future outcomes in causal time order',()=>{
 const marker={activatedAt:new Date(T0).toISOString()};
 const state={artifact:ARTIFACT,slots:{}};
 const early=plan({state,marker,
  asOf:new Date(T0+11*MIN+6000).toISOString(),
  bars:barsAt(11.1)});
 assert.equal(early.newEvents.length,6);
 assert.equal(early.report.signalsWithStrongUsdConsensus,6);
 assert.equal(early.newEvents.every(x=>x.kind==='SIGNAL'&&
   x.brokerOrders===0&&x.noExecutionAuthority===true),true);
 assert.equal(early.report.forward5Minutes.matchedSignals,0);
 const next=plan({state,marker,
  asOf:new Date(T0+16*MIN+6000).toISOString(),
  bars:barsAt(16.1)});
 assert.equal(next.report.forward5Minutes.matchedSignals,6);
 assert.equal(next.report.forward15Minutes.matchedSignals,0);
 assert.equal(next.report.forward5Minutes.accuracy,1);
 const final=plan({state,marker,
  asOf:new Date(T0+26*MIN+6000).toISOString(),
  bars:barsAt(26.1)});
 assert.ok(final.report.forward15Minutes.matchedSignals>=6);
 assert.equal(final.report.researchOnly,true);
 assert.equal(final.report.brokerOrders,0);
 assert.equal(final.report.profitFromSignals,null);
});
test('observed real-time feature snapshots are not retrospectively modified by future quotes',()=>{
 const initial=barsAt(12);
 const x=signalAt(initial,'USDCAD',T0+10*MIN);
 const frozen=JSON.stringify(x);
 const future=barsAt(30);
 future.get('USDCAD').get(T0+15*MIN).mid*=1.02;
 assert.equal(JSON.stringify(signalAt(future,'USDCAD',T0+10*MIN)),frozen);
 const label=scoreSlot(x,future,5);
 assert.equal(label.includesFullBrokerCosts,false);
 assert.equal(label.brokerFill,false);
 assert.equal(label.brokerOrders,0);
});
test('missing future broker quotes produce no result, not a made-up win',()=>{
 const x=signalAt(barsAt(12),'EURUSD',T0+10*MIN);
 assert.equal(scoreSlot(x,barsAt(12),15),null);
 assert.equal(scoreSlot({...x,noExecutionAuthority:false},barsAt(40),5),null);
});
test('summary counts independent UTC dates rather than independent signals',()=>{
 const m={activatedAt:new Date(T0).toISOString()};
 const state={slots:{
  one:{target:'EURUSD',slotAt:new Date(T0).toISOString(),
   state:'USD_STRONG',outcome5:{directionalCorrect:true,
    directionalChangeBps:2,afterIndicativeSpreadOnlyBps:1}},
  two:{target:'USDJPY',slotAt:new Date(T0).toISOString(),
   state:'USD_STRONG',outcome5:{directionalCorrect:false,
    directionalChangeBps:-1,afterIndicativeSpreadOnlyBps:-2}},
 }};
 const out=summarize(state,m);
 assert.equal(out.forward5Minutes.matchedSignals,2);
 assert.equal(out.forward5Minutes.accuracy,.5);
 assert.equal(out.forward5Minutes.independentUtcDays,1);
});
test('data access requires active owner FULL_AUTO USD DEMO and read only transaction',async()=>{
 const seen=[];
 const db={query:async(sql,args)=>{
  seen.push([sql,args]);
  if(sql===q.scope)return {rows:[{connection_id:BROKER,
   snapshot_at:new Date(T0+42*MIN).toISOString()}]};
  if(sql===q.candles)return {rows:fakeRows()};
  return {rows:[]};
 }};
 const s=await snapshot(db,OWNER);
 assert.equal(s.scope.connection_id,BROKER);
 assert.equal(s.bars.get('USDCHF').size,41);
 assert.ok(seen[0][0].includes('READ ONLY'));
 assert.ok(q.scope.includes("s.status='ACTIVE'"));
 assert.ok(q.scope.includes("b.account_type='DEMO'"));
 assert.ok(q.scope.includes("b.account_currency='USD'"));
 assert.ok(q.candles.includes("bucket_time+interval '1 minute'"));
 assert.equal(seen.some(([sql])=>/INSERT |UPDATE |DELETE /i.test(sql)),false);
});
test('activation is pinned to DB snapshot, not a later process clock',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-usd-clock-'));
 try{
  const asOf=T0+42*MIN;
  const db={query:async sql=>{
   if(sql===q.scope)return {rows:[{connection_id:BROKER,
    snapshot_at:new Date(asOf).toISOString()}]};
   if(sql===q.candles)return {rows:fakeRows()};
   return {rows:[]};
  }};
  await step(db,root,OWNER,asOf+7000);
  const mark=JSON.parse(fs.readFileSync(path.join(root,'activation.json'),'utf8'));
  assert.equal(mark.activatedAt,new Date(asOf).toISOString());
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('research worker persists state and journal only, no trading commands',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-usd-forward-step-'));
 const now=T0+42*MIN;
 try{
  const db={query:async sql=>{
   if(sql===q.scope)return {rows:[{connection_id:BROKER,
    snapshot_at:new Date(now).toISOString()}]};
   if(sql===q.candles)return {rows:fakeRows()};
   return {rows:[]};
  }};
  const first=await step(db,root,OWNER,now);
  assert.equal(first.report.brokerOrders,0);
  assert.equal(first.report.modifiesExecution,undefined);
  assert.equal(fs.statSync(path.join(root,'state.json')).mode&0o777,0o600);
  assert.equal(first.report.slotsObserved,0); // Activation begins NOW, no replay
  const second=await step(db,root,OWNER,now+MIN);
  assert.equal(second.report.slotsObserved,0); // same frozen completed slot
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
