'use strict';
/**
 * Genuinely pre-dispatch decision provenance joined to later actual broker
 * fills. A decision without a broker fill can never be treated as a trade.
 * No entry veto, no broker writes, no implied counterfactual savings.
 */
const ARTIFACT='owner-demo-predispatch-fee-dual-abstain-research-v1';
const PHASE='BEFORE_DURABLE_DECISION_AND_BEFORE_ORDER_DISPATCH';
const t=x=>x==null?NaN:new Date(x).getTime();
const money=a=>+a.toFixed(2);
function provenance(row){
 const s=row.pre_dispatch_shadow,opened=t(row.opened_at),
  created=t(row.m1_decision_created_at),
  evaluated=t(row.m1_decision_at),
  evidenceTime=t(s?.decisionEvaluatedAt);
 if(s===null||s===undefined)return {
  state:'NOT_INSTRUMENTED_BEFORE_RESEARCH_DEPLOYMENT',eligible:false,
  warned:false,control:false,causalPreDispatch:false};
 const causal=Number.isFinite(opened)&&Number.isFinite(created)&&
  Number.isFinite(evaluated)&&Number.isFinite(evidenceTime)&&
  created<=opened&&evaluated<=created&&evidenceTime<=created&&
  s.artifact===ARTIFACT&&s.evaluationPhase===PHASE&&
  s.ownerDemoScopeVerified===true&&s.selectedForDispatch===true&&
  s.researchOnly===true&&s.noOrderBlock===true&&
  s.noNewExecutionGate===true&&s.noLotSizingChange===true&&
  s.noBrokerOrders===true&&s.noStopChange===true&&s.noExitAuthority===true&&
  s.noLivePromotion===true&&
  s.strategyRoute===row.route;
 if(!causal)return {state:'INVALID_OR_DISABLED_PREDISPATCH_PROVENANCE',
  eligible:false,warned:false,control:false,causalPreDispatch:false};
 const warned=row.route==='CONFIRMED_REVERSAL'&&
  s.researchEligible===true&&
  s.wouldDiscourageEntryIfEverValidated===true&&
  s.brokerFeeShortfallVerified===true&&
  s.m1TimingAbstained===true&&
  s.trainedExpertAbstained===true&&
  ['FEE_DEFICIT_DOUBLE_ABSTAIN_CAUTION',
   'FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT'].includes(s.label);
 const control=row.route==='CONFIRMED_REVERSAL'&&
  s.researchEligible===true&&
  s.wouldDiscourageEntryIfEverValidated===false&&
  s.label==='NO_CONFLUENT_ENTRY_WARNING';
 const other=row.route!=='CONFIRMED_REVERSAL'&&
  s.label==='OTHER_EXECUTABLE_ROUTE_CONTROL'&&
  s.wouldDiscourageEntryIfEverValidated===false;
 const state=warned?'VERIFIED_CAUSAL_WARNING_PRE_DISPATCH':
  control?'VERIFIED_CAUSAL_REVERSAL_CONTROL_PRE_DISPATCH':
  other?'VERIFIED_CAUSAL_OTHER_ROUTE_CONTROL_PRE_DISPATCH':
  'INCONSISTENT_RESEARCH_LABEL';
 return {state,eligible:warned||control||other,
  warned,control:control||other,causalPreDispatch:warned||control||other,
  recordedBeforeBrokerOpenAt:new Date(created).toISOString(),
  brokerOpenedAt:new Date(opened).toISOString(),
  recordLeadMs:opened-created,
  evidenceDecisionAt:new Date(evidenceTime).toISOString(),
  originalLabel:s.label,
  brokerFeeShortfallVerified:s.brokerFeeShortfallVerified===true,
  researchedAfterCostsR:s.feeShadowExpectedR,
  feeRequiredFloorR:s.feeRequiredFloorR,
  noBrokerOrders:true,noAutoEntryVeto:true,
  cannotClaimMoneySaved:true};
}
function summarize(trades){
 const joined=trades.map(x=>({...x,preDispatch: x.preDispatch||provenance(x)}));
 const eligible=joined.filter(x=>x.preDispatch.eligible);
 const warned=eligible.filter(x=>x.preDispatch.warned);
 const controls=eligible.filter(x=>x.route==='CONFIRMED_REVERSAL'&&!x.preDispatch.warned);
 const other=eligible.filter(x=>x.route!=='CONFIRMED_REVERSAL');
 const stats=xs=>{
  const settled=xs.filter(x=>x.fullySettled&&
   Number.isFinite(x.settledBrokerNetUsd));
  const winners=settled.filter(x=>x.settledBrokerNetUsd>0);
  const losers=settled.filter(x=>x.settledBrokerNetUsd<0);
  return {tradeIds:xs.length,open:xs.filter(x=>x.status==='OPEN').length,
   settled:settled.length,winners:winners.length,losers:losers.length,
   actualAfterCostNetUsd:money(settled.reduce((sum,x)=>sum+x.settledBrokerNetUsd,0)),
   actualWinnerUsd:money(winners.reduce((sum,x)=>sum+x.settledBrokerNetUsd,0)),
   actualLoserUsd:money(losers.reduce((sum,x)=>sum+x.settledBrokerNetUsd,0))};
 };
 const days=new Set(eligible.map(x=>x.openedAt?.slice(0,10)).filter(Boolean));
 return {artifact:ARTIFACT,decisionCapturedBeforeBrokerDispatch:true,
  firstEligibleTrade:eligible.map(x=>x.openedAt).filter(Boolean).sort()[0]||null,
  brokerOrderCount:0,autoVeto:false,canClosePositions:false,autoPromote:false,
  trackedFilledTrades:joined.length,
  decisionsWithCausalBrokerFill:eligible.length,
  missingOrInvalidProvenance:joined.length-eligible.length,
  warned:stats(warned),confirmedReversalUnwarned:stats(controls),
  otherStrategyControls:stats(other),
  falseWarningsOnActualWinningTrades:stats(warned).winners,
  actualWinningUsdThatWarningWouldExclude:stats(warned).actualWinnerUsd,
  notACounterfactualProfitSaving:true,
  minimumIndependentDays:5,minimumSettledEachSide:20,
  observedIndependentDays:days.size,
  insufficientForLivePromotion:days.size<5||stats(warned).settled<20||
    stats(controls).settled<20,
  allProvenance:joined.map(x=>({tradeId:x.tradeId,
   instrument:x.instrument,route:x.route,status:x.status,
   openedAt:x.openedAt,settledNetUsd:x.settledBrokerNetUsd,
   provenance:x.preDispatch})),
 };
}
module.exports={ARTIFACT,PHASE,provenance,summarize};
