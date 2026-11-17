'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {
 ARTIFACT,safePrediction,key,expectedNextBucket,outcome,summarize,loadPredictions,
}=require('./audit-owner-demo-prospective-candle-outcomes.cjs');
const p=(frame='M1',stage=45,instrument='EURUSD')=>{
 const start='2026-11-17T17:05:00.000Z';
 const when=new Date(Date.parse(start)+stage*1000).toISOString();
 return {
  artifact:'irexpro-owner-demo-prospective-candle-shadow-v1',
  instrument,timeframe:frame,barStart:start,decisionAt:when,
  predictedNextCandleClass:'GREEN_OR_UP',confidence:.69,
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
test('outcome auditor source has no trading or mutation methods',()=>{
 const body=fs.readFileSync(__filename.replace(/\.test\.cjs$/,'.cjs'),'utf8');
 assert.match(body,/BEGIN READ ONLY/);
 assert.doesNotMatch(body,/\b(?:placeOrder|executeTrade|closePosition|modifyPosition)\s*\(/);
 assert.doesNotMatch(body,/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|trading|broker)\b/i);
 assert.equal(ARTIFACT,'irexpro-owner-demo-forward-candle-outcome-audit-v1');
});
