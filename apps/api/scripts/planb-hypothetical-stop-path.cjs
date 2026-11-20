'use strict';
/**
 * Research ONLY: candidate stop/target observations against the original
 * proposed geometry. This does not model real broker fills, order routing,
 * intrabar tick ordering or full stop/target price path.
 *
 * Broker-native M1 high/low are sampled MIDPOINT extrema. For BUY, sampled
 * midpoint low <= SL proves an observed bid <= SL; for SELL, midpoint high
 * >= SL proves observed ask >= SL. Target evidence requires actual opposite-
 * side bid_close/ask_close to cross TP. Same-bar order is unknowable.
 */
function number(x){if(x==null||x==='')return null;
 const n=Number(x);return Number.isFinite(n)?n:null;}
function verifiedBucket(q,at){
 if(!q||q.source!=='ctrader-broker-native'||!q.bucket_time)return false;
 const ts=new Date(q.bucket_time).getTime();
 const sampleTs=new Date(q.last_quote_sample_at).getTime();
 const high=number(q.high),low=number(q.low),close=number(q.close);
 const bid=number(q.bid_close),ask=number(q.ask_close);
 const count=number(q.sample_count),positive=number(q.positive_quote_sample_count);
 return ts===at&&Number.isFinite(sampleTs)&&sampleTs>=at&&sampleTs<at+60000&&
   high!==null&&low!==null&&close!==null&&low>0&&high>=low&&
   close>=low&&close<=high&&bid!==null&&ask!==null&&bid>0&&ask>=bid&&
   Number.isInteger(count)&&count>=1&&Number.isInteger(positive)&&positive>=1&&positive<=count;
}
function stopPath(candidate,study,bars,horizon=60,stopMultiple=1){
 const empty=(state)=>({state,firstBarrier:'UNKNOWN',observedFullMinutes:0,
  firstStopMinute:null,firstTargetMinute:null,stopThenPositiveAtHorizon:false});
 if(horizon!==60)return empty('UNSUPPORTED_HORIZON');
 if(![1,1.25,1.5,2].includes(stopMultiple))return empty('UNSUPPORTED_STOP_MULTIPLE');
 if(!study||study.reason!=='MARKED'||!study.entryAt||!study.outcomes?.[60])
  return empty('MISSING_ENTRY_COST_OR_HORIZON');
 const entry=number(study.entryPrice),originalSl=number(candidate.stopLoss),
  tp=number(candidate.takeProfit);
 const direction=candidate.direction,at=new Date(study.entryAt).getTime();
 if(!Number.isFinite(at)||entry===null||originalSl===null||tp===null||
   !(direction==='BUY'?originalSl<entry&&entry<tp:
     direction==='SELL'?tp<entry&&entry<originalSl:false))
  return empty('INVALID_ENTRY_STOP_TARGET_GEOMETRY');
 const originalStopDistance=Math.abs(entry-originalSl);
 const sl=direction==='BUY'?entry-originalStopDistance*stopMultiple:
    entry+originalStopDistance*stopMultiple;
 if(sl<=0)return empty('INVALID_WIDENED_STOP_GEOMETRY');
 const lookup=new Map();
 for(const bar of bars||[]){
  const t=new Date(bar.bucket_time).getTime();
  if(Number.isFinite(t))lookup.set(t,bar);
 }
 const start=(Math.floor(at/60000)+1)*60000;
 let stop=null,target=null,ambiguous=null,observed=0,gap=false;
 for(let i=0;i<horizon;i++){
  const minute=start+i*60000,q=lookup.get(minute);
  if(!verifiedBucket(q,minute)){gap=true;break;}
  observed++;
  const crossedStop=direction==='BUY'?Number(q.low)<=sl:Number(q.high)>=sl;
  const crossedTarget=direction==='BUY'?
    Number(q.bid_close)>=tp:Number(q.ask_close)<=tp;
  if(crossedStop&&stop===null)stop=minute;
  if(crossedTarget&&target===null)target=minute;
  if(crossedStop&&crossedTarget&&ambiguous===null)ambiguous=minute;
 }
 const firstBarrier=stop!==null&&target!==null?
     stop===target?'SAME_MINUTE_AMBIGUOUS':
     stop<target?'STOP_WITNESSED_FIRST':'TARGET_CLOSE_WITNESSED_FIRST':
   stop!==null?'STOP_WITNESSED_FIRST':
   target!==null?'TARGET_CLOSE_WITNESSED_FIRST':'NEITHER_WITNESSED';
 const positiveAtHorizon=study.outcomes[60].netUsd1Lot>0;
 return {
  state:gap?'DATA_GAP':'COMPLETE_60M_SAMPLED_QUOTES',
  stopDistanceMultiplier:stopMultiple,
  firstBarrier,observedFullMinutes:observed,
  firstStopMinute:stop===null?null:new Date(stop).toISOString(),
  firstTargetMinute:target===null?null:new Date(target).toISOString(),
  simultaneousMinute:ambiguous===null?null:new Date(ambiguous).toISOString(),
  positiveAtHorizon,
  stopThenPositiveAtHorizon:
    positiveAtHorizon&&stop!==null&&(target===null||stop<target),
 };
}
module.exports={number,verifiedBucket,stopPath};
