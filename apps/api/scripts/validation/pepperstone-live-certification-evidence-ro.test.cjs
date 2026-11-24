'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {evidenceReadOnlyStatus}=require('./pepperstone-live-certification-evidence-ro.cjs');
const rid='4ec633e4-a443-47e3-8bca-1f8f214982f5';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const successStages=[
  'connect','account-state','symbol-metadata','price','margin-estimate',
  'baseline-exposure-snapshot','place-minimum-safe-order','verify-provider-ack',
  'query-order','query-position','modify-protective-levels','close-position',
  'verify-closed','reconcile-history','verify-zero-unexpected-open-exposure',
];
function setup() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pepperstone-cert-proof-'));
  const originalFile='live-certification-pepperstone-ctrader-'+rid+'-20261124-013206.json';
  const auditFile='historical-live-canary-order-audit-'+rid+'-test.json';
  const originalPath=path.join(dir,originalFile);
  const auditPath=path.join(dir,auditFile);
  const evidence={
    runId:rid,brokerId:'pepperstone-ctrader',mode:'LIVE',
    target:{brokerId:'pepperstone-ctrader',accountIdMasked:'•••6270'},
    canary:{instrument:'AUDUSD',actualSize:'0.01',direction:'BUY'},
    baselineExposure:{positions:{count:0},workingOrders:{count:0}},
    postExposure:{positions:{count:0},workingOrders:{count:0}},
    startedAt:'2026-11-24T01:31:57.156Z',
    finishedAt:'2026-11-24T01:32:06.437Z',
    steps:[
      ...successStages.map(name=>({name,status:'PASS'})),
      {name:'account-discovery',status:'SKIPPED'},
    ],
    summary:{passed:15,failed:0,skipped:1},
    overall:'PASS',
  };
  function writeOriginal(){
    const canonical={};
    for(const [k,v] of Object.entries(evidence))
      if(!['evidenceSha256','evidenceState','certificationResult','artifactPath'].includes(k))
        canonical[k]=v;
    const canonicalSha=sha(JSON.stringify(canonical));
    const full={...evidence,evidenceSha256:canonicalSha,
      evidenceState:'PERSISTED',certificationResult:'PASS',
      artifactPath:originalPath};
    fs.writeFileSync(originalPath,JSON.stringify(full,null,2));
    return canonicalSha;
  }
  const expectedSha=writeOriginal();
  const audit={
    runId:rid,originalEvidenceSha256:sha(fs.readFileSync(originalPath)),
    originalCertificationResult:'PASS',auditStatus:'HISTORICAL_ORDER_ID_VERIFIED',
    historyProof:{status:'FOUND',openingDealId:'350035648'},
    orderProof:{status:'VERIFIED',nativeOrderId:'404148641',
      providerPositionId:'669276159',filledQuantity:'0.01'},
    currentExposure:{openPositions:0,workingOrders:0},
    noBrokerOrderCalls:true,brokerWritesSent:false,
    modifiesExistingCertification:false,
  };
  function writeAudit(){fs.writeFileSync(auditPath,JSON.stringify(audit,null,2))}
  writeAudit();
  return {dir,expectedSha,originalPath,auditPath,evidence,audit,writeOriginal,writeAudit,
    check:()=>evidenceReadOnlyStatus(dir,{runId:rid,expectedSha}),
    cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('returns NOT_FOUND when immutable files unavailable',()=>{
  const r=evidenceReadOnlyStatus('/path/that-does-not-exist',{runId:rid});
  assert.equal(r.status,'NOT_FOUND');
});
test('accepts genuine-shaped PASS and independently linked broker readback, without granting permission',()=>{
  const x=setup();
  try{
    assert.deepEqual(x.check(),{
      status:'ATTESTED_PASS_PENDING_RELEASE',
      runId:rid,canonicalSha256:x.expectedSha,
      independentNativeOrderVerified:true,
      activeTradingAuthorityGranted:false,
    });
  }finally{x.cleanup()}
});
for(const [name,edit] of [
  ['falsified summary',x=>{x.evidence.summary.failed=1;x.writeOriginal();x.writeAudit()}],
  ['missing protective stop',x=>{x.evidence.steps.find(z=>z.name==='modify-protective-levels').status='FAIL';x.writeOriginal();x.writeAudit()}],
  ['live exposure',x=>{x.audit.currentExposure.openPositions=1;x.writeAudit()}],
  ['native order mismatch',x=>{x.audit.orderProof.nativeOrderId='669276159';x.writeAudit()}],
  ['account mismatch',x=>{x.evidence.target.accountIdMasked='•••7777';x.writeOriginal();x.writeAudit()}],
  ['unsupported broker identity',x=>{x.evidence.brokerId='icmarkets-ctrader';x.writeOriginal();x.writeAudit()}],
  ['altered original without updated audit',x=>{x.evidence.summary.passed=99;x.writeOriginal()}],
  ['retroactively changed certification status',x=>{x.audit.originalCertificationResult='FAIL';x.writeAudit()}],
  ['broker writes during readback',x=>{x.audit.brokerWritesSent=true;x.writeAudit()}],
]){
  test('fails closed: '+name,()=>{
    const x=setup();
    try{edit(x);assert.equal(x.check().status,'INVALID')}
    finally{x.cleanup()}
  });
}
test('missing independent broker readback does not mark PASS',()=>{
  const x=setup();try{fs.unlinkSync(x.auditPath);assert.equal(x.check().status,'NOT_FOUND')}
  finally{x.cleanup()}
});
test('rejects ambiguous proof files',()=>{
  const x=setup();try{
    fs.copyFileSync(x.auditPath,path.join(x.dir,'historical-live-canary-order-audit-'+rid+'-duplicate.json'));
    assert.equal(x.check().status,'INVALID');
  }finally{x.cleanup()}
});
