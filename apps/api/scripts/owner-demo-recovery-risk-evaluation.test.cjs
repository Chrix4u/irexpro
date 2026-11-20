'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const report=require('./owner-demo-recovery-risk-evaluation.cjs');
const watcher=require('./watch-owner-demo-recovery-risk-shadow.cjs');
const at='2026-11-20T16:03:00Z';
let id=0;
const trade=({route='CONFIRMED_REVERSAL',net=null,warning=false,scored=true,
 day='2026-11-20',repeats=1,actual=null}={})=>{
 const snapshots={};
 for(let i=0;i<repeats;i++){
  snapshots[i+1]={checkpointMinute:i+1,
   signal:{state:!scored?'NO_FRESH_BROKER_NATIVE_QUOTE':
    warning?'TOWARD_ORIGINAL_STOP':'NO_STRONG_REVERSAL_WARNING'},
   futures:Object.fromEntries(report.HORIZONS.map(h=>[h,{
    assessedAt:at,horizonMinutes:h,actual,
   }]))};
 }
 return {tradeId:'trade-'+(++id),route,openedAt:day+'T10:00:00Z',
  snapshots,settled:net===null?null:{netUsd:net,closedAt:day+'T10:20:00Z'}};
};
test('two red warning snapshots count a single winning trade once, including its sacrificed profit',()=>{
 const a=trade({net:-205,warning:true,repeats:2}),b=trade({net:54,warning:true}),
  c=trade({net:-50}),d=trade({net:80,scored:false});
 const r=report.evaluate([a,b,c,d]);
 const x=r.byRoute.CONFIRMED_REVERSAL;
 assert.equal(x.warned.tradeCount,2);
 assert.equal(x.warned.scoreableSnapshots,3);
 assert.equal(x.warned.afterCostWinners,1);
 assert.equal(x.warned.afterCostLosers,1);
 assert.equal(x.warned.winningNetUsd,54);
 assert.equal(x.warned.losingNetUsd,-205);
 assert.equal(x.warned.totalActualBrokerNetUsd,-151);
 assert.equal(x.unwarned.tradeCount,1);
 assert.equal(x.unwarned.totalActualBrokerNetUsd,-50);
 assert.equal(x.unevaluable.tradeCount,1);
 assert.equal(x.unevaluable.totalActualBrokerNetUsd,80);
 assert.equal(x.candidateForManualCalibrationReview,false);
 assert.equal(x.noExecutionAuthority,true);
 assert.equal(r.noHypotheticalSavedMoneyClaim,true);
 assert.equal(r.protectedProfitSystemUnchanged,true);
});
test('horizon scoreboard separates actual settled loss from quote-only above-cost mark',()=>{
 const closed={state:'ACTUAL_POSITION_CLOSED_BEFORE_HORIZON',
  actualBrokerNetUsd:-207.25,actualCloseReason:'BROKER_CLOSE'};
 const quote={state:'REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY',
  theoreticalNetAfterEstimatedFeeUsd:26,quoteOnlyAboveEstimatedCost:true};
 const loss=trade({net:-207.25,warning:true,actual:closed}),
  mark=trade({net:35,warning:true,actual:quote}),
  unflagged=trade({net:-34,actual:{state:'MISSED_REALTIME_OUTCOME_WINDOW'}});
 const r=report.evaluate([loss,mark,unflagged]);
 const h=r.byRouteAndWarningAndHorizon['CONFIRMED_REVERSAL|WARNING|5m'];
 assert.equal(h.prospectiveSnapshots,2);
 assert.equal(h.actualBrokerClosesBeforeHorizon,1);
 assert.equal(h.actualBrokerClosedNetNegative,1);
 assert.equal(h.quoteOnlyMarks,1);
 assert.equal(h.quoteOnlyEstimatedNetPositive,1);
 assert.equal(h.quoteMarksAreNotExecutableExits,true);
 const un=r.byRouteAndWarningAndHorizon['CONFIRMED_REVERSAL|NOT_WARNING|5m'];
 assert.equal(un.prospectiveSnapshots,1);
 assert.equal(un.statusCounts.MISSED_REALTIME_OUTCOME_WINDOW,1);
 assert.equal(r.modelIsCalibrated,false);
 assert.equal(r.modifiesExecution,false);
});
test('no metric treats still-open trades as settled losers or winners',()=>{
 const a=trade({warning:true,net:null,repeats:2});
 const r=report.evaluate([a]);
 const x=r.byRoute.CONFIRMED_REVERSAL.warned;
 assert.equal(x.tradeCount,1);
 assert.equal(x.settledTrades,0);
 assert.equal(x.openOrUnsettled,1);
 assert.equal(x.totalActualBrokerNetUsd,0);
 assert.equal(x.winRateAfterCosts,null);
 assert.equal(r.byRouteAndWarningAndHorizon['CONFIRMED_REVERSAL|WARNING|10m'].pending,2);
});
test('review threshold needs independent warning and unwarned days, but cannot authorize auto exit',()=>{
 const samples=[];
 for(let i=0;i<24;i++)samples.push(trade({
  day:'2026-11-'+String(10+i%6).padStart(2,'0'),
  net:i%2?-20:30,warning:true,
 }));
 for(let i=0;i<36;i++)samples.push(trade({
  day:'2026-11-'+String(10+i%6).padStart(2,'0'),
  net:i%2?-15:40,warning:false,
 }));
 const r=report.evaluate(samples);
 const x=r.byRoute.CONFIRMED_REVERSAL;
 assert.equal(x.candidateForManualCalibrationReview,true);
 assert.equal(x.sufficientStatisticalEvidence,false);
 assert.equal(x.noExecutionAuthority,true);
 assert.equal(r.autoPromote,false);
 assert.equal(r.modelIsCalibrated,false);
});
test('cannot hide invalid missing-profit data as a signed booked outcome',()=>{
 const t=trade({net:9,warning:true});
 t.settled.netUsd='bad';
 const stats=report.cohortStats([t]);
 assert.equal(stats.settledTrades,0);
 assert.equal(stats.openOrUnsettled,1);
});
test('watcher summary includes separate owner-only warned and unwarned economics without authority',()=>{
 const a=trade({net:-207.25,warning:true}),
  b=trade({net:45.1,warning:false});
 const marker={activatedAt:'2026-11-20T15:54:58Z'};
 const w=watcher.summary({trades:{a,b}},marker,Date.parse(at));
 assert.equal(w.forwardValidation.byRoute.CONFIRMED_REVERSAL.warned.totalActualBrokerNetUsd,-207.25);
 assert.equal(w.forwardValidation.byRoute.CONFIRMED_REVERSAL.unwarned.totalActualBrokerNetUsd,45.1);
 assert.equal(w.forwardValidation.modifiesExecution,false);
 assert.equal(w.forwardValidation.protectedProfitSystemUnchanged,true);
 assert.equal(w.noAutomaticProfitProtectionChanges,true);
 assert.equal(w.noStopAmendments,true);
});

test('first warning must give useful lead time before actual close, not merely be retrospective',()=>{
 const fast=trade({net:-207.25,warning:true,repeats:2});
 fast.snapshots[1].at='2026-11-20T10:19:50Z';
 fast.snapshots[2].at='2026-11-20T10:19:55Z';
 const early=trade({net:-150,warning:true});
 early.snapshots[1].at='2026-11-20T10:18:30Z';
 const r=report.evaluate([fast,early]);
 const h=r.byRoute.CONFIRMED_REVERSAL.warnedLeadTimeBeforeActualClose;
 assert.equal(h.warnedSettledWithTimestamp,2);
 assert.equal(h.warningBeforeActualClose,2);
 assert.equal(h.warningLeadAtLeast10Seconds,2);
 assert.equal(h.warningLeadAtLeast30Seconds,1);
 assert.equal(h.warningLeadAtLeast60Seconds,1);
 assert.equal(h.meanLeadSeconds,50);
 assert.equal(h.timingIsNotEvidenceOfExecutableBrokerClose,true);
});
test('horizon marks show direction of sampled move, not a claimed recoverable broker fill',()=>{
 const a=report.horizonStats([
  {initial:{grossMarketMarkEstimateUsd:-80},actual:{
   state:'REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY',theoreticalGrossUsd:25,
   quoteOnlyAboveEstimatedCost:true}},
  {initial:{grossMarketMarkEstimateUsd:60},actual:{
   state:'REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY',theoreticalGrossUsd:-90,
   quoteOnlyAboveEstimatedCost:false}},
  {initial:{grossMarketMarkEstimateUsd:null},actual:{
   state:'REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY',theoreticalGrossUsd:20,
   quoteOnlyAboveEstimatedCost:null}},
 ]);
 assert.equal(a.quoteOnlyMarks,3);
 assert.equal(a.quoteOnlyFavorableAfterSnapshot,1);
 assert.equal(a.quoteOnlyAdverseAfterSnapshot,1);
 assert.equal(a.quoteOnlyMarkMoveUnknown,1);
 assert.equal(a.quoteOnlyEstimatedNetPositive,1);
 assert.equal(a.quoteOnlyEstimatedNetNonpositive,1);
 assert.equal(a.quoteOnlyCostEvidenceMissing,1);
 assert.equal(a.quoteMarksAreNotExecutableExits,true);
});
test('missing or blank broker-net evidence cannot be mistaken for a flat settled result',()=>{
 const t=trade({net:10,warning:true});
 t.settled.netUsd=null;
 assert.equal(report.cohortStats([t]).settledTrades,0);
 t.settled.netUsd='';
 assert.equal(report.cohortStats([t]).settledTrades,0);
});
