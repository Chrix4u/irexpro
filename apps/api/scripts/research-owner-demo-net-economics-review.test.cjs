'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {review,reviewGroup}=require('./research-owner-demo-net-economics-review.cjs');
function group(n,gross,fees,pre){
 return {trades:n,pairedRealizedNetR:n,completeRecordedCosts:n,
 validEntryAllocationRisk:n,skippedIncompleteCostOrRisk:0,
 meanRealizedGrossR:gross,meanRecordedCommissionR:fees,
 meanRealizedNetR:+(gross-fees).toFixed(3),
 m1ExpectedNetR:{pairedCount:n,meanForecastR:pre},
 grossPositiveNetNonPositive:0,netProfitable:Math.floor(n/2),
 netUnprofitable:n-Math.floor(n/2)};
}
function sample(){
 return {
 artifact:'ex-ante-vs-realized-commission-r-audit-v1',researchOnly:true,
 modifiesExecution:false,promotionEligible:false,brokerId:'pepperstone-ctrader',
 accountCurrency:'USD',from:'2026-11-10T20:00:00Z',asOf:'2026-11-17T20:00:00Z',
 byCurrency:{'USD | ALL':group(126,-.058,.146,.109)},
 byStrategyRoute:{
  'USD | EARLY_TRANSITION':group(31,.012,.154,.076),
  'USD | CONFIRMED_REVERSAL':group(44,-.001,.153,.114),
  'USD | TREND_CONTINUATION':group(51,-.151,.135,.124),
 }
 };
}
test('attributes gross opportunity gap separately from commission R',()=>{
 const x=review(sample());
 assert.equal(x.historicalClosedTrades,126);
 assert.equal(x.allStrategies.meanNetR,-.204);
 assert.equal(x.allStrategies.forecastVsGrossOpportunityGapR,.167);
 assert.equal(x.allStrategies.observedNetShortfallVsModelR,.313);
 assert.equal(x.allStrategies.meanCommissionR,.146);
 assert.equal(x.allStrategies.zeroCommissionAloneWouldGivePositiveAverageR,false);
 assert.equal(x.livePromotionAllowed,false);
});
test('early transition needs unrealistically deep commission cut for gross-only break-even',()=>{
 const x=review(sample()).byStrategy.EARLY_TRANSITION;
 assert.equal(x.meanGrossR,.012);assert.equal(x.meanNetR,-.142);
 assert.equal(x.commissionReductionRequiredForBreakEvenPct,92.208);
 assert.equal(x.additionalGrossRNeededAtSameFeeToBreakEven,.142);
});
test('continuation and reversal cannot become profitable by removing fees alone',()=>{
 const {byStrategy}=review(sample());
 for(const name of ['TREND_CONTINUATION','CONFIRMED_REVERSAL']){
  assert.equal(byStrategy[name].zeroCommissionAloneWouldGivePositiveAverageR,false);
  assert.equal(byStrategy[name].commissionReductionRequiredForBreakEvenPct,null);
 }
});
test('fail closed on missing commission, incomplete risk, or implausible cost accounting',()=>{
 const a=sample();a.byCurrency['USD | ALL'].validEntryAllocationRisk=125;
 assert.throws(()=>review(a),/INCOMPLETE_OVERALL_AUDIT/);
 const b=sample();b.byCurrency['USD | ALL'].meanRealizedNetR=+.3;
 assert.throws(()=>review(b),/INCONSISTENT_RECORDED_COSTS_OR_R/);
});
test('requires exact Pepperstone DEMO audit provenance and all three routes',()=>{
 for(const [key,val] of [['brokerId','other'],['promotionEligible',true],
   ['accountCurrency','EUR'],['researchOnly',false]]){
   const x=sample();x[key]=val;
   assert.throws(()=>review(x),/EXACT_PEPPERSTONE_DEMO/);
 }
 const y=sample();delete y.byStrategyRoute['USD | CONFIRMED_REVERSAL'];
 assert.throws(()=>review(y),/MISSING_ROUTE/);
});
test('rejects partial classification so missed trades cannot bias the result',()=>{
 const x=sample();x.byStrategyRoute['USD | TREND_CONTINUATION'].trades=50;
 x.byStrategyRoute['USD | TREND_CONTINUATION'].pairedRealizedNetR=50;
 x.byStrategyRoute['USD | TREND_CONTINUATION'].completeRecordedCosts=50;
 x.byStrategyRoute['USD | TREND_CONTINUATION'].validEntryAllocationRisk=50;
 assert.throws(()=>review(x),/UNCLASSIFIED_TRADE_OR_MIXED_DENOMINATOR/);
});
test('ordinary research cannot submit orders or mutate trading models',()=>{
 const source=fs.readFileSync(__filename.replace('.test.cjs','.cjs'),'utf8');
 assert.doesNotMatch(source,/\b(?:placeOrder|executeTrade|closePosition|UPDATE\s+trading)\s*\(/);
 assert.match(source,/orderAuthority:false/);
 assert.match(source,/livePromotionAllowed:false/);
});
