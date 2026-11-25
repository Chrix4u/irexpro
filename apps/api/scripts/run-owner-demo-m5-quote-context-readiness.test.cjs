'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),
 fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readCaptures,summarizeNativeM1QuoteQuality,QUALITY_WINDOW_MINUTES}=require('./run-owner-demo-m5-quote-context-readiness.cjs');
const {SNAP_ARTIFACT}=require('./research-owner-demo-m5-quote-context-readiness.cjs');
const at='2026-11-17T18:50:15.000Z';
function row(artifact=SNAP_ARTIFACT){return {artifact,decisionAt:at,instrument:'AUDUSD'};}
test('reads only v2 prospective rows within bounded time window',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-m5-readiness-'));
 try{
  fs.writeFileSync(path.join(dir,'2026-11-17.jsonl'),
   JSON.stringify(row())+'\n'+JSON.stringify(row('irexpro-prospective-asof-quoted-m5-context-v1'))+'\n');
  const result=readCaptures(new Date('2026-11-17T19:00:00Z'),dir);
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].artifact,SNAP_ARTIFACT);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('future, invalid and malformed archived records never become training rows',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-m5-readiness-'));
 try{
  fs.writeFileSync(path.join(dir,'2026-11-17.jsonl'),
   [JSON.stringify(row()),'{bad',JSON.stringify({...row(),decisionAt:'2026-12-20T00:00:00Z'})].join('\n'));
  const r=readCaptures(new Date('2026-11-17T19:00:00Z'),dir);
  assert.equal(r.rows.length,1);
  assert.equal(r.exclusions.MALFORMED_JSON,1);
  assert.equal(r.exclusions.OUT_OF_WINDOW,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('cannot read a huge native archive under unbounded memory use',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-m5-readiness-'));
 try{
  const f=path.join(dir,'2026-11-17.jsonl');
  fs.writeFileSync(f,'{}');
  fs.truncateSync(f,8*1024*1024);
  const r=readCaptures(new Date('2026-11-17T19:00:00Z'),dir);
  assert.equal(r.rows.length,0);
  assert.equal(r.exclusions.FILE_NOT_READABLE_OR_OVER_SIZE,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('runner is read-only in SQL and never grants order authority',()=>{
 const source=fs.readFileSync(path.join(__dirname,
  'run-owner-demo-m5-quote-context-readiness.cjs'),'utf8');
 assert.match(source,/BEGIN READ ONLY/);
 assert.match(source,/promotionAllowed:false/);
 assert.doesNotMatch(source,/\b(?:placeOrder|executeTrade|closePosition|modifyPosition)\s*\(/);
 assert.doesNotMatch(source,/\b(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:trading\.|broker\.)/);
});

test('owner-native M1 quote quality exposes sparse EURUSD while not fabricating missing symbols',()=>{
 const rows=[{
   instrument:'EURUSD',minutes_observed:180,total_samples:'23972',
   total_positive_samples:'1652',zero_positive_minutes:9,
   one_positive_minute:17,two_or_more_positive_minutes:154,
   zero_or_missing_close_spread_minutes:129,
 },{
   instrument:'AUDUSD',minutes_observed:180,total_samples:'27092',
   total_positive_samples:'6404',zero_positive_minutes:0,
   one_positive_minute:0,two_or_more_positive_minutes:180,
   zero_or_missing_close_spread_minutes:5,
 }];
 const x=summarizeNativeM1QuoteQuality(rows,new Date('2026-11-17T19:50:00Z'));
 assert.equal(x.windowMinutes,180);
 assert.equal(x.byInstrument.EURUSD.minutesObserved,180);
 assert.equal(x.byInstrument.EURUSD.minutesWithNoPositiveSpread,9);
 assert.equal(x.byInstrument.EURUSD.minutesWithOnlyOnePositiveSpread,17);
 assert.equal(x.byInstrument.EURUSD.sourceQualityFlag,
   'SPARSE_POSITIVE_BID_ASK_OBSERVATIONS');
 assert.equal(x.byInstrument.AUDUSD.sourceQualityFlag,
   'NO_SPARSE_POSITIVE_SPREAD_FLAG');
 assert.equal(x.byInstrument.USDJPY.status,'NO_VERIFIED_NATIVE_M1_DATA_IN_WINDOW');
 assert.equal(x.byInstrument.USDCAD.status,'NO_VERIFIED_NATIVE_M1_DATA_IN_WINDOW');
 assert.equal(x.byInstrument.EURUSD.brokerOrderAuthority,false);
 assert.equal(x.byInstrument.EURUSD.modelTrainingAuthority,false);
 assert.equal(QUALITY_WINDOW_MINUTES,180);
});
test('impossible native quote statistics are rejected, not converted into favorable quality',()=>{
 const base={instrument:'EURUSD',minutes_observed:1,total_samples:'1',
   total_positive_samples:'2',zero_positive_minutes:0,
   one_positive_minute:0,two_or_more_positive_minutes:1,
   zero_or_missing_close_spread_minutes:0};
 assert.throws(()=>summarizeNativeM1QuoteQuality([base]),/INVALID_NATIVE_M1_QUALITY_AGGREGATES/);
 assert.throws(()=>summarizeNativeM1QuoteQuality([{
   ...base,total_samples:3,zero_positive_minutes:1,
 }]),/INVALID_NATIVE_M1_QUALITY_AGGREGATES/);
});
test('quote-quality telemetry is exact-owner broker-native read-only and never adjusts entry gates',()=>{
 const source=fs.readFileSync(path.join(__dirname,
   'run-owner-demo-m5-quote-context-readiness.cjs'),'utf8');
 assert.match(source,/BEGIN READ ONLY/);
 assert.match(source,/broker_id='pepperstone-ctrader'/);
 assert.match(source,/account_type='DEMO'/);
 assert.match(source,/account_currency='USD'/);
 assert.match(source,/timeframe='M1'/);
 assert.match(source,/nativeM1QuoteQuality/);
 assert.doesNotMatch(source,/\b(?:placeOrder|executeTrade|closePosition|modifyPosition)\s*\(/);
});
