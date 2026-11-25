'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classify,summarize}=require('./audit-owner-demo-postclose-maturity.cjs');
const asOf='2026-11-20T11:10:00.000Z';
function sample(t={},q={}){
  return {status:'CLOSED',closeReason:'PROFIT_PROTECTION',
    instrument:'USDJPY',openedAt:'2026-11-20T09:50:00.000Z',closedAt:'2026-11-20T10:00:00.000Z',
    afterCloseOriginalBarriers:{pathCoverage:'CONTIGUOUS_SAMPLED_PATH',
      firstQuoteAt:'2026-11-20T10:00:02.000Z',lastQuoteAt:'2026-11-20T11:09:59.000Z',
      firstTargetAt:null,firstStopAt:null,...q},...t};
}
test('later target is not counted in earlier window',()=>{
  const t=sample({}, {firstTargetAt:'2026-11-20T10:35:00.000Z'});
  assert.equal(classify(t,30,asOf),'NEITHER_WITHIN_HORIZON');
  assert.equal(classify(t,60,asOf),'TP_FIRST_SAMPLED');
});
test('earlier stop wins even if target is hit later',()=>{
  const t=sample({}, {firstStopAt:'2026-11-20T10:09:00.000Z',
    firstTargetAt:'2026-11-20T10:14:00.000Z'});
  assert.equal(classify(t,15,asOf),'SL_FIRST_SAMPLED');
});
test('immature observation remains censored',()=>{
  const t=sample({closedAt:'2026-11-20T10:45:00.000Z'});
  assert.equal(classify(t,30,asOf),'NOT_MATURE');
});
test('quote gaps never become target proof',()=>{
  const t=sample({}, {pathCoverage:'INCOMPLETE_SAMPLED_PATH',
    firstTargetAt:'2026-11-20T10:04:00.000Z'});
  assert.equal(classify(t,5,asOf),'INCOMPLETE_QUOTE_COVERAGE');
});
test('simultaneous target/stop observation is ambiguous',()=>{
  const t=sample({}, {firstStopAt:'2026-11-20T10:02:00.000Z',
    firstTargetAt:'2026-11-20T10:02:00.000Z'});
  assert.equal(classify(t,5,asOf),'AMBIGUOUS_SAME_SAMPLE');
});
test('unsettled observations not counted in mature results',()=>{
  assert.equal(classify(sample({status:'OPEN',closedAt:null}),5,asOf),'OPEN');
});
test('owner demo input and read-only scope are mandatory',()=>{
  const x={artifact:'irexpro-owner-pepperstone-usd-demo-20261120-0430-tp-first-readonly-v1',
    researchOnly:true,brokerOrders:false,asOf,trades:[sample()]};
  const result=summarize(x);
  assert.equal(result.modifiesExecution,false);
  assert.equal(result.byCloseReason.PROFIT_PROTECTION['30m'].NEITHER_WITHIN_HORIZON,1);
  assert.throws(()=>summarize({...x,brokerOrders:true}),/SOURCE_SCOPE_INVALID/);
});
test('rollout cohorts use entry and settlement timestamps, excluding straddlers',()=>{
  const x={artifact:'irexpro-owner-pepperstone-usd-demo-20261120-0430-tp-first-readonly-v1',
    researchOnly:true,brokerOrders:false,asOf,trades:[
      sample(),sample({openedAt:'2026-11-20T09:10:00.000Z'}),
      sample({openedAt:'2026-11-20T08:10:00.000Z',closedAt:'2026-11-20T09:20:00.000Z'})]};
  const r=summarize(x).byProfitProtectionRollout;
  assert.equal(r.AFTER['15m'].total,1);
  assert.equal(r.BEFORE['15m'].total,1);
  assert.equal(r.STRADDLED_EXCLUDED['15m'].total,1);
});

test('original sampled TP may lose precedence under latest recorded barriers',()=>{
  const now='2026-11-20T11:10:00.000Z';
  const orig={firstTargetAt:'2026-11-20T10:11:00.000Z'};
  const last={pathCoverage:'CONTIGUOUS_SAMPLED_PATH',
    firstQuoteAt:'2026-11-20T10:00:02.000Z',
    lastQuoteAt:'2026-11-20T11:09:59.000Z',
    firstTargetAt:'2026-11-20T10:16:00.000Z',
    firstStopAt:'2026-11-20T10:07:00.000Z'};
  const a=sample({originalTp:150,originalSl:100,lastRecordedTp:155,lastRecordedSl:105,
    afterCloseLastRecordedBarriers:last},orig);
  const b=sample({originalTp:150,originalSl:100,lastRecordedTp:155,lastRecordedSl:105,
    afterCloseLastRecordedBarriers:{...last,firstTargetAt:'2026-11-20T10:12:00.000Z',firstStopAt:null}},orig);
  const c=sample({originalTp:150,originalSl:100,lastRecordedTp:155,lastRecordedSl:105},orig);
  assert.equal(classify(a,30,now),'TP_FIRST_SAMPLED');
  assert.equal(classify(a,30,now,'LAST_RECORDED'),'SL_FIRST_SAMPLED');
  assert.throws(()=>classify(a,30,now,'BAD'),/INVALID_BARRIER_SOURCE/);
  const result=summarize({artifact:'irexpro-owner-pepperstone-usd-demo-20261120-0430-tp-first-readonly-v1',
    researchOnly:true,brokerOrders:false,asOf:now,trades:[a,b,c]});
  const comp=result.protectedOriginalVsLastRecorded['30m'];
  assert.equal(comp.originalTargetFirst,3);
  assert.equal(comp.bothTargetFirst,1);
  assert.equal(comp.lastRecordedStopFirstAfterOriginalTarget,1);
  assert.equal(comp.lastRecordedUnknownAfterOriginalTarget,1);
  assert.equal(comp.changedRecordedBarrierCount,3);
  assert.equal(result.protectedLastRecordedBarriers['30m'].TP_FIRST_SAMPLED,1);
  assert.equal(result.protectedLastRecordedBarriers['30m'].SL_FIRST_SAMPLED,1);
  assert.equal(result.protectedLastRecordedBarriers['30m'].INCOMPLETE_QUOTE_COVERAGE,1);
  assert.equal(result.ordersSent,0);
});
