'use strict';

/**
 * PEPPERSTONE USD DEMO RESEARCH ONLY.
 * A chronology-correct commission-aware advisory reconstruction. The
 * policy threshold is diagnostic; it never changes execution or positions.
 * Trading P&L of filtered subsets is selection-biased and NOT a backtest of
 * a future broker strategy.
 */
const { commissionShadowAtEntry } = require('./research-causal-commission-estimator.cjs');
const ARTIFACT = 'irexpro-owner-demo-commission-routing-shadow-v1';
const ROUTES = ['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION'];
const SEVEN_DAYS = 7*86400000;
const MIN_PRIOR = 5;
const EXPLORATORY_EXPECTED_AFTER_FEE_FLOOR_R = 0.08;
function num(x) {
  if (x===null || x===undefined || x==='') return null;
  const n=Number(x);return Number.isFinite(n)?n:null;
}
function time(x) { if (!x) return null;const n=Date.parse(x);return Number.isFinite(n)?n:null; }
function rounded(x) {return x===null?null:Number(x.toFixed(4));}
function validateRow(row) {
  if (!row || !ROUTES.includes(row.route) || !['EURUSD','AUDUSD','USDJPY','USDCAD'].includes(row.instrument) ||
    row.accountCurrency!=='USD' || !row.brokerConnectionId ||
    time(row.openedAt)===null || time(row.closedAt)===null ||
    time(row.closedAt)<time(row.openedAt) || ![row.lots,row.commission,row.grossPnl,row.swap].every(v=>num(v)!==null) ||
    num(row.lots)<=0 || num(row.commission)>0 || num(row.lots)>100)
    return false;
  const risk=num(row.initialCashRisk);
  return risk!==null&&risk>0 && time(row.allocationCreatedAt)!==null &&
    time(row.allocationCreatedAt)<=time(row.openedAt);
}
function newGroup() {
  return {tradeCount:0,qualifiedCostForecasts:0,insufficientPriorSamePairFees:0,
    staleOrMissingModelForecast:0,shadowBelowFloor:0,shadowAtOrAboveFloor:0,
    sumPredictedCommissionR:0,sumActualCommissionR:0,sumAbsCommissionErrorR:0,
    sumPredictedAfterFeeR:0,
    keptNetCash:0,flaggedNetCash:0,keptTrades:0,flaggedTrades:0,
    missingReconciliation:0,flaggedNetWinners:0,keptNetLosers:0};
}
function evaluate(rows,{from,asOf,brokerConnectionId}={}) {
  if (!Array.isArray(rows)||rows.length>2000)throw Error('BAD_SIZE');
  const fromMs=time(from),asOfMs=time(asOf);
  if (fromMs===null||asOfMs===null||asOfMs-fromMs<0||asOfMs-fromMs>SEVEN_DAYS+60000)
    throw Error('INVALID_RESEARCH_EVALUATION_WINDOW');
  if (!brokerConnectionId||rows.some(x=>x.brokerConnectionId!==brokerConnectionId))
    throw Error('MIXED_BROKER_ACCOUNT');
  // All rows from the one broker, including history before evaluation window.
  const eligible=rows.filter(validateRow).sort((a,b)=>time(a.openedAt)-time(b.openedAt));
  const current=eligible.filter(x=>time(x.openedAt)>=fromMs&&time(x.openedAt)<asOfMs);
  const invalidRecentRecords=rows.filter(x=>time(x.openedAt)>=fromMs&&time(x.openedAt)<asOfMs&&!validateRow(x));
  const invalidRecent=invalidRecentRecords.length;
  const invalidRecentReasonCounts={
    unclassifiedStrategy:0,unsupportedInstrument:0,
    missingOrFutureDatedAllocationRisk:0,
    missingOrNonstandardRecordedCommission:0,otherInvalidTradeEvidence:0,
  };
  for(const r of invalidRecentRecords){
    const risk=num(r.initialCashRisk);
    if(!ROUTES.includes(r.route))invalidRecentReasonCounts.unclassifiedStrategy++;
    else if(!['EURUSD','AUDUSD','USDJPY','USDCAD'].includes(r.instrument))
      invalidRecentReasonCounts.unsupportedInstrument++;
    else if(risk===null||risk<=0||time(r.allocationCreatedAt)===null||
       time(r.openedAt)===null||time(r.allocationCreatedAt)>time(r.openedAt))
      invalidRecentReasonCounts.missingOrFutureDatedAllocationRisk++;
    else if(num(r.commission)===null||num(r.commission)>0)
      invalidRecentReasonCounts.missingOrNonstandardRecordedCommission++;
    else invalidRecentReasonCounts.otherInvalidTradeEvidence++;
  }
  const byRoute=Object.fromEntries(ROUTES.map(route=>[route,newGroup()]));
  const total=newGroup();
  const atRiskUnderforecast=[];
  for (const row of current) {
    const g=byRoute[row.route],groups=[g,total];
    groups.forEach(k=>k.tradeCount++);
    const estimate=commissionShadowAtEntry({
      instrument:row.instrument,openedAt:row.openedAt,lots:row.lots,
      initialCashRisk:row.initialCashRisk,accountCurrency:row.accountCurrency,
      brokerConnectionId:row.brokerConnectionId,
      preExistingExpectedNetR:row.preExistingExpectedNetR,
    },eligible,{minPrior:MIN_PRIOR,lookbackMs:SEVEN_DAYS});
    if (estimate.state!=='SHADOW_ESTIMATE' ||
      !(estimate.p90CommissionPerLot>0) || !(estimate.predictedCommissionR>0)){
      groups.forEach(k=>k.insufficientPriorSamePairFees++);continue;
    }
    // Do not suggest a veto if model's ex-ante estimate is missing.
    if (num(row.preExistingExpectedNetR)===null || !Number.isFinite(estimate.predictedAfterCommissionR)){
      groups.forEach(k=>k.staleOrMissingModelForecast++);continue;
    }
    const actualCommissionR=Math.abs(num(row.commission))/num(row.initialCashRisk);
    const feeError=Math.abs(actualCommissionR-estimate.predictedCommissionR);
    const netCash=num(row.grossPnl)+num(row.commission)+num(row.swap);
    const shadowBelow=estimate.predictedAfterCommissionR<EXPLORATORY_EXPECTED_AFTER_FEE_FLOOR_R;
    groups.forEach(k=>{
      k.qualifiedCostForecasts++;
      k.sumPredictedCommissionR+=estimate.predictedCommissionR;
      k.sumActualCommissionR+=actualCommissionR;
      k.sumAbsCommissionErrorR+=feeError;
      k.sumPredictedAfterFeeR+=estimate.predictedAfterCommissionR;
      if (shadowBelow) {
        k.shadowBelowFloor++;k.flaggedTrades++;k.flaggedNetCash+=netCash;
        if(netCash>0)k.flaggedNetWinners++;
      }else{
        k.shadowAtOrAboveFloor++;k.keptTrades++;k.keptNetCash+=netCash;
        if(netCash<0)k.keptNetLosers++;
      }
    });
    // Account identifiers and precise trade history never leave private repo/VPS.
    if (actualCommissionR>estimate.predictedCommissionR+1e-8)
      atRiskUnderforecast.push({instrument:row.instrument,route:row.route});
  }
  function finalize(g) {
    const n=g.qualifiedCostForecasts;
    return {
      trades:g.tradeCount,
      usableCausalCommissionEstimate:n,
      notEnoughPriorClosedSameInstrument:g.insufficientPriorSamePairFees,
      missingPreEntryModelForecast:g.staleOrMissingModelForecast,
      commissionForecastMeanR:n?rounded(g.sumPredictedCommissionR/n):null,
      observedCommissionMeanR:n?rounded(g.sumActualCommissionR/n):null,
      commissionForecastMAE_R:n?rounded(g.sumAbsCommissionErrorR/n):null,
      predictedAfterCommissionMeanR:n?rounded(g.sumPredictedAfterFeeR/n):null,
      exploratoryPredictedBelow008R:g.shadowBelowFloor,
      exploratoryPredictedAtOrAbove008R:g.shadowAtOrAboveFloor,
      flaggedHistoricalClosedTrades:g.flaggedTrades,
      flaggedHistoricalNetWinners:g.flaggedNetWinners,
      keptHistoricalClosedTrades:g.keptTrades,
      keptHistoricalNetLosers:g.keptNetLosers,
      flaggedHistoricalNetCashUSD:rounded(g.flaggedNetCash),
      keptHistoricalNetCashUSD:rounded(g.keptNetCash),
    };
  }
  return {
    artifact:ARTIFACT,from:new Date(fromMs).toISOString(),asOf:new Date(asOfMs).toISOString(),
    researchOnly:true,brokerOrderAuthority:false,modifiesExecution:false,
    livePromotionAllowed:false,modelPromotionAllowed:false,
    historicalRows:rows.length,
    sampleClosedTrades:current.length,
    excludedIncompleteOrUnclassifiedRecentTrades:invalidRecent,
    excludedRecentReasons:invalidRecentReasonCounts,
    total:finalize(total),byRoute:Object.fromEntries(ROUTES.map(x=>[x,finalize(byRoute[x])])),
    underforecastCommissionCases:atRiskUnderforecast.length,
    thresholdR:EXPLORATORY_EXPECTED_AFTER_FEE_FLOOR_R,
    methodology:[
      'Commission forecast uses p90 of at least five strictly earlier CLOSED same-account, same-instrument commission-per-lot records from the previous seven days.',
      'The fixed 0.08R floor is exploratory research only: no execution code reads or applies this flag.',
      'The model forecast was stored at order entry but excludes broker commission; the shadow subtracts an estimate using past closed trades only.',
      'The flagged and unflagged actual returns are descriptive subsets, NOT causal performance improvements or net savings; skipped trades would have changed market exposure.',
      'All recorded commission and swap terms use account-currency USD; modeled spread/slippage is not charged twice.',
      'A lack of five earlier fee observations is INSUFFICIENT_HISTORY, never a reason to block live trades in this pilot.',
      'No extra lots, changed stops, live promotion, risk-veto changes, or automatic broker fees are authorized.',
    ],
  };
}
module.exports={ARTIFACT,ROUTES,MIN_PRIOR,EXPLORATORY_EXPECTED_AFTER_FEE_FLOOR_R,validateRow,evaluate};
