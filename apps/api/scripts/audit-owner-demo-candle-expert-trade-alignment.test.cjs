'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ARTIFACT,isSafeForecast,latestPreIntent,summarize}=require('./audit-owner-demo-candle-expert-trade-alignment.cjs');
const start=Date.parse('2026-11-19T12:00:00Z');
const iso=x=>new Date(x).toISOString();
const forecast=(opts={})=>({
 artifact:'irexpro-owner-demo-prospective-candle-shadow-v1',
 instrument:'EURUSD',timeframe:'M1',barStart:iso(start),
 decisionAt:iso(start+15000),forecastWrittenAt:iso(start+20000),
 modelTrainedAt:iso(start-2*86400000),
 predictedNextCandleClass:'COST_SMALL_OR_FLAT',confidence:.8,
 rawUncalibratedProbabilities:{RED_OR_DOWN:.1,COST_SMALL_OR_FLAT:.8,GREEN_OR_UP:.1},
 snapshotAgeSeconds:5,
 researchOnly:true,brokerOrderAuthority:false,modifiesExecution:false,
 nextCandleOutcomeKnown:false,afterCostPnlKnown:false,
 ...opts
});
const trade=(opts={})=>({
 instrument:'EURUSD',direction:'BUY',route:'EARLY_TRANSITION',
 intent_at:iso(start+45000),opened_at:iso(start+46000),
 closed_at:iso(start+240000),lot_size:'1',
 realised_pnl:'-14',commission:'-3',swap:'0',...opts
});
test('strict causal provenance allows the original frozen M1 forecast',()=>{
 assert.equal(isSafeForecast(forecast()),true);
 for(const patch of [
  {forecastWrittenAt:iso(start+14000)},
  {forecastWrittenAt:iso(start+70000)},
  {decisionAt:iso(start+45000),forecastWrittenAt:iso(start+80000)},
  {brokerOrderAuthority:true},
  {modifiesExecution:true},
  {modelTrainedAt:iso(start+10000)},
  {timeframe:'M5'},
  {confidence:1.2},
  {nextCandleOutcomeKnown:true}
 ])assert.equal(isSafeForecast(forecast(patch)),false);
});
test('forecast chosen is only the latest persisted BEFORE trade intent',()=>{
 const list=[forecast(),forecast({decisionAt:iso(start+45000),forecastWrittenAt:iso(start+50000),confidence:.9})];
 assert.equal(latestPreIntent(list,start+45000).confidence,.8);
 assert.equal(latestPreIntent(list,start+55000).confidence,.9);
 assert.equal(latestPreIntent(list,start+500000),null);
});
test('disagreement that preceded the trade does not authorize a veto or invent profit',()=>{
 const a=trade({realised_pnl:'30'});
 const b=trade({direction:'SELL',route:'CONFIRMED_REVERSAL',realised_pnl:'-50'});
 const f=forecast({predictedNextCandleClass:'GREEN_OR_UP',confidence:.5});
 const r=summarize([a,b],new Map([['EURUSD',[f]]]));
 assert.equal(r.artifact,ARTIFACT);
 assert.equal(r.promotionAllowed,false);
 assert.equal(r.noExecutionAuthority,true);
 assert.equal(r.cohort.withForecast,2);
 assert.equal(r.byRoute.EARLY_TRANSITION.agreeingDirAt40.winners,1);
 assert.equal(r.byRoute.CONFIRMED_REVERSAL.opposingDirAt40.losers,1);
 assert.equal(r.byRoute.CONFIRMED_REVERSAL.opposingDirAt40.netUsd,-53);
});
test('future-only or stale forecasts remain uncovered; no hindsight reconstruction',()=>{
 const p=forecast({predictedNextCandleClass:'COST_SMALL_OR_FLAT',confidence:.81});
 const x=summarize([trade({intent_at:iso(start+19000)}),trade({intent_at:iso(start+500000),
  opened_at:iso(start+501000),closed_at:iso(start+600000)})],
   new Map([['EURUSD',[p]]]));
 assert.equal(x.cohort.withForecast,0);
 assert.equal(x.cohort.noForecast,2);
 assert.equal(x.byRoute.EARLY_TRANSITION.highConfFlat.trades,0);
});
test('flat warnings count wins and losses in original broker outcome, without hypothetical fills',()=>{
 const p=forecast();
 const x=summarize([trade(),trade({realised_pnl:'22',commission:'-2'})],
  new Map([['EURUSD',[p]]]));
 assert.equal(x.byRoute.EARLY_TRANSITION.highConfFlat.trades,2);
 assert.equal(x.byRoute.EARLY_TRANSITION.highConfFlat.winners,1);
 assert.equal(x.byRoute.EARLY_TRANSITION.highConfFlat.losers,1);
 assert.equal(x.byRoute.EARLY_TRANSITION.highConfFlat.netUsd,3);
 assert.equal(x.noCounterfactualBrokerFills,true);
});
