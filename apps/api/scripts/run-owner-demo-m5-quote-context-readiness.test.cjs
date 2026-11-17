'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),
 fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readCaptures}=require('./run-owner-demo-m5-quote-context-readiness.cjs');
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
