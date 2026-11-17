'use strict';
const t=require('node:test'),assert=require('node:assert/strict');
const {
 ARTIFACT,SNAP_ARTIFACT,qualifySnapshot,outcome,summarize,assessResearchTrainingReadiness,
}=require('./research-owner-demo-m5-quote-context-readiness.cjs');
const base=Date.parse('2026-11-17T18:00:00Z');
const iso=n=>new Date(n).toISOString();
function snapshot(instrument='EURUSD'){
 const d=base+315000,c=base+319000;
 const prior={open:1.1000,high:1.1002,low:1.0999,close:1.1001};
 const bid=1.10029,ask=1.10031,mid=(bid+ask)/2;
 return {
  artifact:SNAP_ARTIFACT,instrument,timeframe:'M5',
  priorBarStart:iso(base),priorBarEnd:iso(base+300000),
  decisionAt:iso(d),capturedAt:iso(c),
  quoteOHLC:prior,quotePathSampleCount:120,minuteCoverage:5,
  firstSourceObservedAt:iso(base+2000),
  lastSourceObservedAt:iso(base+299000),
  currentQuoteAsOf:{bid,ask,mid,spread:ask-bid,
    sourceAt:iso(d-6000),observedAt:iso(d-5000),
    samplesWithinFirst15Seconds:3,
    midVsPreviousQuoteM5Close:mid-prior.close},
  provenance:'IMMUTABLE_POSITIVE_NATIVE_BIDASK_ASOF',
  priceRepresentation:'SAMPLED_MIDQUOTE_NOT_NATIVE_M5_OHLC',
  fullTickOhlc:false,noNativeM5Read:true,noFutureCandleInfo:true,
  labelKnown:false,brokerOrderAuthority:false,
  modifiesExecution:false,researchOnly:true,
 };
}
function candle(instrument='EURUSD'){
 return {instrument,timeframe:'M5',source:'ctrader-broker-native',
 bucket_time:iso(base+300000),created_at:iso(base+370000),
 updated_at:iso(base+600000),sample_count:105,
 open:1.1003,high:1.10065,low:1.1002,close:1.1005};
}
const auditAt=iso(base+300000+300000+15*60000+15000);
t('accepts real as-of quote context before next M5 outcome is known',()=>{
 const x=qualifySnapshot(snapshot());
 assert.equal(x.status,'ASOF_VERIFIED');
 assert.equal(x.barStart,iso(base+300000));
 assert.ok(x.previousQuoteBodyPips>.9);
 assert.ok(x.liveMidDeltaFromPriorClosePips>1.9);
});
t('refuses future or delayed current bidask and fabricated as-of delta',()=>{
 const s=snapshot();s.currentQuoteAsOf.observedAt=iso(base+317000);
 assert.equal(qualifySnapshot(s).status,'INVALID_CURRENT_BROKER_QUOTE');
 const q=snapshot();q.currentQuoteAsOf.midVsPreviousQuoteM5Close+=.0005;
 assert.equal(qualifySnapshot(q).status,'INVALID_CURRENT_BROKER_QUOTE');
 const r=snapshot();r.capturedAt=iso(base+333000);
 assert.equal(qualifySnapshot(r).status,'INVALID_ASOF_TIMELINE');
});
t('old v1 snapshots cannot silently masquerade as the v2 training format',()=>{
 const s=snapshot();s.artifact='irexpro-prospective-asof-quoted-m5-context-v1';
 assert.equal(qualifySnapshot(s).status,'UNTRUSTED_ASOF_SNAPSHOT');
});
t('matures only after bar closed plus explicit 15 minute broker delay',()=>{
 const p=snapshot();
 assert.equal(outcome(p,candle(),iso(base+300000+300000+14*60000)).status,
 'NATIVE_LABEL_NOT_MATURE');
 const mature=outcome(p,candle(),auditAt);
 assert.equal(mature.status,'MATURED_RESEARCH_LABEL');
 assert.equal(mature.label,'GREEN_OR_UP');
 assert.equal(mature.previousBaselineCorrect,true);
 assert.equal(mature.earlyBaselineCorrect,true);
 assert.equal(mature.roundTripCommissionIncluded,false);
 assert.equal(mature.actualTradingPnlKnown,false);
 assert.equal(mature.promotionAllowed,false);
});
t('rejects wrong source, duplicate timeframe or future-claimed native labels',()=>{
 const a=candle();a.source='some-other-source';
 assert.equal(outcome(snapshot(),a,auditAt).status,'UNVERIFIED_NATIVE_M5_OUTCOME');
 const b=candle();b.bucket_time=iso(base);
 assert.equal(outcome(snapshot(),b,auditAt).status,'UNVERIFIED_NATIVE_M5_OUTCOME');
 const c=candle();c.updated_at=iso(Date.parse(auditAt)+1000);
 assert.equal(outcome(snapshot(),c,auditAt).status,'UNVERIFIED_NATIVE_M5_OUTCOME');
});
t('different symbols and future body direction distinguish baseline results',()=>{
 const s=snapshot('AUDUSD'),c=candle('AUDUSD');c.close=1.10005;
 c.low=1.1000;
 const r=outcome(s,c,auditAt);
 assert.equal(r.status,'MATURED_RESEARCH_LABEL');
 assert.equal(r.label,'RED_OR_DOWN');
 assert.equal(r.previousBaselineCorrect,false);
 assert.equal(r.earlyBaselineCorrect,false);
});
t('summarizes distinct market periods and does not promote 2 dates or 1 slot',()=>{
 const a=snapshot('EURUSD'),b=snapshot('AUDUSD');
 const now=auditAt;
 const r=summarize([a,b],[candle('EURUSD'),candle('AUDUSD')],now);
 assert.equal(r.validMaturedLabels,2);
 assert.equal(r.distinctMaturedMarketSlots,1);
 assert.equal(r.distinctMaturedUtcDays,1);
 assert.equal(r.modelTrainingReadiness.ready,false);
 assert.equal(r.perInstrument.EURUSD.total,1);
 assert.equal(r.earlyCurrentQuoteBaselineAccuracy,1);
 assert.equal(r.researchOnly,true);
 assert.equal(r.brokerOrderAuthority,false);
 assert.equal(r.labeledRows.length,2);
});
t('repeated file rows are rejected as duplicate snapshots, not many independent signals',()=>{
 const a=snapshot();
 const r=summarize([a,a],[candle()],auditAt);
 assert.equal(r.validMaturedLabels,1);
 assert.equal(r.excluded.DUPLICATE_SNAPSHOT,1);
});
t('missing and pending outcomes are distinct from losses',()=>{
 const a=snapshot('EURUSD'),b=snapshot('USDJPY');
 const r=summarize([a,b],[],auditAt);
 assert.equal(r.validMaturedLabels,0);
 assert.equal(r.excluded.NATIVE_M5_OUTCOME_MISSING,2);
 assert.equal(r.earlyCurrentQuoteBaselineAccuracy,null);
 const pending=summarize([a],[],iso(base+320000));
 assert.equal(pending.pendingOutcomeMaturation,1);
 assert.equal(pending.excluded.NATIVE_M5_OUTCOME_MISSING,undefined);
});
t('duplicate native broker reference rows fail rather than select the profitable outcome',()=>{
 const s=snapshot(),bar=candle();
 assert.throws(()=>summarize([s],[bar,bar],auditAt),/DUPLICATE_NATIVE_M5_LABEL/);
});
t('data readiness becomes true only with broad history, not automatic broker authorization',()=>{
 const small=assessResearchTrainingReadiness(20,1000,
   {EURUSD:{total:199},AUDUSD:{total:400},USDJPY:{total:400},USDCAD:{total:400}});
 assert.equal(small.ready,false);
 assert.equal(small.checks.everyInstrument,false);
 const broad=assessResearchTrainingReadiness(21,1010,
   {EURUSD:{total:260},AUDUSD:{total:250},USDJPY:{total:240},USDCAD:{total:230}});
 assert.equal(broad.ready,true);
 assert.equal(broad.autoModelPromotion,false);
 assert.equal(broad.afterCommissionProfitabilityProven,false);
 assert.equal(broad.autoBrokerExecution,false);
});
t('research audit cannot submit broker trades or update trade tables',()=>{
 const fs=require('fs'),src=fs.readFileSync(__filename.replace('.test.cjs','.cjs'),'utf8');
 assert.match(src,/researchOnly:true/);
 assert.doesNotMatch(src,/\b(?:placeOrder|executeTrade|closePosition|UPDATE\s+trading)\s*\(/);
 assert.equal(ARTIFACT,'irexpro-owner-demo-m5-quote-context-readiness-v1');
});
