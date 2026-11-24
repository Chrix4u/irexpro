'use strict';
/**
 * Read-only private evidence inspection for the *known* Pepperstone LIVE
 * certification run. This is a diagnostics-only function, not certification,
 * provider permission, or a dispatch grant.
 *
 * A run cannot be "promoted" by putting a PASS-shaped file on disk:
 * the exact operator run ID, canonical SHA, expected lifecycle, and separately
 * linked broker-readback evidence must all match. The actual registry is still
 * the sole source of execution eligibility.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const RUN_ID = '4ec633e4-a443-47e3-8bca-1f8f214982f5';
const EXPECTED_SHA = 'f9d9b0cdb19b5f97629e2608fe93f52f5258237c719d0ca55fdfe0e42ac84643';
const POSITION_ID = '669276159';
const ORDER_ID = '404148641';
const PASSED_STAGES = Object.freeze([
  'connect','account-state','symbol-metadata','price',
  'margin-estimate','baseline-exposure-snapshot','place-minimum-safe-order',
  'verify-provider-ack','query-order','query-position','modify-protective-levels',
  'close-position','verify-closed','reconcile-history',
  'verify-zero-unexpected-open-exposure',
]);
const DURABILITY = new Set(['evidenceSha256','evidenceState','certificationResult','artifactPath']);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function evidenceReadOnlyStatus(dir = '/root/irexpro-live-cert-evidence', options = {}) {
  const runId = options.runId || RUN_ID;
  const expectedSha = options.expectedSha || EXPECTED_SHA;
  const originalPrefix = 'live-certification-pepperstone-ctrader-' + runId + '-';
  const auditPrefix = 'historical-live-canary-order-audit-' + runId + '-';
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { status:'NOT_FOUND', reason:'EVIDENCE_DIRECTORY_UNAVAILABLE' };
  }
  const originalFiles = names.filter(x => x.startsWith(originalPrefix) && x.endsWith('.json'));
  const auditFiles = names.filter(x => x.startsWith(auditPrefix) && x.endsWith('.json'));
  if (originalFiles.length===0 || auditFiles.length===0)
    return { status:'NOT_FOUND', reason:'CERTIFICATION_OR_INDEPENDENT_BROKER_AUDIT_MISSING' };
  if (originalFiles.length!==1 || auditFiles.length!==1)
    return { status:'INVALID', reason:'AMBIGUOUS_CERTIFICATION_OR_AUDIT_FILES' };

  try {
    const read = fileName => {
      const filePath=path.join(dir,fileName);
      const stat=fs.lstatSync(filePath);
      if (!stat.isFile() || stat.size>1024*1024 || stat.size===0) throw Error('INVALID_EVIDENCE_FILE');
      const raw=fs.readFileSync(filePath);
      return {filePath, raw, value:JSON.parse(raw.toString('utf8'))};
    };
    const original=read(originalFiles[0]);
    const audit=read(auditFiles[0]);
    const j=original.value;
    const a=audit.value;
    const canonical={};
    for (const [k,v] of Object.entries(j))
      if (!DURABILITY.has(k)) canonical[k]=v;
    const digest=sha256(JSON.stringify(canonical));
    const steps=j.steps||[];
    const stepMap=new Map(steps.map(x=>[x.name,x.status]));
    const valid =
      j.runId===runId && j.mode==='LIVE' &&
      j.brokerId==='pepperstone-ctrader' &&
      j.target?.brokerId==='pepperstone-ctrader' &&
      j.target?.accountIdMasked==='•••6270' &&
      j.evidenceState==='PERSISTED' && j.overall==='PASS' &&
      j.certificationResult==='PASS' &&
      j.evidenceSha256===expectedSha && digest===expectedSha &&
      j.artifactPath===original.filePath &&
      j.summary?.passed===15 && j.summary?.failed===0 &&
      j.summary?.skipped===1 && steps.length===16 &&
      PASSED_STAGES.every(x=>stepMap.get(x)==='PASS') &&
      stepMap.get('account-discovery')==='SKIPPED' &&
      j.canary?.instrument==='AUDUSD' &&
      j.canary?.actualSize==='0.01' && j.canary?.direction==='BUY' &&
      j.baselineExposure?.positions?.count===0 &&
      j.baselineExposure?.workingOrders?.count===0 &&
      j.postExposure?.positions?.count===0 &&
      j.postExposure?.workingOrders?.count===0 &&
      Number.isFinite(Date.parse(j.startedAt)) &&
      Number.isFinite(Date.parse(j.finishedAt)) &&
      Date.parse(j.finishedAt)>=Date.parse(j.startedAt) &&
      a.runId===runId &&
      a.originalEvidenceSha256===sha256(original.raw) &&
      a.originalCertificationResult==='PASS' &&
      a.auditStatus==='HISTORICAL_ORDER_ID_VERIFIED' &&
      a.historyProof?.status==='FOUND' &&
      a.historyProof?.openingDealId==='350035648' &&
      a.orderProof?.status==='VERIFIED' &&
      a.orderProof?.nativeOrderId===ORDER_ID &&
      a.orderProof?.providerPositionId===POSITION_ID &&
      a.orderProof?.filledQuantity==='0.01' &&
      a.currentExposure?.openPositions===0 &&
      a.currentExposure?.workingOrders===0 &&
      a.noBrokerOrderCalls===true && a.brokerWritesSent===false &&
      a.modifiesExistingCertification===false;
    if (!valid) return { status:'INVALID', reason:'CERTIFICATION_EVIDENCE_INTEGRITY_OR_IDENTITY_MISMATCH' };
    return {
      status:'ATTESTED_PASS_PENDING_RELEASE',
      runId,
      canonicalSha256:expectedSha,
      independentNativeOrderVerified:true,
      activeTradingAuthorityGranted:false,
    };
  } catch {
    return {status:'INVALID',reason:'CERTIFICATION_EVIDENCE_UNREADABLE'};
  }
}
module.exports = {evidenceReadOnlyStatus};
