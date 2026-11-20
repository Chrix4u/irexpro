'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {
 ARTIFACT,SOURCE,groupStatus,summarize,readJournal,writeSummary,
}=require('./audit-owner-demo-prospective-entry-outcomes.cjs');
const day='2026-11-18';
const time='2026-11-18T14:00:00Z';
const key='d4178321-0a9a-4c31-9ad7-ff8de2a12eef';
const entry=(id=key)=>({artifact:SOURCE,tradeKey:id,stage:'ENTRY',
 capturedAt:'2026-11-18T14:00:20Z',openedAt:time,intentAt:'2026-11-18T13:59:58Z',
 route:'EARLY_TRANSITION',expectedNetR:0.28,capitalAllocationRiskUsd:100,
 originalPlannedEntry:1.1,causalPreIntentQuote:{status:'FRESH_ASOF_BROKER_QUOTE'},
});
const checkpoint=(state='DEFERRED_ENTRY_RESEARCH_CANDIDATE',id=key)=>({
 artifact:SOURCE,tradeKey:id,stage:'CHECKPOINT_60S',
 capturedAt:'2026-11-18T14:01:13Z',
 checkpoint:{state,artifact:'research-only'},
});
const settled=(net=-80,id=key)=>({
 artifact:SOURCE,tradeKey:id,stage:'SETTLED',
 capturedAt:'2026-11-18T14:08:00Z',settledNetUsd:net,
 grossUsd:net+10,commissionUsd:-10,swapUsd:0,
});
const mark=(after=false,id=key)=>({
 artifact:SOURCE,tradeKey:id,stage:'MARK_3M',
 capturedAt:'2026-11-18T14:03:12Z',
 actualTradeWasClosedBeforeMarketMark:after,
 observation:{status:'SAMPLED_MARK_ONLY',
  afterActualExit:after,alignedPipsFromBrokerEntry:1.2},
});
const marker={activatedAt:'2026-11-18T13:59:00Z',artifact:SOURCE};
test('zero future trades is insufficient evidence, never an implied winning model',()=>{
 const r=summarize([],marker,Date.parse(time));
 assert.equal(r.capturedEntries,0);
 assert.equal(r.settledTrades,0);
 assert.equal(r.settledNetUsd,0);
 assert.equal(r.prospectiveQualification,'NOT_QUALIFIED');
 assert.equal(r.livePromotionAuthorized,false);
 assert.equal(r.modifiesExecution,false);
 assert.equal(r.modifiesLotSize,false);
 assert.equal(r.artifact,ARTIFACT);
});
test('frozen pre-entry checkpoint groups only ACTUAL original settled P&L',()=>{
 const r=summarize([entry(),checkpoint(),mark(),settled()],marker,Date.parse('2026-11-18T14:09:00Z'));
 assert.equal(r.capturedEntries,1);
 assert.equal(r.settledTrades,1);
 assert.equal(r.settledNetUsd,-80);
 assert.equal(r.settledTradingDates,1);
 const c=r.byFrozen60sDecision.DEFERRED_ENTRY_RESEARCH_CANDIDATE;
 assert.equal(c.enrolled,1);
 assert.equal(c.settled,1);
 assert.equal(c.actualNetUsd,-80);
 assert.equal(c.submittedMeanNetR,.28);
 assert.equal(c.actualMeanNetR,-.8);
 assert.equal(r.byMarketObservationHorizon['3m'].whileOriginalPositionOpen,1);
 assert.equal(r.byMarketObservationHorizon['3m'].favorableWhileOriginalOpen,1);
 assert.equal(r.byMarketObservationHorizon['20m'].stagesObserved,0);
 assert.equal(r.byMarketObservationHorizon['30m'].stagesObserved,0);
});
test('after-close quote marks stay censored from within-position outcome',()=>{
 const r=summarize([entry(),checkpoint(),mark(true),settled()],marker,Date.parse('2026-11-18T14:09:00Z'));
 assert.equal(r.byMarketObservationHorizon['3m'].afterOriginalPositionClosedCensored,1);
 assert.equal(r.byMarketObservationHorizon['3m'].favorableWhileOriginalOpen,0);
 assert.equal(r.byMarketObservationHorizon['3m'].whileOriginalPositionOpen,0);
});
test('no on-time entry or decision cannot be backfilled as prospective profit',()=>{
 const bad={artifact:SOURCE,tradeKey:'abc',stage:'ENTRY_MISSED',
  capturedAt:'2026-11-18T14:04:00Z'};
 const r=summarize([bad,entry(),settled()],marker,Date.parse('2026-11-18T14:09:00Z'));
 assert.equal(r.firstEntryMissed,1);
 assert.equal(r.capturedEntries,1);
 assert.equal(r.byFrozen60sDecision.NO_ON_TIME_CHECKPOINT.enrolled,1);
});
test('duplicate stage events are counted and not double-booked',()=>{
 const r=summarize([entry(),entry(),checkpoint(),settled(),settled()],
  marker,Date.parse('2026-11-18T14:09:00Z'));
 assert.equal(r.duplicatedStageRowsIgnored,2);
 assert.equal(r.settledTrades,1);
 assert.equal(r.settledNetUsd,-80);
});
test('no owner trade IDs are emitted into summary content',()=>{
 const r=summarize([entry(),checkpoint(),settled()],marker,Date.parse('2026-11-18T14:09:00Z'));
 assert.equal(JSON.stringify(r).includes(key),false);
});
test('malformed entry timestamp is discarded and cannot count as model evidence',()=>{
 const bad={...entry(),capturedAt:'2026-11-18T14:04:00Z'};
 const r=summarize([bad,settled()],marker,Date.parse('2026-11-18T14:09:00Z'));
 assert.equal(r.capturedEntries,0);
 assert.equal(r.corruptOrUnusableEntryRecords,1);
 assert.equal(r.settledTrades,0);
});
test('summary reader is bounded, atomic and private, and rejects corrupt activation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-entry-report-'));
 try{
  fs.writeFileSync(path.join(dir,'activation.json'),JSON.stringify(marker),{mode:0o600});
  const data=[entry(),checkpoint(),mark(),settled()].map(x=>JSON.stringify(x)).join('\n')+'\n';
  fs.writeFileSync(path.join(dir,day+'.jsonl'),data,{mode:0o600});
  assert.equal(readJournal(dir,Date.parse('2026-11-18T14:09:00Z')).events.length,4);
  const r=writeSummary(dir,Date.parse('2026-11-18T14:09:00Z'));
  assert.equal(r.settledNetUsd,-80);
  const p=path.join(dir,'latest-summary.json');
  assert.equal(fs.statSync(p).mode&0o777,0o600);
  assert.equal(JSON.parse(fs.readFileSync(p,'utf8')).capturedEntries,1);
  fs.writeFileSync(path.join(dir,'activation.json'),JSON.stringify({...marker,artifact:'unknown'}));
  assert.throws(()=>writeSummary(dir,Date.parse('2026-11-18T14:09:00Z')),
   /UNTRUSTED/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('different original routes group independently without changing lots',()=>{
 const second='a617d643-4d4c-4ad7-a467-11f517d11e37';
 const rows=[entry(),checkpoint(),settled(),
  {...entry(second),route:'CONFIRMED_REVERSAL'},checkpoint('WAIT_M5_OPPOSES',second),
  settled(50,second)];
 const r=summarize(rows,marker,Date.parse('2026-11-18T14:09:00Z'));
 assert.equal(r.byOriginalEntryRoute.EARLY_TRANSITION.bookedNetUsd,-80);
 assert.equal(r.byOriginalEntryRoute.CONFIRMED_REVERSAL.bookedNetUsd,50);
 assert.equal(r.settledNetUsd,-30);
 assert.equal(r.byFrozen60sDecision.WAIT_M5_OPPOSES.netWinners,1);
 assert.equal(r.modifiesLotSize,false);
});
