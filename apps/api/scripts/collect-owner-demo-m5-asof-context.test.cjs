'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),
 fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ARTIFACT,chooseStage,sourceForStage,createSnapshots,
  restoreSeen,persist,prune,STAGE}=require('./collect-owner-demo-m5-asof-context.cjs');
const START=Date.parse('2026-11-17T18:00:00Z');
const SLOT=START+5*60000+15000;
const date=t=>new Date(t).toISOString();
function quoteRows(inst='EURUSD',t=START){
 const out=[];
 for(let i=0;i<5;i++){
  for(let off=1000;off<60000;off+=2000){
   const src=t+i*60000+off;
   const mid=1.1+i*.00002+off*.000000002;
   out.push({instrument:inst,source:src,observed:src+1000,
     bid:mid-.000006,ask:mid+.000006});
  }
 }
 for(const off of [3000,9000]){
   const src=t+300000+off,mid=1.10012+off*.000000001;
   out.push({instrument:inst,source:src,observed:src+1000,
     bid:mid-.000006,ask:mid+.000006});
 }
 return out;
}
function raw(q){return [
 date(q.source),date(q.observed),q.instrument,q.bid,q.ask];
}
test('scorer runs only 4s to 11.5s after fixed +15s M5 cutoff',()=>{
 assert.equal(chooseStage(SLOT+3000),null);
 assert.equal(chooseStage(SLOT+4000),SLOT);
 assert.equal(chooseStage(SLOT+9000),SLOT);
 assert.equal(chooseStage(SLOT+12000),null);
 assert.equal(chooseStage(SLOT-10000),null);
 assert.equal(STAGE,15000);
});
test('prospective snapshot has actual observed quote timestamps and no broker model authority',()=>{
 const q=quoteRows();
 const rows=createSnapshots(SLOT,q,SLOT+5200);
 assert.equal(rows.length,1);
 const x=rows[0];
 assert.equal(x.artifact,ARTIFACT);
 assert.equal(x.priorBarStart,date(START));
 assert.equal(x.priorBarEnd,date(START+300000));
 assert.equal(x.decisionAt,date(SLOT));
 assert.equal(x.noNativeM5Read,true);
 assert.equal(x.noFutureCandleInfo,true);
 assert.equal(x.labelKnown,false);
 assert.equal(x.brokerOrderAuthority,false);
 assert.equal(x.modifiesExecution,false);
 assert.equal(x.researchOnly,true);
 assert.equal(x.quotePathSampleCount,150);
 assert.equal(x.currentQuoteAsOf.samplesWithinFirst15Seconds,2);
 assert.ok(x.currentQuoteAsOf.spread>0);
 assert.ok(Number.isFinite(x.currentQuoteAsOf.midVsPreviousQuoteM5Close));
 assert.ok(Date.parse(x.currentQuoteAsOf.observedAt)<=SLOT);
 assert.equal(x.priceRepresentation,'SAMPLED_MIDQUOTE_NOT_NATIVE_M5_OHLC');
});
test('future observed quotes cannot leak into reconstructed previous candle',()=>{
 const q=quoteRows();q[q.length-3].observed=SLOT+1000;
 const rows=createSnapshots(SLOT,q,SLOT+5000);
 assert.equal(rows.length,1);
 // Removes the quote whose observation happened after the forecast cutoff.
 assert.equal(rows[0].quotePathSampleCount,149);
 const del=quoteRows().filter(q=>q.source<START+4*60000);
 assert.equal(createSnapshots(SLOT,del,SLOT+5000).length,0);
});
test('rejects missing or future-observed current M5 decision quotes',()=>{
 const raw=quoteRows();
 const missing=raw.filter(q=>q.source<START+300000);
 assert.equal(createSnapshots(SLOT,missing,SLOT+5000).length,0);
 const future=quoteRows();
 for(const q of future)if(q.source>=START+300000)q.observed=SLOT+1000;
 assert.equal(createSnapshots(SLOT,future,SLOT+5000).length,0);
});
test('missing any full minute in broker quote path is not fabricated',()=>{
 const q=quoteRows().filter(x=>x.source<START+120000||x.source>=START+180000);
 assert.equal(createSnapshots(SLOT,q,SLOT+4000).length,0);
});
test('rejects attempts to backdate research context snapshot or mutate expiry',()=>{
 assert.throws(()=>createSnapshots(SLOT,quoteRows(),SLOT+17000),/NOT_PROSPECTIVE/);
 assert.throws(()=>createSnapshots(SLOT,quoteRows(),SLOT+1000),/NOT_PROSPECTIVE/);
 assert.throws(()=>createSnapshots(SLOT+15000,quoteRows(),SLOT+19000),/NOT_PROSPECTIVE/);
});
test('reads authorized quote archive only from local day and UTC midnight crossover',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-m5-native-source-'));
 try{
  const all=quoteRows().map(q=>JSON.stringify(raw(q))).join('\n')+'\n';
  fs.writeFileSync(path.join(dir,'2026-11-17.jsonl'),all,{mode:0o600});
  assert.equal(sourceForStage(SLOT,dir).length,152);
  // Earlier-window quote path may cross 23:59 -> 00:00 UTC.
  const prev=Date.parse('2026-11-17T23:55:00Z');
  const m=quoteRows('EURUSD',prev);
  fs.writeFileSync(path.join(dir,'2026-11-17.jsonl'),m.map(q=>
    q.source< Date.parse('2026-11-18T00:00:00Z')?JSON.stringify(raw(q)):'').filter(Boolean).join('\n'));
  const nxt=Date.parse('2026-11-18T00:00:15Z');
  const selected=sourceForStage(nxt,dir);
  assert.equal(selected.length,150);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('archive persists with mode 0600 and is idempotent across restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-m5-asof-'));
 try{
  const rows=createSnapshots(SLOT,quoteRows(),SLOT+5000);
  assert.equal(persist(rows,{dir,seen:new Set()}).written,1);
  const recovered=restoreSeen(dir,new Date(SLOT+18000));
  assert.equal(recovered.size,1);
  assert.equal(persist(rows,{dir,seen:recovered}).written,0);
  const f=path.join(dir,'2026-11-17.jsonl');
  assert.equal(fs.statSync(f).mode&0o777,0o600);
  const x=JSON.parse(fs.readFileSync(f,'utf8').trim());
  assert.equal(x.noNativeM5Read,true);
  assert.equal(fs.readFileSync(f,'utf8').includes('broker_connection_id'),false);
  assert.equal(fs.readFileSync(f,'utf8').includes('api_key'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('only outdated local JSONL are pruned, unrelated or current files remain',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-m5-prune-'));
 try{
  for(const name of ['2026-01-01.jsonl','2026-11-17.jsonl','KEEP.txt'])
   fs.writeFileSync(path.join(dir,name),'x');
  assert.deepEqual(prune(dir,new Date('2026-11-17T18:00:00Z')),['2026-01-01.jsonl']);
  assert.equal(fs.existsSync(path.join(dir,'KEEP.txt')),true);
  assert.equal(fs.existsSync(path.join(dir,'2026-11-17.jsonl')),true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('research source cannot send an order, query DB or change broker risk',()=>{
 const body=fs.readFileSync(path.join(__dirname,
   'collect-owner-demo-m5-asof-context.cjs'),'utf8');
 assert.match(body,/PROSPECTIVE ONLY/);
 assert.doesNotMatch(body,/\b(?:placeOrder|closePosition|executeTrade|updateStopLoss|new Client|broker\.connections)\s*\(/);
 assert.match(body,/brokerOrderAuthority:false/);
});
