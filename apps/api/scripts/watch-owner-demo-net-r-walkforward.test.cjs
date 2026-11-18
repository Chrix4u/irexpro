'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CADENCE,MAX_OUTPUT,summarizeSuccess,runOnce}
 =require('./watch-owner-demo-net-r-walkforward.cjs');
test('cadence and output caps prevent overly frequent/unbounded audit',()=>{
 assert.equal(CADENCE,30*60000);
 assert.ok(MAX_OUTPUT<=128*1024);
});
test('summarizes only the typed day-purged read-only calibration result',()=>{
 const data={
  generatedAt:'2026-11-18T13:20:33Z',
  result:{evaluatedTrades:106,independentDays:6,
   outOfSampleDayPurgedAdjustedCount:24,maeRawOnComparedCohort:.7593,
   maeAdjustedOnComparedCohort:.7008,
   directionOfAccuracyChange:'PRELIMINARY_IMPROVEMENT'},
 };
 const str='DAY_PURGED_OWNER_NET_R_CALIBRATION '+JSON.stringify(data);
 const r=summarizeSuccess('noise\n'+str+'\n');
 assert.equal(r.trades,106);
 assert.equal(r.adjustedTestTrades,24);
 assert.equal(r.shadowMAE,.7008);
 assert.equal(r.modifiesExecution,false);
 assert.equal(r.lotChanges,0);
 assert.equal(r.brokerOrders,0);
 assert.equal(r.qualifiedForLive,false);
});
test('invalid or non-audit stdout never counts as success',()=>{
 assert.throws(()=>summarizeSuccess('process healthy'),/MISSING_RESEARCH_RESULT/);
 assert.throws(()=>summarizeSuccess('DAY_PURGED_OWNER_NET_R_CALIBRATION {}'),
  /INVALID_RESEARCH_RESULT/);
 assert.throws(()=>summarizeSuccess('DAY_PURGED_OWNER_NET_R_CALIBRATION {bad'),
  /SyntaxError/);
});
test('failed child process is an error, not a fake research result',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-watch-'));
 try{
  const p=path.join(dir,'audit-fail.cjs');
  fs.writeFileSync(p,'process.exit(9);');
  await assert.rejects(runOnce({script:p,timeoutMs:3000}),
   /RESEARCH_AUDIT_FAILED/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('mock test child returns a compact result independent of source journal',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-watch-'));
 try{
  const p=path.join(dir,'audit-success.cjs');
  const payload={generatedAt:'2026-11-18T13:20:33Z',
   result:{evaluatedTrades:6,independentDays:3,
    outOfSampleDayPurgedAdjustedCount:2,
    maeRawOnComparedCohort:.3,maeAdjustedOnComparedCohort:.2,
    directionOfAccuracyChange:'PRELIMINARY_IMPROVEMENT'}};
  fs.writeFileSync(p,'console.log('+
   JSON.stringify('DAY_PURGED_OWNER_NET_R_CALIBRATION '+JSON.stringify(payload))+
   ');');
  const r=await runOnce({script:p,timeoutMs:3000});
  assert.equal(r.trades,6);
  assert.equal(r.lotChanges,0);
  assert.equal(r.modifiesExecution,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
