'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {parseSnapshot,persistSnapshots,pruneOldDays,QUERY,collect,
 RETAIN_DAYS,MAX_DAY_BYTES,POLL_MS}=require('./collect-pepperstone-native-quote-snapshots.cjs');
const sample=(at='2026-11-16T19:01:12Z',override={})=>({
 instrument:'USDJPY',source:'ctrader-broker-native',
 bucket_time:'2026-11-16T19:01:00Z',sample_at:at,
 bid:'154.101',ask:'154.112',spread:'0.011',...override,
});
test('accepts only native, recent, positive-spread observed bid/ask snapshots',()=>{
 const seen='2026-11-16T19:01:14.000Z';
 assert.deepEqual(parseSnapshot(sample(),seen),[
  '2026-11-16T19:01:12.000Z',seen,'USDJPY',154.101,154.112]);
 for(const bad of [
  {source:'rest-simulated'}, {ask:'154.101'}, {spread:'0'},
  {bid:'0'}, {instrument:'XAUUSD'},
  {sample_at:'2026-11-16T19:00:12Z'},
  {sample_at:'2026-11-16T19:01:22Z'},
  {bucket_time:'2026-11-16T19:02:00Z'},
  {spread:'0.9'},
 ])assert.equal(parseSnapshot(sample(undefined,bad),seen),null,JSON.stringify(bad));
 assert.equal(parseSnapshot(sample(),'2026-11-16T19:01:30Z'),null);
});
test('append-only day file deduplicates by symbol plus native observation time',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-snap-'));
 const seen=new Map();
 try{
  const at='2026-11-16T19:01:14Z';
  const first=persistSnapshots([sample(),sample()],at,fs,dir,seen);
  assert.equal(first.accepted,1);
  assert.equal(first.written[0].count,1);
  const newer=sample('2026-11-16T19:01:13Z');
  const second=persistSnapshots([sample(),newer],at,fs,dir,seen);
  assert.equal(second.accepted,1);
  const file=path.join(dir,'2026-11-16.jsonl');
  const records=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length,2);
  assert.ok(records[0][0]<records[1][0]);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('retention removes only older research dates, not unrelated files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-prune-'));
 try{
  for(const f of ['2026-11-01.jsonl','2026-11-15.jsonl','2026-11-16.jsonl',
   'important.txt'])fs.writeFileSync(path.join(dir,f),'x');
  const old=pruneOldDays(new Date('2026-11-16T20:00:00Z'),fs,dir);
  assert.deepEqual(old,['2026-11-01']);
  assert.equal(fs.existsSync(path.join(dir,'important.txt')),true);
  assert.equal(fs.existsSync(path.join(dir,'2026-11-16.jsonl')),true);
  assert.equal(RETAIN_DAYS,7);
  assert.ok(MAX_DAY_BYTES<50*1024*1024);
  assert.equal(POLL_MS,2000);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('exact owner, active USD Pepperstone DEMO, select-only quote source',()=>{
 assert.match(QUERY,/s\.user_id=\$1/);
 assert.match(QUERY,/s\.status='ACTIVE'/);
 assert.match(QUERY,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(QUERY,/b\.account_type='DEMO'/);
 assert.match(QUERY,/q\.source='ctrader-broker-native'/);
 assert.match(QUERY,/last_positive_sample_at>=now\(\)-interval '10 seconds'/);
 assert.doesNotMatch(QUERY,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
});
test('read-only transaction never persists credentials or uses broker dispatch',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-collect-'));
 const queries=[];
 const db={query:async(sql)=>{
  queries.push(sql);
  if(sql===QUERY)return {rows:[sample()]};
  return {rows:[]};
 }};
 try{
  const result=await collect(db,'11111111-1111-4111-8111-111111111111',
   new Map(),tmp,new Date('2026-11-16T19:01:14Z'));
  assert.equal(result.written[0].count,1);
  assert.equal(queries[0],'BEGIN READ ONLY');
  assert.equal(queries[queries.length-1],'COMMIT');
  assert.equal(fs.readFileSync(path.join(tmp,'2026-11-16.jsonl'),'utf8')
   .includes('broker_connection_id'),false);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
