#!/usr/bin/env node
'use strict';
/**
 * Pure, read-only diagnostic of a previously produced exact-owner Pepperstone
 * cTrader USD DEMO commission-R calibration audit. No trading or DB imports.
 * Numbers are averages normalized by *each trade's own recorded allocation
 * risk* (R). They cannot be summed as USD portfolio equity.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='irexpro-owner-demo-net-economics-root-cause-v1';
const ROUTES=['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION'];
function finite(v){return typeof v==='number'&&Number.isFinite(v)?v:null;}
function round(v){return Number(v.toFixed(3));}
function validate(src){
 if(!src||src.artifact!=='ex-ante-vs-realized-commission-r-audit-v1'||
  src.researchOnly!==true||src.modifiesExecution!==false||
  src.promotionEligible!==false||src.brokerId!=='pepperstone-ctrader'||
  src.accountCurrency!=='USD'||!src.byCurrency||!src.byStrategyRoute)
  throw Error('EXACT_PEPPERSTONE_DEMO_RESEARCH_AUDIT_REQUIRED');
 const from=Date.parse(src.from),asof=Date.parse(src.asOf);
 if(!Number.isFinite(from)||!Number.isFinite(asof)||asof<from||
    asof-from>14*86400000)throw Error('INVALID_AUDIT_TIMEFRAME');
 for(const route of ROUTES){
  if(!src.byStrategyRoute['USD | '+route])throw Error('MISSING_ROUTE_'+route);
 }
}
function reviewGroup(data){
 const n=data.trades;
 if(!Number.isSafeInteger(n)||n<0||
    data.pairedRealizedNetR!==n||data.completeRecordedCosts!==n||
    data.validEntryAllocationRisk!==n||
    data.skippedIncompleteCostOrRisk!==0)
  return {status:'INCOMPLETE_CLOSED_TRADE_ECONOMICS',trades:n||0};
 const gross=finite(data.meanRealizedGrossR),
   net=finite(data.meanRealizedNetR),fee=finite(data.meanRecordedCommissionR),
   forecast=finite(data.m1ExpectedNetR?.meanForecastR);
 if([gross,net,fee].some(v=>v===null)||fee<0||
    Math.abs(gross-fee-net)>.011)
  throw Error('INCONSISTENT_RECORDED_COSTS_OR_R');
 const gap=forecast===null?null:forecast-net;
 const opportunityGap=forecast===null?null:forecast-gross;
 return {
   status:'COMPLETE_HISTORICAL_COHORT_NOT_OUT_OF_SAMPLE',trades:n,
   meanGrossR:gross,meanCommissionR:fee,meanNetR:net,
   grossEdgeWithoutCommissionPositive:gross>0,
   afterCostEdgePositive:net>0,
   meanPreEntryModeledNetRExcludingBrokerCommission:forecast,
   observedNetShortfallVsModelR:gap===null?null:round(gap),
   forecastVsGrossOpportunityGapR:opportunityGap===null?null:round(opportunityGap),
   additionalGrossRNeededAtSameFeeToBreakEven:round(Math.max(0,-net)),
   // Monetary cost cuts are hypothetical algebra, not broker achievable.
   commissionReductionRequiredForBreakEvenPct:
     gross>0&&fee>0&&net<0?round(100*Math.max(0,1-gross/fee)):
     (gross<=0?null:0),
   zeroCommissionAloneWouldGivePositiveAverageR:gross>0,
   recordedGrossPositiveButNetNonPositiveTrades:data.grossPositiveNetNonPositive,
   netWinningTrades:data.netProfitable,
   netLosingTrades:data.netUnprofitable,
   note:'Averages of position-level R, NOT portfolio return or actual cash; commissions may be included in each position separately and cannot be cured simply by larger lots.',
 };
}
function review(src){
 validate(src);
 const summary=reviewGroup(src.byCurrency['USD | ALL']);
 if(summary.status!=='COMPLETE_HISTORICAL_COHORT_NOT_OUT_OF_SAMPLE')
  throw Error('INCOMPLETE_OVERALL_AUDIT');
 const routes=Object.fromEntries(ROUTES.map(route=>
   [route,reviewGroup(src.byStrategyRoute['USD | '+route])]));
 if(ROUTES.some(r=>routes[r].status!=='COMPLETE_HISTORICAL_COHORT_NOT_OUT_OF_SAMPLE'))
  throw Error('INCOMPLETE_ROUTE_AUDIT');
 const total=ROUTES.reduce((n,r)=>n+routes[r].trades,0);
 if(total!==summary.trades)throw Error('UNCLASSIFIED_TRADE_OR_MIXED_DENOMINATOR');
 return {
  artifact:ARTIFACT,asOf:src.asOf,from:src.from,
  sourceArtifact:src.artifact,
  ownerScopedBroker:'pepperstone-ctrader',
  accountCurrency:'USD',
  researchOnly:true,modifiesExecution:false,
  orderAuthority:false,livePromotionAllowed:false,
  historicalClosedTrades:summary.trades,
  allStrategies:summary,byStrategy:routes,
  findings:[
   'Overall risk-normalized gross result is negative: removing commission alone does not establish a profitable strategy.',
   'Compare each strategy mean pre-entry modeled net excluding commission against actual GROSS R to expose the model opportunity/exit mismatch separate from explicit commission.',
   'Compare actual gross R against actual net R to isolate explicitly recorded commission burden; broker spread and slippage are already present in price outcomes.',
   'Individual gross-winning positions converted to net losses are reported explicitly; do not assert that all or most winners were flipped by fees.',
   'The results come from closed historical trades selected by an existing policy; no proposed entry veto or profit-protection exit is causally validated.',
   'Risk-normalized per-trade R is not cumulative dollar profit, equity, or drawdown.',
  ],
  recommendation:'RECALIBRATE_GROSS_EXPECTANCY_AND_EX_ANTE_COMMISSION_IN_SHADOW_FIRST; NO_LIVE_DEPLOYMENT_OR_LOT_ESCALATION',
 };
}
function main(){
 const input=process.argv.find(a=>a.startsWith('--audit='))?.slice(8);
 if(!input)throw Error('AUDIT_INPUT_REQUIRED');
 const raw=fs.readFileSync(path.resolve(input),'utf8').trim();
 const tagged=raw.split('\n').find(line=>line.startsWith('COMMISSION_R_AUDIT '));
 const object=tagged?JSON.parse(tagged.slice('COMMISSION_R_AUDIT '.length)):JSON.parse(raw);
 const report=review(object);
 const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
 if(out){
  const file=path.resolve(out);
  if(!file.startsWith('/tmp/'))throw Error('PRIVATE_TMP_OUTPUT_REQUIRED');
  fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 }
 console.log(JSON.stringify(report,null,2));
}
module.exports={ARTIFACT,ROUTES,reviewGroup,review};
if(require.main===module){try{main();}catch(e){
 console.error('NET_ECONOMICS_RESEARCH_ABORTED',e.message);process.exitCode=1;
}}
