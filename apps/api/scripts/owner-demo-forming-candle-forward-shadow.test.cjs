'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {
 ARTIFACT,scoreSlot,stageTimeframes,loadStageSnapshots,
 predictionKey,restoreSeen,appendPredictions,readPriorBars,
}=require('./owner-demo-forming-candle-forward-shadow.cjs');
const start=Date.UTC(2026,10,17,17,0,0);
const time=n=>new Date(n).toISOString();
function snapshot(slot,inst='EURUSD',tf='M1'){
 const width=tf==='M1'?60000:300000;
 return {artifact:'irexpro-forming-candle-asof-quote-shadow-v1',
  instrument:inst,timeframe:tf,barStart:time(Math.floor(slot/width)*width),
  decisionAt:time(slot),modifiesExecution:false,brokerOrderAuthority:false,
  includesNextBarLabel:false,fromCompletedFutureCandle:false};
}
function forecast(s){
 return {artifact:ARTIFACT,instrument:s.instrument,timeframe:s.timeframe,
  decisionAt:s.decisionAt,barStart:s.barStart,researchOnly:true,
  brokerOrderAuthority:false,modifiesExecution:false,
  nextCandleOutcomeKnown:false,afterCostPnlKnown:false};
}
test('fixed window only scores M1 :15/:45 while current candle is forming',()=>{
 assert.equal(scoreSlot(start+15000+4000),start+15000);
 assert.equal(scoreSlot(start+15000+10500),start+15000);
 assert.equal(scoreSlot(start+15000+11000),null);
 assert.equal(scoreSlot(start+30000+5000),null);
 assert.equal(scoreSlot(start+45000+5000),start+45000);
 assert.deepEqual(stageTimeframes(start+15000),['M1','M5']);
 assert.deepEqual(stageTimeframes(start+45000),['M1']);
 assert.deepEqual(stageTimeframes(start+4*60000+45000),['M1','M5']);
});
test('stage archive contains only timestamp-matched, exact-scoped snapshots',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-snap-forward-'));
 try{
  const slot=start+15000;
  const rows=[snapshot(slot),snapshot(slot,'AUDUSD','M5'),
    snapshot(slot+15000,'USDJPY')];
  rows.push({...snapshot(slot,'GBPUSD'),instrument:'GBPUSD'});
  fs.writeFileSync(path.join(dir,'2026-11-17.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  const selected=loadStageSnapshots(slot,dir);
  assert.equal(selected.length,2);
  assert.equal(selected.every(x=>x.decisionAt===time(slot)),true);
  assert.equal(selected.some(x=>x.instrument==='GBPUSD'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('duplicate source time/pair/stage cannot yield multiple forecast episodes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-dup-forward-'));
 try{
  const snap=snapshot(start+15000);
  fs.writeFileSync(path.join(dir,'2026-11-17.jsonl'),[snap,snap].map(JSON.stringify).join('\n')+'\n');
  assert.throws(()=>loadStageSnapshots(start+15000,dir),/DUPLICATE_ASOF/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('records private append-only, deduplicated next-candle predictions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-out-forward-'));
 try{
  const s=snapshot(start+15000);
  const p=forecast(s);
  assert.equal(appendPredictions([p],{dir}).written,1);
  assert.equal(restoreSeen(dir,new Date(start+60000)).size,1);
  assert.equal(appendPredictions([p],{dir,seen:restoreSeen(dir,new Date(start+60000))}).written,0);
  const f=path.join(dir,'2026-11-17.jsonl');
  assert.equal(fs.statSync(f).mode&0o777,0o600);
  assert.ok(!fs.readFileSync(f,'utf8').includes('account_id'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('research prediction must NEVER claim a realized position result or trading authority',()=>{
 const s=forecast(snapshot(start+15000));
 for(const change of [
  {brokerOrderAuthority:true},{modifiesExecution:true},
  {nextCandleOutcomeKnown:true},{afterCostPnlKnown:true},
 ]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-unsafe-forward-'));
  try{assert.throws(()=>appendPredictions([{...s,...change}],{dir}),/UNSAFE_RESEARCH/)}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});
test('native prior SQL is BEGIN READ ONLY and cannot return the unfinished current bar',async()=>{
 const executed=[];
 const db={query:async(sql,args)=>{
  executed.push(sql);
  if(sql==='BEGIN READ ONLY'||sql==='COMMIT')return {rows:[]};
  if(sql==='ROLLBACK')return {rows:[]};
  assert.match(sql,/c\.bucket_time \+ CASE k\.timeframe/);
  assert.match(sql,/<= k\.bar_start/);
  assert.ok(!/\b(UPDATE|INSERT|DELETE)\s+/i.test(sql));
  assert.deepEqual(args[1],['EURUSD']);
  assert.deepEqual(args[2],['M1']);
  return {rows:[{instrument:'EURUSD',timeframe:'M1',
    bucket_time:new Date(start-60000),open:'1.1',high:'1.1005',
    low:'1.0999',close:'1.1002'}]};
 }};
 const found=await readPriorBars(db,'fake-demo-connection',[snapshot(start+15000)]);
 assert.equal(found['EURUSD|M1'].length,1);
 assert.deepEqual(executed[0],'BEGIN READ ONLY');
 assert.deepEqual(executed[executed.length-1],'COMMIT');
});
test('cannot mistake a strategy forecast for an order submission',()=>{
 const source=fs.readFileSync(__filename.replace(/\.test\.cjs$/,'.cjs'),'utf8');
 assert.doesNotMatch(source,/\b(placeOrder|executeTrade|closePosition|modifyPosition)\s*\(/);
 assert.doesNotMatch(source,/\b(UPDATE|DELETE|INSERT)\s+(INTO|trading|broker)\b/i);
 assert.match(source,/brokerOrderAuthority:false/);
});
