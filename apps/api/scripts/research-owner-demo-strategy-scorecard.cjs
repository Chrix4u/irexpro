#!/usr/bin/env node
'use strict';

/**
 * Read-only comparative strategy scorecard combining TWO independently
 * generated owner Pepperstone DEMO research reports. Never merges decision
 * episodes and executed trades into one statistical denominator.
 *
 * node scripts/research-owner-demo-strategy-scorecard.cjs \
 *   --stops=/tmp/irexpro-owner-post-stop-audit.json \
 *   --directions=/tmp/irexpro-direction-replay.json \
 *   --out=/tmp/irexpro-strategy-comparison.json
 */
const fs=require('node:fs');
const path=require('node:path');
const ROUTES=Object.freeze(['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION']);
const HORIZONS=Object.freeze(['1m','3m','5m','10m']);
const EXPECTED_SOURCE='ctrader-broker-native';
const MAX_SNAPSHOT_SKEW_MS=15*60*1000;

function numberOrNull(v) {
  if(v===null||v===undefined||v==='')return null;
  const n=Number(v);
  return Number.isFinite(n)?n:null;
}
function ratio(n,d) {return d>0?n/d:null;}
function rounded(n){return Number(n.toFixed(4));}
function assertCompatible(stops,directions){
  if(!stops||stops.researchOnly!==true||stops.modifiesExecution!==false||
     stops.artifact!=='irexpro-owner-demo-post-stop-direction-audit-v1'||
     !Array.isArray(stops.examples))throw Error('INVALID_STOP_RESEARCH_REPORT');
  if(!directions||directions.researchOnly!==true||
     directions.modifiesExecution!==false||
     directions.artifact!=='irexpro-owner-demo-directional-horizon-replay-v1'||
     !directions.byRoute||typeof directions.byRoute!=='object')
    throw Error('INVALID_DIRECTION_REPLAY_REPORT');
  if(stops.source!==EXPECTED_SOURCE||directions.source!==EXPECTED_SOURCE)
    throw Error('UNMATCHED_BROKER_PRICE_SOURCE');
  const left=Array.isArray(stops.instruments)?[...stops.instruments].sort():[];
  const right=Array.isArray(directions.instruments)?[...directions.instruments].sort():[];
  if(left.length===0||JSON.stringify(left)!==JSON.stringify(right))
    throw Error('INCOMPATIBLE_INSTRUMENT_SET');
  const a=Date.parse(stops.asOf),b=Date.parse(directions.asOf);
  if(!Number.isFinite(a)||!Number.isFinite(b)||
     Math.abs(a-b)>MAX_SNAPSHOT_SKEW_MS)
    throw Error('RESEARCH_SNAPSHOTS_TOO_FAR_APART');
}
function compareRoute(trades, horizonBuckets, executedHorizonBuckets={}){
  let settled=0,wins=0,losses=0,breakeven=0;
  let netUsd=0,winningUsd=0,losingUsd=0,commissionUsd=0;
  let confirmedStops=0,stopFollowup=0,reclaims=0,partialBounces=0,
      noReclaims=0,missingFollowup=0,nearStopUnconfirmed=0;
  let positivePeakThenNetLoss=0,givebackSamples=0,givebackUsd=0;
  const count=trades.length;
  const statusCounts={};
  for(const t of trades){
    const state=String(t.state||'UNKNOWN');
    statusCounts[state]=(statusCounts[state]||0)+1;
    const net=numberOrNull(t.netAfterCommissionAndSwap);
    const eligible=t.settled===true&&net!==null;
    if(eligible){
      settled++;netUsd+=net;
      if(net>0){wins++;winningUsd+=net;}
      else if(net<0){losses++;losingUsd+=net;}
      else breakeven++;
      const commission=numberOrNull(t.commissionCharged);
      if(commission!==null)commissionUsd+=commission;
      if(net<0&&numberOrNull(t.peakBrokerPnl)>0)positivePeakThenNetLoss++;
    }
    const giveback=numberOrNull(t.profitGiveback);
    if(giveback!==null&&giveback>=0){givebackUsd+=giveback;givebackSamples++;}
    if(t.confirmedStop===true){
      confirmedStops++;
      if(state==='STOP_FOLLOWUP_MISSING')missingFollowup++;
      else if((numberOrNull(t.observedHorizonCount)||0)>0){
        stopFollowup++;
        if(state==='STOP_THEN_ENTRY_RECLAIMED')reclaims++;
        else if(state==='STOP_THEN_PARTIAL_BOUNCE')partialBounces++;
        else noReclaims++;
      }
    }
    if(t.potentialStop===true&&t.confirmedStop!==true)nearStopUnconfirmed++;
  }
  const horizons={};
  for(const h of HORIZONS){
    const raw=horizonBuckets?.[h]||null;
    const episodes=raw&&Number.isSafeInteger(raw.episodes)&&raw.episodes>=0?
      raw.episodes:0;
    const feeCovered=raw&&Number.isSafeInteger(raw.estimatedAfterFeeCoverage)&&
      raw.estimatedAfterFeeCoverage>=0?raw.estimatedAfterFeeCoverage:0;
    horizons[h]={
      independentEpisodeKeys:episodes,
      grossDirectionHitRate:episodes>0?numberOrNull(raw.directionalWinRate):null,
      meanGrossDirectionalR:episodes>0?numberOrNull(raw.meanDirectionalR):null,
      afterFeeProxyCoveredEpisodes:feeCovered,
      afterFeeProxyWinRate:feeCovered>0?
        numberOrNull(raw.estimatedAfterFeeWinRate):null,
      meanAfterFeeProxyR:feeCovered>0?
        numberOrNull(raw.meanEstimatedAfterFeeR):null,
      costCoverageRate:ratio(feeCovered,episodes),
      studyType:'SCANNER_DECISION_EPISODES_NOT_EXECUTED_TRADE_PNL',
    };
  }
  // Executed-at-broker directional episodes are independently tracked. The
  // filled-decision cohort still cannot be joined directly to every settled
  // trade without a durable trade-intent key; do not merge denominators.
  const executedHorizons={};
  for(const h of HORIZONS){
    const x=executedHorizonBuckets?.[h]||null;
    const n=x&&Number.isSafeInteger(x.episodes)&&x.episodes>=0?x.episodes:0;
    const feeN=x&&Number.isSafeInteger(x.estimatedAfterFeeCoverage)&&
      x.estimatedAfterFeeCoverage>=0?x.estimatedAfterFeeCoverage:0;
    executedHorizons[h]={
      executedDecisionEpisodeKeys:n,
      grossDirectionHitRate:n>0?numberOrNull(x.directionalWinRate):null,
      meanGrossDirectionalR:n>0?numberOrNull(x.meanDirectionalR):null,
      afterFeeProxyCoveredEpisodes:feeN,
      meanAfterFeeProxyR:feeN>0?numberOrNull(x.meanEstimatedAfterFeeR):null,
      afterFeeProxyWinRate:feeN>0?numberOrNull(x.estimatedAfterFeeWinRate):null,
      studyType:'BROKER_DISPATCH_SUCCEEDED_EPISODES_NOT_CLOSED_POSITION_PNL',
    };
  }
  const evidence={
    settledTrades:count>0?settled:0,
    priceLabeled5MinuteEpisodes:horizons['5m'].independentEpisodeKeys,
    fiveMinuteFeeCovered:horizons['5m'].afterFeeProxyCoveredEpisodes,
    executedFiveMinuteEpisodeKeys:executedHorizons['5m'].executedDecisionEpisodeKeys,
    executedFiveMinuteFeeCovered:executedHorizons['5m'].afterFeeProxyCoveredEpisodes,
    sufficientForExploration:settled>=30&&
      horizons['5m'].independentEpisodeKeys>=30&&
      horizons['5m'].afterFeeProxyCoveredEpisodes>=25&&
      executedHorizons['5m'].executedDecisionEpisodeKeys>=20&&
      executedHorizons['5m'].afterFeeProxyCoveredEpisodes>=15,
  };
  return {
    executedClosedTradeCohort:{
      closedTrades:count,
      feeSettledTrades:settled,
      incompleteFinancials:count-settled,
      netProfitUsd:settled>0?rounded(netUsd):null,
      averageNetUsdPerSettledTrade:count>0&&settled>0?
        rounded(netUsd/settled):null,
      winRate:ratio(wins,settled),
      winners:wins,losers:losses,flat:breakeven,
      sumPositiveNetUsd:settled>0?rounded(winningUsd):null,
      sumNegativeNetUsd:settled>0?rounded(losingUsd):null,
      profitFactor:losingUsd<0?winningUsd/(-losingUsd):null,
      signedCommissionUsd:settled>0?rounded(commissionUsd):null,
      positivePeakThenNetLossTrades:positivePeakThenNetLoss,
      positivePeakThenNetLossRate:ratio(positivePeakThenNetLoss,settled),
      observedGivebackSamples:givebackSamples,
      observedGivebackUsd:givebackSamples>0?rounded(givebackUsd):null,
      closeStates:statusCounts,
    },
    confirmedStopFollowup:{
      confirmedBrokerStopTrades:confirmedStops,
      priceObservedAfterStop:stopFollowup,
      followupMissing:missingFollowup,
      originalFillReclaimedAtSample:reclaims,
      partialBounceAtSample:partialBounces,
      noRecoveryAtSample:noReclaims,
      reclaimRateAmongObservedStops:ratio(reclaims,stopFollowup),
      unknownBrokerClosesNearSL:nearStopUnconfirmed,
    },
    directionalDecisionEpisodeCohort:horizons,
    executedDecisionEpisodeCohort:executedHorizons,
    evidence,
    decision:'RESEARCH_ONLY_NO_AUTOMATIC_STRATEGY_PROMOTION',
    evidenceStatus:evidence.sufficientForExploration?
      'ENOUGH_FOR_FURTHER_VALIDATION_NOT_DEPLOYMENT':
      'INSUFFICIENT_INDEPENDENT_AFTER_COST_EVIDENCE',
  };
}
function compileStrategyScorecard(stops,directions){
  assertCompatible(stops,directions);
  const rows=stops.examples.filter(r=>r&&
    !['OUT_OF_SCOPE','INCOMPLETE'].includes(r.state));
  const byStrategy={};
  for(const route of ROUTES){
    byStrategy[route]=compareRoute(
      rows.filter(x=>x.strategyRoute===route),
      directions.byRoute[route]||{},
      directions.byExecutedRoute?.[route]||{},
    );
  }
  const unclassified=rows.filter(x=>!ROUTES.includes(x.strategyRoute));
  return {
    artifact:'irexpro-owner-demo-strategy-comparison-v1',
    researchOnly:true,
    modifiesExecution:false,
    asOf:stops.asOf,
    directionalReplayAsOf:directions.asOf,
    instruments:stops.instruments,
    routes:[...ROUTES],
    byStrategy,
    unclassifiedClosedTrades:unclassified.length,
    interpretation:[
      'Realized USD P&L, close reasons and post-stop price marks are from CLOSED broker trades only.',
      'Directional hit rates and R proxies come from 20-minute de-duplicated SCANNER DECISION episodes, not necessarily executed orders.',
      'The three cohorts (completed trades, all scanner episodes, executed-decision episodes) lack a verified one-to-one identifier. Never mix their denominators or treat a directional hit as a realized win.',
      'Price reclamation after an actual exit cannot prove a wider stop would survive intraminute volatility or improve realized net returns.',
      'No score or threshold can authorize an order, disable risk gates, change broker stops, raise lot size, or promote a model to LIVE.',
      'Portable source reports are redacted: their same-owner broker account linkage cannot be cryptographically established from these two files alone. Generate both on the same authorized host session.',
    ],
    promotionAllowed:false,
  };
}
function arg(prefix){
  const x=process.argv.find(v=>v.startsWith(prefix));
  return x?x.slice(prefix.length):null;
}
function main(){
  const stopsPath=arg('--stops='),directionsPath=arg('--directions=');
  if(!stopsPath||!directionsPath)throw Error('BOTH_READ_ONLY_REPORT_PATHS_REQUIRED');
  const stops=JSON.parse(fs.readFileSync(path.resolve(stopsPath),'utf8'));
  const directions=JSON.parse(fs.readFileSync(path.resolve(directionsPath),'utf8'));
  const report=compileStrategyScorecard(stops,directions);
  const out=arg('--out=');
  if(out){
    const name=path.resolve(out);
    fs.writeFileSync(name,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log('STRATEGY_RESEARCH_WRITTEN '+name);
  }
  console.log(JSON.stringify(report,null,2));
}
module.exports={ROUTES,HORIZONS,compareRoute,compileStrategyScorecard};
if(require.main===module){
  try{main();}catch(error){
    console.error('STRATEGY_COMPARISON_ABORTED',error.message);
    process.exitCode=1;
  }
}
