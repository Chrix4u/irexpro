'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {compileStrategyScorecard:compile,compareRoute}=
  require('./research-owner-demo-strategy-scorecard.cjs');

const asOf='2026-11-17T13:00:00.000Z';
const instruments=['EURUSD','AUDUSD','USDJPY','USDCAD'];
const trade=(route,net,changes={})=>({
  state:'STOP_THEN_ENTRY_RECLAIMED',
  strategyRoute:route,
  settled:net!==null,netAfterCommissionAndSwap:net,
  commissionCharged:net===null?null:-6,peakBrokerPnl:net===null?null:12,
  profitGiveback:net===null?null:'9.50',
  confirmedStop:true,potentialStop:false,observedHorizonCount:3,...changes,
});
const stops=()=>({
  artifact:'irexpro-owner-demo-post-stop-direction-audit-v1',
  researchOnly:true,modifiesExecution:false,source:'ctrader-broker-native',
  asOf,instruments,
  examples:[
    trade('EARLY_TRANSITION',-25),
    trade('EARLY_TRANSITION',35,{state:'PROFIT_PROTECTION_CLOSE',confirmedStop:false}),
    trade('EARLY_TRANSITION',null,{state:'STOP_FOLLOWUP_MISSING',observedHorizonCount:0}),
    trade('CONFIRMED_REVERSAL',-80,{state:'STOP_THEN_PARTIAL_BOUNCE'}),
    trade('CONFIRMED_REVERSAL',-15,{state:'BROKER_CLOSE_NEAR_STOP_UNCONFIRMED',
      confirmedStop:false,potentialStop:true}),
    trade('TREND_CONTINUATION',50,{state:'TAKE_PROFIT_CLOSE',
      confirmedStop:false,peakBrokerPnl:76,profitGiveback:0}),
    trade('UNCLASSIFIED',-10),
  ],
});
const horizon=(n,feeN,rate,mean)=>({
  episodes:n,directionalWinRate:rate,meanDirectionalR:.12,
  estimatedAfterFeeCoverage:feeN,
  estimatedAfterFeeWinRate:feeN?rate:null,
  meanEstimatedAfterFeeR:feeN?mean:null,
});
const directions=()=>({
  artifact:'irexpro-owner-demo-directional-horizon-replay-v1',
  researchOnly:true,modifiesExecution:false,source:'ctrader-broker-native',
  asOf:'2026-11-17T13:06:00.000Z',instruments,
  byRoute:{
    EARLY_TRANSITION:{'5m':horizon(14,12,.62,-.04)},
    CONFIRMED_REVERSAL:{'5m':horizon(12,8,.55,-.21)},
    TREND_CONTINUATION:{'5m':horizon(8,0,.75,null)},
  },
  byExecutedRoute:{
    EARLY_TRANSITION:{'5m':horizon(6,5,.50,-.22)},
    CONFIRMED_REVERSAL:{'5m':horizon(4,3,.75,-.08)},
    TREND_CONTINUATION:{'5m':horizon(2,0,1,null)},
  },
});
test('keeps broker realized positions separate from scanner decision episodes',()=>{
  const r=compile(stops(),directions());
  const early=r.byStrategy.EARLY_TRANSITION;
  assert.equal(early.executedClosedTradeCohort.closedTrades,3);
  assert.equal(early.executedClosedTradeCohort.feeSettledTrades,2);
  assert.equal(early.executedClosedTradeCohort.netProfitUsd,10);
  assert.equal(early.executedClosedTradeCohort.averageNetUsdPerSettledTrade,5);
  assert.equal(early.executedClosedTradeCohort.winRate,.5);
  assert.equal(early.executedClosedTradeCohort.profitFactor,35/25);
  assert.equal(early.directionalDecisionEpisodeCohort['5m'].independentEpisodeKeys,14);
  assert.equal(early.executedDecisionEpisodeCohort['5m'].executedDecisionEpisodeKeys,6);
  assert.equal(early.executedDecisionEpisodeCohort['5m'].meanAfterFeeProxyR,-.22);
  assert.equal(early.directionalDecisionEpisodeCohort['5m'].meanAfterFeeProxyR,-.04);
  assert.equal(r.promotionAllowed,false);
  assert.equal(r.modifiesExecution,false);
});
test('uses only fee-settled denominator for win rate and cost accounting',()=>{
  const {executedClosedTradeCohort:x}=compile(stops(),directions()).byStrategy.EARLY_TRANSITION;
  assert.equal(x.winners,1);
  assert.equal(x.losers,1);
  assert.equal(x.incompleteFinancials,1);
  assert.equal(x.signedCommissionUsd,-12);
  assert.equal(x.positivePeakThenNetLossTrades,1);
  assert.equal(x.positivePeakThenNetLossRate,.5);
});
test('reports confirmed stops, missing followups and uncertain broker-close separately',()=>{
  const r=compile(stops(),directions());
  const early=r.byStrategy.EARLY_TRANSITION.confirmedStopFollowup;
  assert.equal(early.confirmedBrokerStopTrades,2);
  assert.equal(early.priceObservedAfterStop,1);
  assert.equal(early.followupMissing,1);
  assert.equal(early.originalFillReclaimedAtSample,1);
  assert.equal(early.reclaimRateAmongObservedStops,1);
  const reversal=r.byStrategy.CONFIRMED_REVERSAL.confirmedStopFollowup;
  assert.equal(reversal.confirmedBrokerStopTrades,1);
  assert.equal(reversal.partialBounceAtSample,1);
  assert.equal(reversal.unknownBrokerClosesNearSL,1);
});
test('retains research-only status for apparently profitable trend continuation',()=>{
  const x=compile(stops(),directions()).byStrategy.TREND_CONTINUATION;
  assert.equal(x.executedClosedTradeCohort.netProfitUsd,50);
  assert.equal(x.executedClosedTradeCohort.profitFactor,null);
  assert.equal(x.directionalDecisionEpisodeCohort['5m'].afterFeeProxyCoveredEpisodes,0);
  assert.equal(x.directionalDecisionEpisodeCohort['5m'].meanAfterFeeProxyR,null);
  assert.equal(x.evidenceStatus,'INSUFFICIENT_INDEPENDENT_AFTER_COST_EVIDENCE');
  assert.equal(x.decision,'RESEARCH_ONLY_NO_AUTOMATIC_STRATEGY_PROMOTION');
});
test('never invents zero net profit or full win rate when there are no trades',()=>{
  const x=compareRoute([],{});
  assert.equal(x.executedClosedTradeCohort.netProfitUsd,null);
  assert.equal(x.executedClosedTradeCohort.winRate,null);
  assert.equal(x.executedClosedTradeCohort.profitFactor,null);
  assert.equal(x.confirmedStopFollowup.reclaimRateAmongObservedStops,null);
  assert.equal(x.directionalDecisionEpisodeCohort['10m'].grossDirectionHitRate,null);
});
test('unclassified rows are not silently assigned to a strategy',()=>{
  const r=compile(stops(),directions());
  assert.equal(r.unclassifiedClosedTrades,1);
  assert.equal(r.byStrategy.TREND_CONTINUATION.executedClosedTradeCohort.closedTrades,1);
});
test('reports too far apart must be rerun together',()=>{
  const v=directions();
  v.asOf='2026-11-17T14:00:00.000Z';
  assert.throws(()=>compile(stops(),v),/RESEARCH_SNAPSHOTS_TOO_FAR_APART/);
});
test('mixed instruments, nonnative sources and incomplete research provenance are rejected',()=>{
  const v=directions();
  v.instruments=['EURUSD'];
  assert.throws(()=>compile(stops(),v),/INCOMPATIBLE_INSTRUMENT_SET/);
  const st=stops();st.source='provider-mid';
  assert.throws(()=>compile(st,directions()),/UNMATCHED_BROKER_PRICE_SOURCE/);
  const n=directions();n.researchOnly=false;
  assert.throws(()=>compile(stops(),n),/INVALID_DIRECTION_REPLAY_REPORT/);
});
test('adequate evidence permits further research only, NEVER model promotion',()=>{
  const examples=Array.from({length:35},(_,i)=>trade('EARLY_TRANSITION',i%2?12:-7,
    {state:'TAKE_PROFIT_CLOSE',confirmedStop:false,profitGiveback:null}));
  const a=stops();a.examples=examples;
  const b=directions();b.byRoute.EARLY_TRANSITION['5m']=horizon(43,36,.67,.2);
  b.byExecutedRoute.EARLY_TRANSITION['5m']=horizon(25,20,.68,.09);
  const r=compile(a,b).byStrategy.EARLY_TRANSITION;
  assert.equal(r.evidence.sufficientForExploration,true);
  assert.equal(r.evidenceStatus,'ENOUGH_FOR_FURTHER_VALIDATION_NOT_DEPLOYMENT');
  assert.equal(r.decision,'RESEARCH_ONLY_NO_AUTOMATIC_STRATEGY_PROMOTION');
});

test('missing executed cohort is not silently replaced by all scanner decisions',()=>{
  const a=stops(),b=directions();
  delete b.byExecutedRoute;
  const r=compile(a,b).byStrategy.EARLY_TRANSITION;
  assert.equal(r.directionalDecisionEpisodeCohort['5m'].independentEpisodeKeys,14);
  assert.equal(r.executedDecisionEpisodeCohort['5m'].executedDecisionEpisodeKeys,0);
  assert.equal(r.executedDecisionEpisodeCohort['5m'].meanAfterFeeProxyR,null);
  assert.equal(r.evidence.sufficientForExploration,false);
});
