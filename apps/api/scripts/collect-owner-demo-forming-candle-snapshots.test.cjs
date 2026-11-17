'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {
 ARTIFACT,validQuote,candleFromQuotes,snapshotsAt,archiveRows,
 restoreRecentSeen,persist,pruneSnapshots,processSlot,STAGE_MS,replayArchivedDay,backfillArchives,RETAIN_DAYS,
}=require('./collect-owner-demo-forming-candle-snapshots.cjs');
const row=(second,inst='EURUSD',bid=1.1000,ask=1.1002,observedDelayMs=1000,minute=0)=>[
 new Date(Date.UTC(2026,10,17,16,minute,second)).toISOString(),
 new Date(Date.UTC(2026,10,17,16,minute,second)+observedDelayMs).toISOString(),
 inst,bid,ask,
];
const slot=(minute,sec)=>Date.UTC(2026,10,17,16,minute,sec);
function history(instrument='EURUSD',minutes=[0,1,2],step=2){
 const out=[];
 for(const m of minutes)
  for(let s=0;s<60;s+=step){
   const p=1.1+(m*60+s)*.000001;
   out.push(row(s,instrument,p,p+.00010,400,m));
  }
 return out;
}
test('validates actual source/received time, positive native bidask, scoped pairs',()=>{
 assert.ok(validQuote(row(8)));
 for(const r of [
  row(8,'GBPUSD'),row(8,'EURUSD',1.1,1.1),
  row(8,'EURUSD',-1,1.2),row(8,'EURUSD',1.1,1.2,15000),
  ['bad','bad','EURUSD',1.1,1.11],null,
 ]){
  assert.equal(validQuote(r),null);
 }
});
test('an as-of :15 snapshot cannot see quotes first observed at :17',()=>{
 const quotes=[row(2,'EURUSD',1.1000,1.1002),
   row(8,'EURUSD',1.1010,1.1012),row(14,'EURUSD',1.1020,1.1022,4000),
   row(17,'EURUSD',1.105,1.1052)];
 const result=snapshotsAt(quotes,slot(0,15));
 assert.equal(result.length,2); // M1 and M5 are both forming.
 for(const x of result){
  assert.equal(x.sampleCount,2);
  assert.equal(x.close,1.1011);
  assert.equal(x.lastBid,1.1010);
  assert.equal(x.includesNextBarLabel,false);
  assert.equal(x.brokerOrderAuthority,false);
  assert.equal(x.fromCompletedFutureCandle,false);
 }
 assert.equal(snapshotsAt(quotes,slot(0,0)).length,0);
});
test('M5 forms from already-observed M1 quote path, not completed future M5 OHLC',()=>{
 const quotes=history('EURUSD',[0,1,2,3],2);
 const out=snapshotsAt(quotes,slot(3,30));
 const m1=out.find(x=>x.timeframe==='M1');
 const m5=out.find(x=>x.timeframe==='M5');
 assert.ok(m1);assert.ok(m5);
 assert.equal(m1.elapsedSeconds,30);
 assert.equal(m5.elapsedSeconds,210);
 assert.ok(m5.sampleCount>m1.sampleCount);
 assert.ok(m5.high>=m1.high);
 assert.ok(m5.low<=m1.low);
 assert.equal(m5.barStart,'2026-11-17T16:00:00.000Z');
});
test('M5 missing a whole already elapsed minute is excluded rather than invented',()=>{
 const quotes=history('EURUSD',[0,2,3],2);
 const s=snapshotsAt(quotes,slot(3,30));
 assert.equal(s.filter(x=>x.timeframe==='M5').length,0);
 assert.equal(s.filter(x=>x.timeframe==='M1').length,1);
});
test('rejects delayed source and unknown/stale decision-time price',()=>{
 const q=history('EURUSD',[0],2);
 const s=snapshotsAt(q,slot(0,45));
 assert.equal(s.length,2);
 const stale=[row(1),row(3)];
 assert.equal(snapshotsAt(stale,slot(0,45)).length,0);
});
test('candle geometry is only sampled midquote evidence, not complete tick OHLC',()=>{
 const q=[validQuote(row(0)),validQuote(row(5,'EURUSD',1.101,1.1012)),
  validQuote(row(12,'EURUSD',1.099,1.0992))];
 const x=candleFromQuotes(q,slot(0,0),slot(0,15));
 assert.equal(x.high,1.1011);
 assert.equal(x.low,1.0991);
 assert.equal(x.close,1.0991);
 assert.equal(x.color,'RED');
 assert.equal(x.fullTickOhlc,false);
 assert.equal(x.priceSource,'sampled-positive-native-bid-ask');
});
test('reject malformed/truncated source archive lines without fabricating data',()=>{
 const input=[JSON.stringify(row(1)),'{unfinished',
  JSON.stringify(row(2,'GBPUSD')),JSON.stringify(row(3))].join('\n');
 assert.equal(archiveRows(input).length,2);
});
test('files are private, deduplicated across restart, append-only, and no owner identifiers',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-forming-'));
 try{
  const s=snapshotsAt(history('EURUSD',[0],2),slot(0,15));
  const seen=new Set();
  const a=persist(s,{dir,seen});
  assert.equal(a.written,2);
  const b=persist(s,{dir,seen});
  assert.equal(b.written,0);
  const prior=restoreRecentSeen(dir,new Date('2026-11-17T16:04:00Z'));
  assert.equal(prior.size,2);
  assert.equal(persist(s,{dir,seen:prior}).written,0);
  const p=path.join(dir,'2026-11-17.jsonl');
  assert.equal(fs.statSync(p).mode&0o777,0o600);
  const body=fs.readFileSync(p,'utf8');
  assert.equal(body.includes('broker_connection_id'),false);
  assert.equal(body.includes('user_id'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reader never includes future slot archive after midnight or cross-corrupts symbols',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-form-source-'));
 const dst=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-form-out-'));
 try{
  const raw=history('EURUSD',[0,1],2);
  fs.writeFileSync(path.join(dir,'2026-11-17.jsonl'),raw.map(JSON.stringify).join('\n')+'\n');
  const out=processSlot(slot(1,15),{source:dir,dir:dst,seen:new Set()});
  assert.equal(out.written,2);
  assert.equal(processSlot(slot(1,15),{source:dir,dir:dst,seen:restoreRecentSeen(dst,
    new Date('2026-11-17T16:01:17Z'))}).written,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(dst,{recursive:true,force:true});}
});
test('retention removes only aged research JSONL and keeps unrelated files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-form-prune-'));
 try{
  for(const x of ['2026-01-01.jsonl','2026-11-16.jsonl','README.txt'])
   fs.writeFileSync(path.join(dir,x),'x');
  const removed=pruneSnapshots(dir,new Date('2026-11-17T16:00:00Z'));
  assert.deepEqual(removed,['2026-01-01.jsonl']);
  assert.equal(fs.existsSync(path.join(dir,'README.txt')),true);
  assert.equal(fs.existsSync(path.join(dir,'2026-11-16.jsonl')),true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('research worker never queries broker, writes database or changes execution',()=>{
 assert.equal(STAGE_MS,15000);
 const script=fs.readFileSync(__filename.replace(/\.test\.cjs$/,'.cjs'),'utf8');
 assert.doesNotMatch(script,/\b(?:placeOrder|executeTrade|modifyPosition|closePosition|UPDATE\s+trading|DELETE\s+FROM)\b/);
 assert.match(script,/brokerOrderAuthority:false/);
});

test('historical replay is as-of and cannot use later observed quote',()=>{
 const old=[row(1,'EURUSD',1.10,1.1001),
  row(5,'EURUSD',1.101,1.1011),
  row(9,'EURUSD',1.1015,1.1016),
  row(11,'EURUSD',1.102,1.1021,12000), // source 11s, observed 23s
  row(28,'EURUSD',1.11,1.1101)];
 const a=replayArchivedDay(old.map(JSON.stringify).join('\n'),
   slot(0,0),slot(0,30));
 const early=a.find(x=>x.decisionAt===new Date(slot(0,15)).toISOString()&&x.timeframe==='M1');
 assert.ok(early);
 assert.equal(early.sampleCount,3);
 assert.ok(early.close<1.103);
 const late=a.find(x=>x.decisionAt===new Date(slot(0,30)).toISOString()&&x.timeframe==='M1');
 assert.ok(late);
 assert.ok(late.close>1.10);
 assert.equal(early.includesNextBarLabel,false);
});
test('backfill is idempotent, local-only, private, and keeps 90 days of compact snapshots',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-form-bf-'));
 const src=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-form-src-'));
 try{
  const raw=history('EURUSD',[0,1,2,3],2);
  fs.writeFileSync(path.join(src,'2026-11-17.jsonl'),raw.map(JSON.stringify).join('\n')+'\n');
  const now=new Date('2026-11-17T16:09:00Z');
  const a=backfillArchives({dir,source:src,now});
  assert.ok(a.written>=6);
  assert.equal(a.noDatabaseWrites,true);
  assert.equal(a.modifiesExecution,false);
  const b=backfillArchives({dir,source:src,now});
  assert.equal(b.written,0);
  assert.ok(b.duplicates>=6);
  assert.equal(RETAIN_DAYS,90);
  assert.equal(fs.statSync(path.join(dir,'2026-11-17.jsonl')).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(src,{recursive:true,force:true});}
});
