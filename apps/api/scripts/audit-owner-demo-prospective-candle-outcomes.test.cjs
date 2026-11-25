'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {
 ARTIFACT,safePrediction,key,expectedNextBucket,previousContinuationBaseline,outcome,summarize,loadPredictions,
}=require('./audit-owner-demo-prospective-candle-outcomes.cjs');
const p=(frame='M1',stage=45,instrument='EURUSD')=>{
 const start='2026-11-17T17:05:00.000Z';
 const when=new Date(Date.parse(start)+stage*1000).toISOString();
 return {
  artifact:'irexpro-owner-demo-prospective-candle-shadow-v1',
  instrument,timeframe:frame,barStart:start,decisionAt:when,
  predictedNextCandleClass:'GREEN_OR_UP',confidence:.69,
  rawUncalibratedProbabilities:{
   RED_OR_DOWN:.15,COST_SMALL_OR_FLAT:.16,GREEN_OR_UP:.69,
  },
  forecastWrittenAt:new Date(Date.parse(when)+5000).toISOString(),
  snapshotAgeSeconds:5,
  observedSpreadPrice:0.00002,causalAtrPrice:0.0003,
  modelTrainedAt:'2026-11-17T16:39:53.000Z',
  researchOnly:true,modifiesExecution:false,
  brokerOrderAuthority:false,nextCandleOutcomeKnown:false,afterCostPnlKnown:false,
 };
};
const c=(f='M1',start='2026-11-17T17:06:00.000Z',open=1.1000,close=1.10009)=>({
 instrument:'EURUSD',timeframe:f,bucket_time:start,source:'ctrader-broker-native',
 open,high:Math.max(open,close)+.00003,low:Math.min(open,close)-.00004,close,
 sample_count:15,positive_quote_sample_count:8,
});
test('only authenticated prospective and fixed-stage forecasts can be evaluated',()=>{
 assert.equal(safePrediction(p()),true);
 for(const v of [{brokerOrderAuthority:true},{modifiesExecution:true},
   {afterCostPnlKnown:true},{nextCandleOutcomeKnown:true},
   {timeframe:'M15'},{instrument:'GBPUSD'},{confidence:1.5},
   {modelTrainedAt:'2026-11-17T17:06:00Z'}]){
   assert.equal(safePrediction({...p(),...v}),false);
 }
});
test('rejects rewritten forecasts saved after bar close or inconsistent probabilities',()=>{
 const a=p();
 assert.equal(safePrediction({...a,forecastWrittenAt:'2026-11-17T17:06:10Z'}),false);
 assert.equal(safePrediction({...a,forecastWrittenAt:'2026-11-17T17:05:46Z'}),false);
 assert.equal(safePrediction({...a,snapshotAgeSeconds:8}),false);
 assert.equal(safePrediction({...a,rawUncalibratedProbabilities:{...a.rawUncalibratedProbabilities,GREEN_OR_UP:.99}}),false);
 assert.equal(safePrediction({...a,confidence:.82}),false);
 assert.equal(safePrediction({...a,predictedNextCandleClass:'RED_OR_DOWN'}),false);
});
test('next native candle is matched by exact timeframe, instrument and bucket',()=>{
 const a=p();
 assert.equal(expectedNextBucket(a),Date.parse('2026-11-17T17:06:00Z'));
 const result=outcome(a,c(),Date.parse('2026-11-17T17:07:45Z'));
 assert.equal(result.status,'MATCHED_COMPLETED_NEXT_CANDLE');
 assert.equal(result.actualNextClass,'GREEN_OR_UP');
 assert.equal(result.forecastCorrect,true);
 assert.ok(result.spreadOnlyPriceMoveAtr>0);
 assert.equal(result.commissionUnmodeled,true);
 assert.equal(result.notBrokerExecuted,true);
 assert.equal(result.actualGrossPnlUnknown,true);
});
test('the following candle must mature; no future partial OHLC can count',()=>{
 assert.equal(outcome(p(),c(),Date.parse('2026-11-17T17:06:22Z')).status,'NOT_YET_MATURED');
 assert.equal(outcome(p(),c(),Date.parse('2026-11-17T17:06:59Z')).status,'NOT_YET_MATURED');
 assert.equal(outcome(p(),c(),Date.parse('2026-11-17T17:07:32Z')).status,'MATCHED_COMPLETED_NEXT_CANDLE');
});
test('M5 requires the next five-minute bar to close and never fabricates no-bidask fills',()=>{
 const a={...p('M5',285),barStart:'2026-11-17T17:05:00Z',
  decisionAt:'2026-11-17T17:09:45.000Z'};
 const n=c('M5','2026-11-17T17:10:00.000Z',1.1000,1.10005);
 n.positive_quote_sample_count=0;
 assert.equal(outcome(a,n,Date.parse('2026-11-17T17:14:59Z')).status,'NOT_YET_MATURED');
 const z=outcome(a,n,Date.parse('2026-11-17T17:15:33Z'));
 assert.equal(z.status,'MATCHED_COMPLETED_NEXT_CANDLE');
 assert.equal(z.forecastCorrect,true);
 assert.equal(z.commissionUnmodeled,true);
});
test('missing native bar, wrong symbol and invalid quote coverage are never wins',()=>{
 const a=p(),now=Date.parse('2026-11-17T17:10:00Z');
 assert.equal(outcome(a,null,now).status,'MISSING_NATIVE_COMPLETED_OUTCOME');
 assert.equal(outcome(a,{...c(),instrument:'GBPUSD'},now).status,'MISSING_NATIVE_COMPLETED_OUTCOME');
 assert.equal(outcome(a,{...c(),positive_quote_sample_count:1},now).status,'MISSING_NATIVE_COMPLETED_OUTCOME');
 assert.equal(outcome(a,{...c(),close:0},now).status,'INVALID_NATIVE_CANDLE_GEOMETRY');
});
test('spread and 0.05 ATR are conservative labels, not profit certification',()=>{
 const a=p(),now=Date.parse('2026-11-17T17:10:00Z');
 assert.equal(outcome(a,c('M1',undefined,1.1,1.100005),now).actualNextClass,'COST_SMALL_OR_FLAT');
 const z=outcome({...a,observedSpreadPrice:.0001},c(),now);
 assert.equal(z.actualNextClass,'COST_SMALL_OR_FLAT');
 assert.equal(z.forecastCorrect,false);
});
test('previous completed candle provides a causal continuation baseline on identical episodes',()=>{
 const forecast=p(),native=c();
 const prior=c('M1','2026-11-17T17:04:00.000Z',1.1000,1.10007);
 const actual=outcome(forecast,native,Date.parse('2026-11-17T17:10:00Z'),prior);
 assert.equal(previousContinuationBaseline(forecast,prior),'GREEN_OR_UP');
 assert.equal(actual.status,'MATCHED_COMPLETED_NEXT_CANDLE');
 assert.equal(actual.baselineComparable,true);
 assert.equal(actual.baselineCorrect,true);
 const g=summarize([{p:forecast,result:actual}],new Date('2026-11-17T17:10:00Z'))
  .byFixedStageInstrument['M1|at_45s|EURUSD'];
 assert.equal(g.priorCandleBaselineComparable,1);
 assert.equal(g.priorCandleBaselineCorrect,1);
 assert.equal(g.priorCandleBaselineAccuracy,1);
 assert.equal(g.sameSampleModelAccuracy,1);
});
test('missing or future previous candle is excluded, never treated as a losing baseline',()=>{
 const forecast=p();
 const next=c();
 const future=c('M1','2026-11-17T17:05:00.000Z');
 assert.equal(previousContinuationBaseline(forecast,future),null);
 const a=outcome(forecast,next,Date.parse('2026-11-17T17:10:00Z'),future);
 assert.equal(a.baselineComparable,false);
 const g=summarize([{p:forecast,result:a}],new Date('2026-11-17T17:10:00Z'))
  .byFixedStageInstrument['M1|at_45s|EURUSD'];
 assert.equal(g.priorCandleBaselineComparable,0);
 assert.equal(g.priorCandleBaselineAccuracy,null);
 assert.equal(g.sameSampleModelAccuracy,null);
 const missing=c('M1','2026-11-17T17:04:00.000Z');
 missing.positive_quote_sample_count=0;
 assert.equal(previousContinuationBaseline(forecast,missing),null);
});
test('paired model and prior continuation baseline are evaluated on exactly same valid bars',()=>{
 const first=p();
 const second={...p('M1',15),
   predictedNextCandleClass:'RED_OR_DOWN',
   rawUncalibratedProbabilities:{
     RED_OR_DOWN:.69,COST_SMALL_OR_FLAT:.16,GREEN_OR_UP:.15,
   }};
 const lastBar=c('M1','2026-11-17T17:04:00.000Z',1.10005,1.1000);
 const forward=c();
 const a=outcome(first,forward,Date.parse('2026-11-17T17:10:00Z'),lastBar);
 const b=outcome(second,forward,Date.parse('2026-11-17T17:10:00Z'),null);
 const grouped=summarize([{p:first,result:a},{p:second,result:b}],
     new Date('2026-11-17T17:10:00Z')).byFixedStageInstrument;
 const withBaseline=grouped['M1|at_45s|EURUSD'];
 assert.equal(withBaseline.priorCandleBaselineComparable,1);
 assert.equal(withBaseline.priorCandleBaselineCorrect,0);
 assert.equal(withBaseline.sameSampleModelAccuracy,1);
 const without=grouped['M1|at_15s|EURUSD'];
 assert.equal(without.priorCandleBaselineComparable,0);
 assert.equal(without.sameSampleModelAccuracy,null);
});
test('missing or pending predictions are not averaged into success rates',()=>{
 const a=p(),b=p('M1',15,'USDJPY');
 const rows=[
  {p:a,result:outcome(a,c(),Date.parse('2026-11-17T17:10:00Z'))},
  {p:b,result:{status:'NOT_YET_MATURED'}},
  {p:p('M5',15),result:{status:'MISSING_NATIVE_COMPLETED_OUTCOME'}},
 ];
 const s=summarize(rows,new Date('2026-11-17T17:11:00Z'));
 assert.equal(s.matchedCompleted,1);
 assert.equal(s.pendingOutcomes,1);
 assert.equal(s.missingNativeOutcome,1);
 assert.equal(s.byFixedStageInstrument['M1|at_45s|EURUSD'].independentForecasts,1);
 assert.equal(s.promotionAllowed,false);
 assert.equal(s.modifiesExecution,false);
});
test('duplicate persisted forecast cannot inflate observed accuracy',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irexpro-prospective-audit-'));
 try{
  const row=p(),f=path.join(dir,'2026-11-17.jsonl');
  fs.writeFileSync(f,JSON.stringify(row)+'\n'+JSON.stringify(row)+'\n');
  assert.throws(()=>loadPredictions(dir,new Date('2026-11-17T19:00:00Z')),/DUPLICATE/);
  fs.writeFileSync(f,JSON.stringify(row)+'\n');
  assert.equal(loadPredictions(dir,new Date('2026-11-17T19:00:00Z')).length,1);
  assert.equal(key(row),key(loadPredictions(dir,new Date('2026-11-17T19:00:00Z'))[0]));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('fixed-stage global comparison pairs equal episodes and exposes shared USD market clock',()=>{
 const u=p('M1',45,'EURUSD'),v=p('M1',45,'AUDUSD');
 const uNext=c(),vNext={...c(),instrument:'AUDUSD',close:1.09990,low:1.09986};
 const uPrior=c('M1','2026-11-17T17:04:00.000Z',1.10006,1.1000);
 const vPrior={...c('M1','2026-11-17T17:04:00.000Z',1.10006,1.1000),instrument:'AUDUSD'};
 const now=Date.parse('2026-11-17T17:10:00Z');
 const a=outcome(u,uNext,now,uPrior);
 const b=outcome(v,vNext,now,vPrior);
 // EURUSD: AI correct, prior-candle continuation wrong.
 assert.equal(a.forecastCorrect,true);
 assert.equal(a.baselineCorrect,false);
 // AUDUSD: AI wrong, earlier candle baseline correct.
 assert.equal(b.forecastCorrect,false);
 assert.equal(b.baselineCorrect,true);
 const z=summarize([{p:u,result:a},{p:v,result:b}],new Date(now));
 const g=z.byFixedStageAcrossInstruments['M1|at_45s'];
 assert.equal(g.independentForecasts,2);
 assert.equal(g.distinctMarketTimeBuckets,1);
 assert.equal(g.distinctUtcTradingDays,1);
 assert.equal(g.priorCandleBaselineComparable,2);
 assert.equal(g.correct,1);
 assert.equal(g.modelOnlyCorrect,1);
 assert.equal(g.baselineOnlyCorrect,1);
 assert.equal(g.pairedDisagreementCount,2);
 assert.equal(g.pairedAccuracyDifference,0);
 assert.equal(g.accuracy,.5);
 assert.equal(g.priorCandleBaselineAccuracy,.5);
 assert.equal(g.sameSampleModelAccuracy,.5);
 assert.equal(z.promotionAllowed,false);
 assert.match(g.independenceWarning,/USD exposure/);
});
test('unavailable earlier candle does not inflate paired baseline denominator across pairs',()=>{
 const u=p('M1',45,'EURUSD'),v=p('M1',45,'AUDUSD');
 const now=Date.parse('2026-11-17T17:10:00Z');
 const q=c();
 const a=outcome(u,q,now,null);
 const b=outcome(v,{...q,instrument:'AUDUSD'},now,
   {...c('M1','2026-11-17T17:04:00.000Z'),instrument:'AUDUSD'});
 const g=summarize([{p:u,result:a},{p:v,result:b}],new Date(now))
   .byFixedStageAcrossInstruments['M1|at_45s'];
 assert.equal(g.independentForecasts,2);
 assert.equal(g.priorCandleBaselineComparable,1);
 assert.equal(g.sameSampleModelAccuracy,1);
 assert.equal(g.pairedAccuracyDifference,0);
});
test('direct summary rejects repeated persisted stage/candle forecast keys',()=>{
 const f=p();
 const r=outcome(f,c(),Date.parse('2026-11-17T17:10:00Z'));
 assert.throws(()=>summarize([{p:f,result:r},{p:f,result:r}],
   new Date('2026-11-17T17:10:00Z')),/DUPLICATE_MATURED_FORECAST_KEY/);
});
test('outcome auditor source has no trading or mutation methods',()=>{
 const body=fs.readFileSync(__filename.replace(/\.test\.cjs$/,'.cjs'),'utf8');
 assert.match(body,/BEGIN READ ONLY/);
 assert.doesNotMatch(body,/\b(?:placeOrder|executeTrade|closePosition|modifyPosition)\s*\(/);
 assert.doesNotMatch(body,/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|trading|broker)\b/i);
 assert.equal(ARTIFACT,'irexpro-owner-demo-forward-candle-outcome-audit-v1');
});
