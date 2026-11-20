'use strict';
/**
 * Owner DEMO recovery warnings: outcome scorecard, NOT exit authority.
 * Includes BOTH warned and unwarned positions, winner/loser attrition,
 * missing quotes and distinct trading days. Never counts repeated signals
 * on one position as distinct broker gains/losses.
 */
const ARTIFACT='irexpro-owner-demo-recovery-forward-evaluation-v1';
const RISK_STATES=new Set([
 'TOWARD_ORIGINAL_STOP','POSITIVE_PEAK_GIVEBACK_WITH_COUNTER_MOMENTUM',
]);
const VALID_STATES=new Set([
 ...RISK_STATES,'COUNTER_MOMENTUM_WATCH','NO_STRONG_REVERSAL_WARNING',
]);
const HORIZONS=Object.freeze([5,10,15,20]);
const ROUTES=Object.freeze(['EARLY_TRANSITION','CONFIRMED_REVERSAL']);
const rnd=x=>Number(x.toFixed(2));
const day=x=>String(x||'').slice(0,10);
const compact=t=>Object.values(t.snapshots||{}).filter(s=>s&&s.signal&&s.signal.state);
function cohorts(trades,route=null){
 const list=route?trades.filter(t=>t.route===route):trades;
 const groups={WARNED:[],UNWARNED:[],INSUFFICIENT_OR_MISSING_EVIDENCE:[]};
 for(const t of list){
  const ss=compact(t);
  if(ss.some(s=>RISK_STATES.has(s.signal.state)))groups.WARNED.push(t);
  else if(ss.some(s=>VALID_STATES.has(s.signal.state)))groups.UNWARNED.push(t);
  else groups.INSUFFICIENT_OR_MISSING_EVIDENCE.push(t);
 }
 return groups;
}
function money(t){
 const raw=t.settled?.netUsd;
 if(raw===null||raw===undefined||raw==='')return null;
 const x=Number(raw);
 return Number.isFinite(x)?x:null;
}
function cohortStats(trades){
 const settled=trades.filter(t=>money(t)!==null);
 const wins=settled.filter(t=>money(t)>0),loss=settled.filter(t=>money(t)<0);
 const cash=list=>rnd(list.reduce((v,t)=>v+money(t),0));
 const quoteCoverage=trades.flatMap(compact);
 const scoreable=quoteCoverage.filter(s=>VALID_STATES.has(s.signal.state));
 return {
  tradeCount:trades.length,distinctTradeIds:new Set(trades.map(t=>t.tradeId)).size,
  scoredPositions:trades.filter(t=>compact(t).some(s=>VALID_STATES.has(s.signal.state))).length,
  scoreableSnapshots:scoreable.length,
  unscorableSnapshots:quoteCoverage.length-scoreable.length,
  settledTrades:settled.length,openOrUnsettled:trades.length-settled.length,
  afterCostWinners:wins.length,afterCostLosers:loss.length,
  winningNetUsd:cash(wins),losingNetUsd:cash(loss),
  totalActualBrokerNetUsd:cash(settled),
  winRateAfterCosts:settled.length?rnd(wins.length/settled.length*100):null,
  originalEntryDays:[...new Set(trades.map(t=>day(t.openedAt)))].sort(),
  winnerLossFromHypotheticalBlanketCloseUnknown:true,
 };
}
function leadTimeStats(trades){
 const records=trades.flatMap(t=>{
  if(!t.settled||!Number.isFinite(Date.parse(t.settled.closedAt)))return [];
  const warnings=compact(t).filter(s=>RISK_STATES.has(s.signal.state))
   .map(s=>Date.parse(s.at)).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!warnings.length)return [];
  const delay=(Date.parse(t.settled.closedAt)-warnings[0])/1000;
  return [delay];
 });
 const valid=records.filter(x=>x>=0),late=records.filter(x=>x<0);
 return {warnedSettledWithTimestamp:records.length,
  warningBeforeActualClose:valid.length,
  warningAtOrAfterActualClose:late.length,
  warningLeadAtLeast10Seconds:valid.filter(x=>x>=10).length,
  warningLeadAtLeast30Seconds:valid.filter(x=>x>=30).length,
  warningLeadAtLeast60Seconds:valid.filter(x=>x>=60).length,
  meanLeadSeconds:valid.length?rnd(valid.reduce((a,b)=>a+b,0)/valid.length):null,
  timingIsNotEvidenceOfExecutableBrokerClose:true};
}
// Separate early still-net-positive cautions from severe warnings. Being
// positive at quote time does not imply a broker fill was obtainable.
function earlyProfitCautionScore(trades){
 const alerted=trades.filter(t=>compact(t).some(s=>
  s.signal.earlyFeeCoveredProfitFadeWatchOnly===true));
 const matched=alerted.filter(t=>money(t)!==null);
 const lead=matched.map(t=>{
  const at=compact(t).filter(s=>s.signal.earlyFeeCoveredProfitFadeWatchOnly===true)
   .map(s=>Date.parse(s.at)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  return (Date.parse(t.settled.closedAt)-at)/1000;
 }).filter(Number.isFinite);
 const positive=alerted.flatMap(t=>compact(t).filter(s=>
  s.signal.earlyFeeCoveredProfitFadeWatchOnly===true));
 return {
  ...cohortStats(alerted),
  totalEarlyCautionSnapshots:positive.length,
  firstCautionBeforeClose:lead.filter(x=>x>=0).length,
  firstCautionBeforeCloseAtLeast30Seconds:lead.filter(x=>x>=30).length,
  firstCautionBeforeCloseAtLeast60Seconds:lead.filter(x=>x>=60).length,
  firstCautionBeforeCloseAtLeast120Seconds:lead.filter(x=>x>=120).length,
  earliestCautionTheoreticalNetPositiveSnapshots:positive.filter(s=>
   s.signal.hypotheticalNetAfterFeeEstimateUsd>0).length,
  quoteOnlyNotExecutable:true,neverAutoClose:true,
  noPromotionWithoutWinnerAndLoserForwardComparison:true,
 };
}
function horizonStats(records){
 const states={};
 const validQuote=records.filter(r=>r.actual?.state==='REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY');
 const settledCloses=records.filter(r=>r.actual?.state==='ACTUAL_POSITION_CLOSED_BEFORE_HORIZON');
 for(const r of records){
  const state=r.actual?.state||'PENDING';
  states[state]=(states[state]||0)+1;
 }
 return {
  prospectiveSnapshots:records.length,
  observedOutcomeRecords:records.filter(r=>r.actual).length,
  pending:records.filter(r=>!r.actual).length,
  actualBrokerClosesBeforeHorizon:settledCloses.length,
  actualBrokerClosedNetPositive:settledCloses.filter(r=>r.actual.actualBrokerNetUsd>0).length,
  actualBrokerClosedNetNegative:settledCloses.filter(r=>r.actual.actualBrokerNetUsd<0).length,
  actualBrokerCloseEconomicsUnknown:settledCloses.filter(r=>r.actual.actualBrokerNetUsd===null).length,
  quoteOnlyMarks:validQuote.length,
  quoteOnlyFavorableAfterSnapshot:validQuote.filter(r=>
   Number.isFinite(r.initial?.grossMarketMarkEstimateUsd)&&
   Number.isFinite(r.actual.theoreticalGrossUsd)&&
   r.actual.theoreticalGrossUsd>r.initial.grossMarketMarkEstimateUsd).length,
  quoteOnlyAdverseAfterSnapshot:validQuote.filter(r=>
   Number.isFinite(r.initial?.grossMarketMarkEstimateUsd)&&
   Number.isFinite(r.actual.theoreticalGrossUsd)&&
   r.actual.theoreticalGrossUsd<r.initial.grossMarketMarkEstimateUsd).length,
  quoteOnlyMarkMoveUnknown:validQuote.filter(r=>
   !Number.isFinite(r.initial?.grossMarketMarkEstimateUsd)||
   !Number.isFinite(r.actual.theoreticalGrossUsd)).length,
  quoteOnlyEstimatedNetPositive:validQuote.filter(r=>r.actual.quoteOnlyAboveEstimatedCost===true).length,
  quoteOnlyEstimatedNetNonpositive:validQuote.filter(r=>r.actual.quoteOnlyAboveEstimatedCost===false).length,
  quoteOnlyCostEvidenceMissing:validQuote.filter(r=>r.actual.quoteOnlyAboveEstimatedCost===null).length,
  statusCounts:states,
  quoteMarksAreNotExecutableExits:true,
 };
}
function independentDays(ts){
 return [...new Set(ts.filter(t=>money(t)!==null).map(t=>day(t.openedAt)))].sort();
}
function evaluate(trades,now=new Date()){
 const all=[...trades],perRoute={};
 for(const route of ROUTES){
  const group=cohorts(all,route),warned=group.WARNED,unwarned=group.UNWARNED;
  const wd=independentDays(warned),ud=independentDays(unwarned);
  const days=[...new Set([...wd,...ud])].sort();
  const qualified=days.length>=5&&wd.length>=3&&ud.length>=3&&
   warned.filter(t=>money(t)!==null).length>=20&&
   unwarned.filter(t=>money(t)!==null).length>=30;
  perRoute[route]={
   warned:cohortStats(warned),unwarned:cohortStats(unwarned),
   warnedLeadTimeBeforeActualClose:leadTimeStats(warned),
   earlyStillProfitableCautions:earlyProfitCautionScore(all.filter(t=>t.route===route)),
   unevaluable:cohortStats(group.INSUFFICIENT_OR_MISSING_EVIDENCE),
   independentDaysWithSettledEvidence:days,
   candidateForManualCalibrationReview:qualified,
   sufficientStatisticalEvidence:false,
   noExecutionAuthority:true,
  };
 }
 const byRouteAndWarningAndHorizon={};
 for(const route of ROUTES){
  const ofRoute=all.filter(t=>t.route===route);
  for(const kind of ['WARNING','NOT_WARNING','UNVERIFIED']){
   for(const h of HORIZONS){
    const records=ofRoute.flatMap(t=>compact(t).filter(s=>{
     const state=s.signal.state;
     return kind==='WARNING'?RISK_STATES.has(state):
      kind==='NOT_WARNING'?VALID_STATES.has(state)&&!RISK_STATES.has(state):
       !VALID_STATES.has(state);
    }).map(s=>s.futures?.[h]?{...s.futures[h],initial:s.signal}:null)
     .filter(Boolean));
    byRouteAndWarningAndHorizon[route+'|'+kind+'|'+h+'m']=horizonStats(records);
   }
  }
 }
 return {artifact:ARTIFACT,generatedAt:new Date(now).toISOString(),
  ownerDemoOnly:true,brokerOrders:0,modifiesExecution:false,
  modelIsCalibrated:false,autoPromote:false,
  all:cohortStats(all),byRoute:perRoute,byRouteAndWarningAndHorizon,
  noHypotheticalSavedMoneyClaim:true,
  protectedProfitSystemUnchanged:true,
  interpretation:['Predictor score is an uncalibrated as-of warning, not probability of permanent nonrecovery.',
   'Warning trades that ultimately WIN count as false-alert economic risk; this report does not assert a hypothetical executable earlier close.',
   'The 5/10/15/20 minute quote marks only describe an observed side-specific quote while the trade stayed open. They are NOT broker fills.',
   'Actual broker closes before a horizon give verified settlement but do not prove what would have happened had the AI held the position.',
   'Trade-count economics are deduplicated by trade; forecast observations and horizon outcomes are counted per genuine checkpoint.',
   'Independent market days, quote coverage and complete net settlement must mature before any model calibration review.'],
 };
}
module.exports={ARTIFACT,HORIZONS,ROUTES,RISK_STATES,VALID_STATES,cohorts,cohortStats,earlyProfitCautionScore,horizonStats,evaluate};
