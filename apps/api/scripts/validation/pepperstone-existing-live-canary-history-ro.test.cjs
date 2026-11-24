'use strict';
const {test}=require('node:test');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chooseNativeOrderIdentity,verifyOrderReadback,loadOriginalEvidence}=
  require('./pepperstone-existing-live-canary-history-ro.cjs');
const from=Date.parse('2026-11-24T00:51:38.839Z');
const to=Date.parse('2026-11-24T00:55:52.524Z');
const open={dealId:123,orderId:5555,positionId:669256554,
  executionTimestamp:from+3*60_000};
const close={...open,dealId:124,orderId:5556,
  executionTimestamp:from+3*60_000+3000,closePositionDetail:{entryPrice:0.66}};
const input={deals:[open,close],hasMore:false,positionId:'669256554',from,to};
test('exact unique native order from opening deal and confirmed closing deal',()=>{
 const result=chooseNativeOrderIdentity(input);
 assert.equal(result.status,'FOUND');assert.equal(result.brokerNativeOrderId,'5555');
 assert.equal(result.closingDeals,1);
});
for(const [name,delta,reason] of [
 ['missing deal',{deals:[close]},'UNIQUE_OPEN_AND_CLOSE_DEAL_NOT_PROVEN'],
 ['missing close',{deals:[open]},'UNIQUE_OPEN_AND_CLOSE_DEAL_NOT_PROVEN'],
 ['ambiguous opening deal',{deals:[open,{...open,dealId:133,orderId:4444},close]},'UNIQUE_OPEN_AND_CLOSE_DEAL_NOT_PROVEN'],
 ['wrong position',{positionId:'669256555'},'POSITION_DEALS_NOT_FOUND'],
 ['unverified hasMore',{hasMore:undefined},'HISTORY_PAGE_UNPROVEN_COMPLETE'],
 ['has more',{hasMore:true},'HISTORY_PAGE_UNPROVEN_COMPLETE'],
 ['no order',{deals:[{...open,orderId:0},close]},'NATIVE_ORDER_ID_OR_EXECUTION_TIME_NOT_VERIFIED'],
 ['out of window',{deals:[{...open,executionTimestamp:from-1},close]},'NATIVE_ORDER_ID_OR_EXECUTION_TIME_NOT_VERIFIED'],
]){
 test('fails closed on '+name,()=>{
  const result=chooseNativeOrderIdentity({...input,...delta});
  assert.equal(result.status,'INCOMPLETE');assert.equal(result.reason,reason);
 });
}
const found=chooseNativeOrderIdentity(input);
test('validates exact native ID plus exact filled size and symbol',()=>{
 const result=verifyOrderReadback({providerOrderId:'5555',providerPositionId:'669256554',status:'FILLED',
  instrument:'AUDUSD',filledQuantity:'0.01'},found);
 assert.equal(result.status,'VERIFIED');
});
for(const [name,patch] of [
 ['wrong order',{providerOrderId:'669256554'}],
 ['wrong position',{providerPositionId:'9999'}],
 ['wrong size',{filledQuantity:'0.10'}],
 ['wrong instrument',{instrument:'EURUSD'}],
 ['not filled',{status:'WORKING'}]
]){
 test('refuses '+name+' on provider order readback',()=>{
  const state={providerOrderId:'5555',providerPositionId:'669256554',
    status:'FILLED',instrument:'AUDUSD',filledQuantity:'0.01',...patch};
  assert.equal(verifyOrderReadback(state,found).status,'INCOMPLETE');
 });
}
test('rejects absent order state',()=>{
 assert.equal(verifyOrderReadback(null,found).status,'INCOMPLETE');
});
test('recognizes an exact immutable FAIL artifact and computes reference hash',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-canary-audit-test-'));
 try{
  const names=['connect','account-discovery','account-state','symbol-metadata','price',
   'margin-estimate','baseline-exposure-snapshot','place-minimum-safe-order',
   'verify-provider-ack','query-order','query-position','modify-protective-levels',
   'close-position','verify-closed','reconcile-history','verify-zero-unexpected-open-exposure'];
  const steps=names.map(name=>({name,status:
   name==='verify-provider-ack'||name==='query-order'?'FAIL':
   name==='account-discovery'?'SKIPPED':'PASS',
   detail:name==='query-position'?'canary position 669256554 open at 0.66259 (0.01 lots)':''}));
  const src={runId:'236a6506-5368-4b68-b6b4-394c3af3ecb3',mode:'LIVE',
   brokerId:'pepperstone-ctrader',certificationResult:'FAIL',evidenceState:'PERSISTED',
   target:{accountIdMasked:'•••6270'},
   startedAt:'2026-11-24T00:53:38.839Z',finishedAt:'2026-11-24T00:53:52.524Z',
   canary:{instrument:'AUDUSD',actualSize:'0.01'},steps};
  const f=path.join(dir,'live-certification-pepperstone-ctrader-'+src.runId+'-sample.json');
  fs.writeFileSync(f,JSON.stringify(src));
  const original=fs.readFileSync(f,'utf8');
  const a=loadOriginalEvidence(dir);
  assert.match(a.sourceSha256,/^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(f,'utf8'),original);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
