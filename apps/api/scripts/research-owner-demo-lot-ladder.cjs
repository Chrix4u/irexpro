'use strict';

/**
 * Historical position-size sensitivity, not executable trade sizing.
 * It cannot reconstruct slippage, margin, stop-barrier path or market impact.
 * Owner-scoped DEMO inputs must be sourced by the read-only runner.
 */
const LOTS=Object.freeze([3,4,5,6,7]);
const ARTIFACT='irexpro-owner-demo-lot-ladder-research-v1';
const MAX_EXTRAPOLATION_FACTOR=5;
const MIN_ORIGINAL_LOTS=.5;

function num(v){
  if(v===null||v===undefined||v==='')return null;
  const x=Number(v);return Number.isFinite(x)?x:null;
}
function round(v){return Math.round((v+Number.EPSILON)*100)/100;}
function legitimate(row){
  if(!row||row.status!=='CLOSED'||row.account_currency!=='USD')return false;
  if(!['BUY','SELL'].includes(row.direction))return false;
  if(!['EURUSD','AUDUSD','USDCAD','USDJPY'].includes(row.instrument))return false;
  const lot=num(row.lot_size),gross=num(row.realised_pnl),commission=num(row.commission),swap=num(row.swap);
  return lot!==null&&lot>0&&gross!==null&&commission!==null&&swap!==null&&commission<=0;
}
function scenario(row,targetLots,riskLimitUsd){
  if(!legitimate(row))return {status:'INCOMPLETE_SETTLED_BROKER_EVIDENCE'};
  if(!Number.isFinite(targetLots)||targetLots<=0||!Number.isFinite(riskLimitUsd)||riskLimitUsd<=0)
    throw Error('INVALID_SCENARIO_INPUT');
  const originalLots=num(row.lot_size),risk=num(row.initial_risk);
  const multiplier=targetLots/originalLots;
  if(originalLots<MIN_ORIGINAL_LOTS||multiplier>MAX_EXTRAPOLATION_FACTOR)
    return {status:'EXTRAPOLATION_NOT_COMPARABLE',originalLots,targetLots,multiplier};
  const gross=num(row.realised_pnl)*multiplier;
  const commission=num(row.commission)*multiplier;
  const swap=num(row.swap)*multiplier;
  const net=gross+commission+swap;
  const cost=Math.abs(commission+swap);
  const riskKnown=risk!==null&&risk>0;
  const projectedRiskUsd=riskKnown?round(risk*multiplier):null;
  const riskBudgetPass=riskKnown?projectedRiskUsd<=riskLimitUsd:null;
  const status=riskBudgetPass===null?'STOP_RISK_UNVERIFIED':
    riskBudgetPass?'WITHIN_STOP_RISK_CAP_OTHER_GATES_UNVERIFIED':'EXCEEDS_STOP_RISK_CAP';
  const peak=num(row.max_favorable_pnl),giveback=num(row.profit_giveback);
  return {
    status,originalLots,targetLots,multiplier:round(multiplier),
    historicalOriginalNetUsd:round(num(row.realised_pnl)+num(row.commission)+num(row.swap)),
    hypotheticalGrossUsd:round(gross),hypotheticalCommissionUsd:round(commission),
    hypotheticalSwapUsd:round(swap),hypotheticalNetUsd:round(net),
    hypotheticalFeeOutlayUsd:round(cost),hypotheticalStopRiskUsd:projectedRiskUsd,
    riskBudgetPass,
    hypotheticalPeakUsd:peak!==null?round(peak*multiplier):null,
    hypotheticalGivebackUsd:giveback!==null&&giveback>=0?round(giveback*multiplier):null,
    classification:'SAME_SETTLED_PRICE_PATH_LINEAR_SCALING_ONLY',
  };
}
function reportLadder(rows,opts){
  const equity=num(opts?.equityUsd),riskPercent=num(opts?.riskPercent);
  if(equity===null||equity<=0||riskPercent===null||riskPercent<=0||riskPercent>1)
    throw Error('EQUITY_AND_CONSERVATIVE_STOP_RISK_BUDGET_REQUIRED');
  const maxLoss=round(equity*riskPercent/100);
  const valid=rows.filter(legitimate);
  const results={};
  for(const targetLots of LOTS){
    const states={};let comparable=0,within=0,exceeds=0,unverified=0;
    let hypNet=0,hypCommission=0,baselineNet=0,acceptedNet=0,negative=0;
    const byRoute={};
    for(const row of rows){
      const out=scenario(row,targetLots,maxLoss);
      states[out.status]=(states[out.status]||0)+1;
      if(out.classification!=='SAME_SETTLED_PRICE_PATH_LINEAR_SCALING_ONLY')continue;
      comparable++;
      baselineNet+=out.historicalOriginalNetUsd;
      hypNet+=out.hypotheticalNetUsd;
      hypCommission+=out.hypotheticalCommissionUsd;
      if(out.hypotheticalNetUsd<0)negative++;
      if(out.riskBudgetPass===true){within++;acceptedNet+=out.hypotheticalNetUsd;}
      else if(out.riskBudgetPass===false)exceeds++;
      else unverified++;
      const route=['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION'].includes(row.strategy_route)
        ?row.strategy_route:'UNCLASSIFIED';
      const z=byRoute[route]||={count:0,historicalNetUsd:0,hypotheticalNetUsd:0,
        hypotheticalCommissionUsd:0,riskBudgetPasses:0};
      z.count++;z.historicalNetUsd+=out.historicalOriginalNetUsd;
      z.hypotheticalNetUsd+=out.hypotheticalNetUsd;
      z.hypotheticalCommissionUsd+=out.hypotheticalCommissionUsd;
      if(out.riskBudgetPass===true)z.riskBudgetPasses++;
    }
    for(const x of Object.values(byRoute)){
      x.historicalNetUsd=round(x.historicalNetUsd);
      x.hypotheticalNetUsd=round(x.hypotheticalNetUsd);
      x.hypotheticalCommissionUsd=round(x.hypotheticalCommissionUsd);
    }
    results[targetLots+'lots']={targetLots,settledComparableTrades:comparable,
      riskBudgetPasses:within,riskBudgetExceedances:exceeds,stopRiskUnverified:unverified,
      outcomeNegativeCount:negative,historicalNetUsdForComparable:comparable?round(baselineNet):null,
      hypotheticalNetUsdForSameMoves:comparable?round(hypNet):null,
      hypotheticalTotalCommissionUsd:comparable?round(hypCommission):null,
      hypotheticalNetOfRiskBudgetPasses:within?round(acceptedNet):null,
      byRoute,states};
  }
  return {
    artifact:ARTIFACT,researchOnly:true,modifiesExecution:false,
    equityBasis:'OWNER_REPORTED_NOT_BROKER_VERIFIED',equityUsd:equity,
    riskPercent,riskLimitUsd:maxLoss,
    study:'LINEAR_LOT_SENSITIVITY_ON_HISTORIC_SETTLED_BROKER_PRICE_PATHS',
    settledEligibleTrades:valid.length,totalInputTrades:rows.length,
    targetLotSizes:[...LOTS],maxExtrapolationFactor:MAX_EXTRAPOLATION_FACTOR,
    resultByLot:results,
    cautions:[
      'Historical net outcomes scaled by lots are NOT achievable-fills forecasts, a projected account balance, or a new strategy.',
      'The win rate is unchanged by linear lot scaling. Losing trades and two-sided commissions scale up alongside winning trades.',
      'Risk-at-stop is based on original broker fill and initial risk evidence; missing values are NOT treated as zero.',
      'Passing the stop-risk budget is NOT executable approval: broker free margin, lot increments, live spreads, stop geometry, slippage and exposure remain unverified.',
      'The supplied equity is an owner observation, not an independently reconciled broker balance or equity snapshot.',
      'No stop-loss, take-profit, model side, lot setting or active trading session is changed by this study.',
    ],
  };
}
module.exports={ARTIFACT,LOTS,legitimate,scenario,reportLadder};
