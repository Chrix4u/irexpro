'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CYCLE,classify,compact,inspectSnapshot,runAudit}
 =require('./watch-owner-demo-entry-blockers.cjs');
const at=Date.parse('2026-11-18T13:45:00Z');
const base={
 artifact:'owner-pepperstone-demo-entry-blockade-diagnostic-v1',
 generatedAt:'2026-11-18T13:44:00Z',
 latestDecisionAt:'2026-11-18T13:44:00Z',
 newTradeIntentsSinceLastClose:0,
 decisionsSinceLatestClosedTrade:776,
 selectedAlternativeEligibleSinceLastClose:17,
 selectedAlternativeBrakedSinceLastClose:16,
 independentlyComputedAccountBrake:{
  state:'CONFIRMED_THREE_LOSSES_120M_GUARD',
  latestClosedAt:'2026-11-18T12:05:33.982Z',
  potentialBrakeEndsAt:'2026-11-18T14:05:33.982Z',
  remainingSeconds:1234,
 },
};
test('poll cadence is research-only and bounded',()=>{
 assert.equal(CYCLE,90000);
 const out=compact(base,'VALID_PORTFOLIO_BRAKE_ACTIVE');
 assert.equal(out.changesRiskRules,false);
 assert.equal(out.changesLotSize,false);
 assert.equal(out.placesOrders,false);
 assert.equal(out.executionAuthority,'NONE');
});
test('reports real active global 120-minute brake',()=>{
 assert.equal(classify(base,at),'VALID_PORTFOLIO_BRAKE_ACTIVE');
});
test('owner advisory-only loss observation is not called an actual trading halt',()=>{
 const x={...base,latestOwnerPausePolicy:{
   advisoryOnly:true,portfolioLossStreakBlocks:false},
  eligibleAlternativeWithEffectivePortfolioVeto:1,
  selectedAlternativeBrakedSinceLastClose:0};
 assert.equal(classify(x,at),'OWNER_LOSS_STREAK_WARNING_ONLY');
 const status=compact(x,classify(x,at));
 assert.equal(status.ownerLossPauseAdvisoryOnly,true);
 assert.equal(status.effectivePortfolioVetoCount,1);
 // An earlier observed veto does not turn the CURRENT advisory session
 // back into a 120-minute mandatory pause.
 assert.equal(classify({...x,latestOwnerPausePolicy:{
  advisoryOnly:true,portfolioLossStreakBlocks:true}},at),
  'VALID_PORTFOLIO_BRAKE_ACTIVE');
});
test('after expiry, recognizes that a new trade is STILL absent',()=>{
 const x={...base,independentlyComputedAccountBrake:{
  ...base.independentlyComputedAccountBrake,
  state:'THREE_LOSSES_BUT_TIME_GATE_EXPIRED',remainingSeconds:0,
 }};
 assert.equal(classify(x,at),'PORTFOLIO_BRAKE_EXPIRED_NO_NEW_INTENT');
});
test('does not claim silent scanner when live decisions are present',()=>{
 assert.equal(classify({...base,latestDecisionAt:'2026-11-18T13:40:00Z'},
  at),'VALID_PORTFOLIO_BRAKE_ACTIVE');
 assert.equal(classify({...base,latestDecisionAt:'2026-11-18T13:38:00Z'},
  at),'NO_RECENT_SCANNER_DECISIONS');
});
test('a genuinely new intent is distinct from a scan or model quote',()=>{
 const x={...base,newTradeIntentsSinceLastClose:1,
  independentlyComputedAccountBrake:{
   ...base.independentlyComputedAccountBrake,
   state:'THREE_LOSSES_BUT_TIME_GATE_EXPIRED',remainingSeconds:0,
  }};
 assert.equal(classify(x,at),'NEW_DEMO_INTENT_SUBMITTED');
});
test('degraded model state is not represented as a broker connectivity failure',()=>{
 const x={...base,independentlyComputedAccountBrake:{
  ...base.independentlyComputedAccountBrake,
  state:'THREE_LOSSES_BUT_TIME_GATE_EXPIRED',remainingSeconds:0,
 },selectedAlternativeEligibleSinceLastClose:0};
 assert.equal(classify(x,at),'PORTFOLIO_BRAKE_EXPIRED_NO_NEW_INTENT');
 const y={...x,independentlyComputedAccountBrake:{
  ...x.independentlyComputedAccountBrake,
  state:'LAST_THREE_NOT_ALL_LOSSES',remainingSeconds:0,
 }};
 assert.equal(classify(y,at),'NO_RECENT_ELIGIBLE_ALTERNATE');
});
test('owner-only private report can be read without changing trade state',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-scan-status-'));
 try{
  const file=path.join(dir,'snapshot.json');
  fs.writeFileSync(file,JSON.stringify(base),{mode:0o600});
  const s=inspectSnapshot(file,at);
  assert.equal(s.eligibleAlternatesSinceLastClose,17);
  assert.equal(s.brakedAlternatesSinceLastClose,16);
  assert.equal(s.expectedBrakeExpiresAt,'2026-11-18T14:05:33.982Z');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('no false success when child research job fails',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-scan-child-'));
 try{
  const file=path.join(dir,'failed.cjs');
  fs.writeFileSync(file,'process.exit(8)');
  await assert.rejects(runAudit({script:file,timeout:1500}),/DIAGNOSTIC_FAILED/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
