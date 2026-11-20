'use strict';

/**
 * Evaluates already-persisted, prospective DEMO profit-lock HOLD/CLOSE
 * recommendations against later, quote-verified shadow hold outcomes.
 * No model weights, broker orders, margin, stops, or closes are changed.
 */
const ARTIFACT = 'irexpro-owner-demo-profit-lock-hold-validation-v1';
const HORIZONS = Object.freeze([15, 30, 60]);
const VALID_STATES = new Set([
  'OPEN_AT_HORIZON', 'POSSIBLE_STOP_FIRST', 'POSSIBLE_TARGET_FIRST',
  'SAME_BAR_AMBIGUITY', 'DATA_GAP', 'MONEY_CONVERSION_UNAVAILABLE',
]);

const number = value => {
  if(value===null || value===undefined || value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
};
const time = value => {
  if(!value)return null;
  const ms=new Date(value).getTime();
  return Number.isFinite(ms)?ms:null;
};
const round = value => Math.round(value * 10000) / 10000;
const readJson = x => {
  if(typeof x==='string'){
    try{return JSON.parse(x)}catch{return null}
  }
  return x&&typeof x==='object'&&!Array.isArray(x)?x:null;
};

function validateShadowRow(row){
  const result=readJson(row?.response),audit=readJson(row?.audit);
  if(row?.account_currency!=='USD'||row?.close_reason!=='PROFIT_PROTECTION'||
      row?.status!=='CLOSED')return {status:'WRONG_SCOPE'};
  if(!result || result.mode!=='SHADOW_ONLY'||result.modifiesExecution!==false ||
      result.artifact!=='exit-alternatives-verified-m1-v2' ||
      result.brokerFillCertified!==false || !Array.isArray(result.holdHorizonSnapshots))
    return {status:'MISSING_VERIFIED_SHADOW'};
  if(!audit || audit.mode!=='SHADOW_ONLY'||audit.noTradeAuthority!==true ||
      !['HOLD_CANDIDATE','CLOSE_CANDIDATE'].includes(audit.recommendation) ||
      audit.originalCloseReason!=='PROFIT_PROTECTION')
    return {status:'AS_OF_PROSPECTIVE_DECISION_MISSING'};
  const at=time(audit.observedAt),snapshot=time(result.snapshotAt),closed=time(row.closed_at);
  if(at===null||snapshot===null||closed===null ||
    Math.abs(at-snapshot)>10000 || at>closed+10000 || at<closed-120000)
    return {status:'DECISION_OUTCOME_TIME_MISMATCH'};
  const gross=number(row.realised_pnl),fee=number(row.commission),swap=number(row.swap);
  const proxyOriginal=number(result.originalNetPnl);
  if(gross===null||fee===null||swap===null||fee>0||proxyOriginal===null)
    return {status:'INCOMPLETE_FINANCIAL_SETTLEMENT'};
  const actualNet=round(gross+fee+swap);
  if(Math.abs(actualNet-proxyOriginal)>.03)
    return {status:'SETTLED_NET_DISAGREES_WITH_SHADOW'};
  const route=['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION']
    .includes(row.strategy_route)?row.strategy_route:'UNCLASSIFIED';
  const horizons={};
  for(const minutes of HORIZONS){
    const matches=result.holdHorizonSnapshots.filter(s=>s?.completedBars===minutes);
    if(matches.length!==1 || !VALID_STATES.has(matches[0].state)){
      horizons[minutes+'m']={state:'MISSING_HORIZON',deltaUsd:null};
      continue;
    }
    const h=matches[0];
    if(h.state!=='OPEN_AT_HORIZON'){
      horizons[minutes+'m']={state:h.state,deltaUsd:null};
      continue;
    }
    const quote=time(h.quoteAt),delta=number(h.deltaVsActualClose);
    const net=number(h.indicativeNetPnl);
    const original=number(h.actualNetPnl);
    // A favorable future mark is not a broker fill and is NEVER a reason
    // to remove the existing protection. Reject mismatched/corrupt artifacts.
    if(quote===null||quote<=snapshot||quote>snapshot+(minutes+3)*60000 ||
       delta===null||net===null||original===null||
       Math.abs(actualNet-original)>.03||
       Math.abs(round(net-actualNet)-delta)>.03){
      horizons[minutes+'m']={state:'UNRECONCILED_HORIZON',deltaUsd:null};
      continue;
    }
    horizons[minutes+'m']={state:h.state,deltaUsd:round(delta),
      hypotheticalNetUsd:round(net),actualNetUsd:actualNet,
      indicativeOnly:true};
  }
  return {
    status:'VALID',route,recommendation:audit.recommendation,
    patienceRecommendation:readJson(audit.protectedGraceShadow)?.wouldConsiderBrokerProtectedGrace===true,
    runnerEligible:readJson(audit.runnerShadow)?.eligibleForFurtherResearch===true,
    actualNetUsd:actualNet,commissionUsd:fee,
    profitPeakUsd:number(row.max_favorable_pnl),
    profitGivebackUsd:number(row.profit_giveback),
    horizons,
  };
}
function summarize(rows) {
  const all=rows.map(validateShadowRow);
  const excluded={};
  const valid=all.filter(x=>{
    if(x.status==='VALID')return true;
    excluded[x.status]=(excluded[x.status]||0)+1;
    return false;
  });
  const group=rows=>{
    const directionGroups={};
    for(const recommendation of ['HOLD_CANDIDATE','CLOSE_CANDIDATE']){
      const subset=rows.filter(x=>x.recommendation===recommendation);
      const buckets={};
      for(const minutes of HORIZONS){
        const key=minutes+'m';
        let open=0,better=0,worse=0,same=0,deltaSum=0,positiveSum=0,
          negativeSum=0;
        const censor={};
        for(const row of subset){
          const h=row.horizons[key];
          if(h.state!=='OPEN_AT_HORIZON'||h.deltaUsd===null){
            censor[h.state]=(censor[h.state]||0)+1;
            continue;
          }
          open++;
          deltaSum+=h.deltaUsd;
          if(h.deltaUsd>.01){better++;positiveSum+=h.deltaUsd;}
          else if(h.deltaUsd<-.01){worse++;negativeSum+=h.deltaUsd;}
          else same++;
        }
        buckets[key]={
          recommendationCount:subset.length,
          quoteVerifiedBarrierFreeCohort:open,
          censoredOrUnavailable:subset.length-open,
          censorReasons:censor,
          proxyImprovedCount:better,proxyWorsenedCount:worse,proxyTiedCount:same,
          meanProxyDeltaUsd:open?round(deltaSum/open):null,
          totalProxyDeltaUsd:open?round(deltaSum):null,
          sumPositiveDeltaUsd:open?round(positiveSum):null,
          sumNegativeDeltaUsd:open?round(negativeSum):null,
          improvementRateOnlyOnUncensoredMarks:open?better/open:null,
          mode:'RETROSPECTIVE_SHADOW_MARK_TO_MARKET_NOT_FILLED_ORDER',
        };
      }
      directionGroups[recommendation]={
        prospectiveDecisions:subset.length,
        protectedGraceCandidates:subset.filter(r=>r.patienceRecommendation).length,
        protectedRunnerCandidates:subset.filter(r=>r.runnerEligible).length,
        recordedActualNetUsd:subset.length?round(subset.reduce((a,b)=>a+b.actualNetUsd,0)):null,
        totalRecordedCommissionUsd:subset.length?round(subset.reduce((a,b)=>a+b.commissionUsd,0)):null,
        outcomes:buckets,
      };
    }
    return directionGroups;
  };
  const byRoute={};
  for(const route of ['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION','UNCLASSIFIED'])
    byRoute[route]=group(valid.filter(x=>x.route===route));
  return {
    artifact:ARTIFACT,researchOnly:true,modifiesExecution:false,promotable:false,
    sourceArtifact:'exit-alternatives-verified-m1-v2',
    inputRows:rows.length,validProspectiveComparisons:valid.length,
    excluded,allRecommendations:group(valid),byRoute,
    caution:[
      'The prospective HOLD/CLOSE decision was logged before future M1 bars; future data is used only to evaluate outcomes.',
      'Only completed, contiguous, quote-verified 15/30/60-minute shadow paths without possible SL/TP touches have a price/P&L delta.',
      'Censoring makes the uncensored subset selected: improvement rate is NOT a population success rate or a realizable strategy return.',
      'Gross P&L converts future price to USD using historical broker fill conversion, with signed already-settled commission and swap. Actual future FX conversion, spreads, swap, market impact and fills are UNKNOWN.',
      'Profit protection remains active: shadow HOLD is never permission to extend a trade, bypass a stop, change size or disable automatic closure.',
      'No LIVE or DEMO trading configuration was changed.',
    ],
  };
}
module.exports={ARTIFACT,HORIZONS,validateShadowRow,summarize};
