'use strict';
/**
 * Shadow-only independent pre-entry confluence for verified owner Pepperstone
 * USD DEMO. No trading authority, no learned probabilities, no hindsight.
 * One immutable evaluation from an entry decision created/evaluated BEFORE the
 * broker fill; a position must be seen OPEN after frozen rule activation.
 */
const ARTIFACT='irexpro-owner-demo-preentry-fee-double-abstain-shadow-v1';
const n=x=>x===null||x===undefined||x===''?null:Number.isFinite(+x)?+x:null;
const stamp=x=>x==null?NaN:new Date(x).getTime();
const bool=x=>x===true||x==='true'?true:x===false||x==='false'?false:null;
const rounded=x=>Number.isFinite(x)?+x.toFixed(5):null;
function classify(row,now,activatedAt){
 const opened=stamp(row.opened_at),nowMs=stamp(now),start=stamp(activatedAt),
  decisionCreated=stamp(row.m1_decision_created_at),
  decisionAt=stamp(row.m1_decision_at);
 const evidence={
  artifact:ARTIFACT,researchOnly:true,executionAuthority:'NONE',
  noBrokerOrders:true,noEntryVeto:true,noLotAmendment:true,
  noStopAmendment:true,noExitAuthority:true,
  noCalibratedProbability:true,brokerFillWasNotPredicted:true,
  openedAt:Number.isFinite(opened)?new Date(opened).toISOString():null,
  prospectivelyObservedOpenAt:Number.isFinite(nowMs)?new Date(nowMs).toISOString():null,
  frozenRuleActivatedAt:activatedAt,
 };
 if(!Number.isFinite(opened)||!Number.isFinite(nowMs)||!Number.isFinite(start)||
  opened<start||opened>nowMs||row.status!=='OPEN')
  return {...evidence,eligible:false,label:'NO_PROSPECTIVE_OPEN_POSITION'};
 if(row.route!=='CONFIRMED_REVERSAL')
  return {...evidence,eligible:true,label:'OTHER_ROUTE_CONTROL'};
 if(!Number.isFinite(decisionCreated)||!Number.isFinite(decisionAt)||
  decisionCreated>opened||decisionAt>opened||
  row.m1_entry_route===null||row.m1_entry_route===undefined)
  return {...evidence,eligible:false,label:'MISSING_CAUSAL_DECISION_BEFORE_FILL'};
 const m1Abstained=row.m1_entry_route==='ABSTAIN';
 const expertAbstained=row.trained_expert_state==='ABSTAIN';
 const feeSamples=n(row.fee_shadow_sample_count);
 const feeAfter=n(row.fee_shadow_after_fee_expected_r);
 const feeFloor=n(row.fee_shadow_minimum_after_fee_r);
 const credibleFeeShortfall=
  row.fee_shadow_reason==='AFTER_BROKER_FEES_BELOW_FLOOR'&&
  Number.isInteger(feeSamples)&&feeSamples>=12&&
  feeAfter!==null&&feeFloor!==null&&feeFloor>0&&
  feeAfter<feeFloor;
 const h1=n(row.aligned_h1_at_entry),m5=n(row.aligned_m5_at_entry);
 const opposingHTF=(h1!==null&&h1<=-.35)||(m5!==null&&m5<=-.2);
 const lossEvidence=bool(row.model_loss_brake_active)===true &&
  bool(row.model_loss_brake_negative_payoff)===true &&
  n(row.model_loss_brake_payoff_closed_trades)>=5 &&
  n(row.model_loss_brake_recent_closed_trades)>=5;
 const label=credibleFeeShortfall&&m1Abstained&&expertAbstained
  ?(opposingHTF||lossEvidence?
   'FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT':
   'FEE_DEFICIT_DOUBLE_ABSTAIN_CAUTION')
  :'NO_CONFLUENT_ENTRY_WARNING';
 return {...evidence,eligible:true,label,
  asOfDecisionAt:new Date(decisionAt).toISOString(),
  asOfDecisionCreatedAt:new Date(decisionCreated).toISOString(),
  m1RouteAtEntry:row.m1_entry_route,
  trainedExpertStateAtEntry:row.trained_expert_state,
  feeShadowReasonAtEntry:row.fee_shadow_reason,
  feePriorSettledCount:feeSamples,
  feeShadowExpectedR:rounded(feeAfter),feeMinimumAfterFeeR:rounded(feeFloor),
  brokerFeeShortfallVerified:credibleFeeShortfall,
  m1TimingAbstained:m1Abstained,independentExpertAbstained:expertAbstained,
  alignedH1AtEntry:rounded(h1),alignedM5AtEntry:rounded(m5),
  opposingHigherTimeframeEvidence:opposingHTF,
  causalNegativePayoffHistory:lossEvidence,
  shadowWouldDiscourageEntry:label.startsWith('FEE_DEFICIT_DOUBLE_ABSTAIN'),
  postHocHistoricalCounterfactual:false,
  noFalseMoneySavedClaim:true,
 };
}
function summarize(trades,observations,activatedAt){
 const start=stamp(activatedAt);
 const newTrades=trades.filter(r=>stamp(r.openedAt)>=start);
 const observed=newTrades.filter(r=>observations[r.tradeId]&&
  observations[r.tradeId].label!=='MISSED_WHILE_OPEN_NOT_CAPTURED');
 const missed=newTrades.filter(r=>observations[r.tradeId]?.label==='MISSED_WHILE_OPEN_NOT_CAPTURED');
 const flagged=observed.filter(r=>
  observations[r.tradeId].shadowWouldDiscourageEntry===true);
 const controls=observed.filter(r=>
  observations[r.tradeId].eligible&&
  observations[r.tradeId].shadowWouldDiscourageEntry===false);
 const complete=a=>a.filter(r=>r.fullySettled&&Number.isFinite(r.settledBrokerNetUsd));
 const fin=a=>{
  const c=complete(a),wins=c.filter(r=>r.settledBrokerNetUsd>0),
   losses=c.filter(r=>r.settledBrokerNetUsd<0);
  const positive=wins.reduce((s,r)=>s+r.settledBrokerNetUsd,0),
   negative=losses.reduce((s,r)=>s+r.settledBrokerNetUsd,0);
  return {trades:a.length,open:a.filter(r=>r.status==='OPEN').length,
   closed:c.length,winners:wins.length,losers:losses.length,
   actualBrokerNetUsd:+(positive+negative).toFixed(2),
   falseWarningsOnRealWinners:wins.length,
   actualWinnersUsdPotentiallyExcluded:+positive.toFixed(2),
   actualLosersUsdFlagged:+negative.toFixed(2)};
 };
 return {
  artifact:ARTIFACT,frozenRuleActivatedAt:activatedAt,
  beforeActivationTradesExcluded:trades.length-newTrades.length,
  postActivationTrades:newTrades.length,
  observedOpenWithDecisionEvidence:observed.length,
  closedBeforeFirstOpenSnapshot:missed.length,
  flagged:fin(flagged),
  unflaggedControls:fin(controls),
  unableToJudge:fin(observed.filter(r=>!observations[r.tradeId].eligible)),
  warningsCannotBlockOrders:true,noAutoPromote:true,noAutoLiveTrading:true,
  noCounterfactualSavedProfitClaims:true,
  requiresSeparateTradingDays:5,
  requiresAtLeastFlaggedAndUnflaggedSettled:20,
  calibrated:false,
 };
}
module.exports={ARTIFACT,classify,summarize};
