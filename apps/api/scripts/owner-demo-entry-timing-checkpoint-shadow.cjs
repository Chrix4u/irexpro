'use strict';
/**
 * Frozen, purely observational ONE-MINUTE entry timing candidate.
 * This does not claim that a delayed broker order would be accepted.
 * Independent submit-time planned entry is used, not the actual fill to
 * manufacture a future entry that could not have been decided ex ante.
 */
const VERSION='irexpro-owner-demo-60s-entry-timing-shadow-v1';
const MINUTE=60000;
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const round=(x,k=3)=>Number(x.toFixed(k));
const pip=s=>s.endsWith('JPY')?.01:.0001;
function lastAsOf(quotes,target,maxAgeMs=10000){
 let lo=0,hi=quotes.length;
 while(lo<hi){const mid=(lo+hi)>>>1;
  if(quotes[mid].at<=target)lo=mid+1;else hi=mid}
 for(let i=lo-1;i>=0;i--){
  const q=quotes[i];if(q.at<target-maxAgeMs)break;
  if(q.observed<=target&&q.observed>=q.at&&target-q.observed<=maxAgeMs)return q;
 }
 return null;
}
function evaluateFrozenCheckpoint(t,quotes,featureAtCheckpoint,now){
 const base=(state,more={})=>({
  artifact:VERSION,state,noTradeAuthority:true,
  proposesBrokerOrder:false,modifiesLotSizing:false,
  modelPromotionAllowed:false,actualBrokerStopUnchanged:true,
  ...more,
 });
 const at=t.openedAt+MINUTE;
 if(now<at+10000)return base('CHECKPOINT_NOT_MATURE');
 if(t.closedAt<=at)return base('REAL_TRADE_ALREADY_CLOSED');
 const planned=num(t.plannedEntry);
 if(planned===null||planned<=0||t.sgn*(t.tp-planned)<=0||
  t.sgn*(planned-t.stop)<=0)return base('ORIGINAL_PLANNED_ENTRY_UNVERIFIED');
 const q=lastAsOf(quotes,at);
 if(!q)return base('NO_FRESH_CHECKPOINT_QUOTE');
 const sideEntry=t.direction==='BUY'?q.ask:q.bid;
 const spreadPips=q.spread/pip(t.instrument);
 const distancePips=t.sgn*(sideEntry-planned)/pip(t.instrument);
 const f=featureAtCheckpoint({...t,intentAt:at,openedAt:at},quotes);
 if(!Number.isFinite(spreadPips)||spreadPips<=0||spreadPips>1.5)
  return base('SPREAD_NOT_COMPATIBLE_WITH_DELAY', {
   measuredSpreadPips:round(spreadPips),
  });
 if(f.status!=='FRESH_ASOF_BROKER_QUOTE'||f.aligned60sPips===null)
  return base('NO_CAUSAL_M1_CONFIRMATION');
 const data={
  checkedAt:new Date(at).toISOString(),
  checkpointQuoteObservedAt:new Date(q.observed).toISOString(),
  plannedEntry:planned,
  hypotheticalEntrySidePrice:sideEntry,
  hypotheticalEntryRelativeToPlannedPips:round(distancePips),
  spreadPips:round(spreadPips),
  m1QuoteMomentumPips:f.aligned60sPips,
  m5QuoteMomentumPips:f.aligned300sPips,
  m5Quality:f.m5QuoteCoverage,
  maxAllowedChasePips:2.5,
  exploratoryRulesFrozen:true,
  signalBasedOnlyOnQuotesObservedByCheckpoint:true,
 };
 // This is not fitted or optimized: report each mutually exclusive reason.
 if(distancePips<.3)return base('WAIT_PRICE_HAS_NOT_CONFIRMED',data);
 if(distancePips>2.5)return base('WAIT_AVOID_PRICE_CHASE',data);
 if(f.aligned60sPips<.3)return base('WAIT_M1_MOMENTUM_NOT_ALIGNED',data);
 if(f.m5QuoteCoverage!=='FREQUENT_POLL_QUOTE_SAMPLES')
  return base('WAIT_M5_QUOTE_CONTEXT_UNVERIFIED',data);
 if(f.m5Direction==='OPPOSES')return base('WAIT_M5_OPPOSES',data);
 return base('DEFERRED_ENTRY_RESEARCH_CANDIDATE',data);
}
function evaluateCheckpointMark(t,quotes,checkpoint,horizon,now){
 const empty=status=>({status,noTradeAuthority:true});
 if(![3,5,10].includes(horizon))return empty('UNSUPPORTED_HORIZON');
 if(checkpoint.state!=='DEFERRED_ENTRY_RESEARCH_CANDIDATE')
  return empty('NOT_A_FROZEN_CANDIDATE');
 const at=t.openedAt+horizon*MINUTE;
 if(now<at+10000)return empty('NOT_MATURE');
 const q=lastAsOf(quotes,at);
 if(!q)return empty('NO_FRESH_MARK');
 const side=t.direction==='BUY'?q.bid:q.ask;
 const start=checkpoint.hypotheticalEntrySidePrice;
 const movePips=t.sgn*(side-start)/pip(t.instrument);
 return {
  status:'QUOTE_ONLY_HYPOTHETICAL_MARK',
  horizonMinutes:horizon,
  quoteObservedAt:new Date(q.observed).toISOString(),
  afterOriginalRealTradeClosed:at>=t.closedAt,
  hypotheticalBrokerFillVerified:false,
  spreadIncludedInPriceDifference:true,
  extraSlippageOrCommissionNotPredicted:true,
  directionalMoveFromHypotheticalEntryPips:round(movePips),
  directionPositive:movePips>0,
  noTradeAuthority:true,
 };
}
module.exports={VERSION,lastAsOf,evaluateFrozenCheckpoint,evaluateCheckpointMark};
