'use strict';
/**
 * Strictly read-only runner candidate at the ACTUAL profit-protection exit.
 * An unsuitable candidate falls back to the already-booked profit close.
 * The hypothetical broker stop is NEVER installed by this evaluator.
 */
const MINUTE=60000;
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const round=(x,n=2)=>Number(x.toFixed(n));
function limitFraction(progress,policy='USER_50_65_60_70_80_75'){
 if(policy==='USER_50_65_60_70_80_75'){
  if(progress>=.8)return .75;
  if(progress>=.6)return .7;
  if(progress>=.5)return .65;
 } else if(policy==='PATIENT_70_55_85_65'){
  if(progress>=.85)return .65;
  if(progress>=.7)return .55;
 } else if(policy==='ONLY_NEAR_TP_80_60'){
  if(progress>=.8)return .6;
 }
 return null;
}
function lowerBound(a,ts){
 let l=0,h=a.length;
 while(l<h){const m=(l+h)>>>1;if(a[m].at<ts)l=m+1;else h=m}
 return l;
}
function gross(t,price){
 return t.sgn*(price-t.entry)*100000*t.lots/
   (t.instrument.startsWith('USD')?price:1);
}
function proxy(t,price,pipSlippage=.5){
 const pip=t.instrument.endsWith('JPY')?.01:.0001;
 const slippage=pipSlippage*100000*pip*t.lots/
  (t.instrument.startsWith('USD')?price:1);
 return round(gross(t,price)+t.commission+t.swap-slippage);
}
function proposedAtClose(trade,quotes,policy){
 const t=trade,end=t.closed,start=t.opened;
 const lower=lowerBound(quotes,start+1),right=lowerBound(quotes,end+1);
 if(lower===right)return {status:'NO_ASOF_QUOTES'};
 const quote=quotes[right-1];
 const gap=(end-quote.at)/1000;
 if(gap<0||gap>10)return {status:'STALE_ASOF_QUOTE',latestQuoteLagSeconds:round(gap)};
 const mark=t.direction==='BUY'?quote.bid:quote.ask;
 const spread=quote.ask-quote.bid;
 const riskDistance=t.sgn*(t.entry-t.stop);
 const tpDistance=t.sgn*(t.tp-t.entry);
 if(!(spread>0&&riskDistance>0&&tpDistance>0&&mark>0))return {status:'INVALID_BROKER_GEOMETRY'};
 const quoteVsActualExit=Math.abs(mark-t.exit);
 const pip=t.instrument.endsWith('JPY')?.01:.0001;
 if(quoteVsActualExit>Math.max(spread*4,2*pip))
  return {status:'BROKER_CLOSE_QUOTE_DISAGREEMENT',quoteExitPriceDistance:round(quoteVsActualExit,6)};
 let peak=0,largestGap=0,previous=start,observations=0;
 for(let i=lower;i<right;i++){
  const q=quotes[i];
  largestGap=Math.max(largestGap,(q.at-previous)/1000);
  previous=q.at;observations++;
  const side=t.direction==='BUY'?q.bid:q.ask;
  peak=Math.max(peak,t.sgn*(side-t.entry),0);
 }
 largestGap=Math.max(largestGap,(end-previous)/1000);
 const progress=peak/tpDistance;
 const retention=limitFraction(progress,policy);
 if(retention===null)return {status:'NOT_AT_TRAILING_MILESTONE',
  peakTpProgress:round(progress,4),observations,
  maxGapPreCloseSeconds:round(largestGap)};
 const proposed=t.entry+t.sgn*peak*retention;
 const headroom=t.sgn*(mark-proposed);
 if(!(t.sgn*(proposed-t.stop)>0&&t.sgn*(proposed-t.entry)>0&&
  headroom>Math.max(spread*3,pip*.5)))
  return {status:'INCOMPATIBLE_STOP_HEADROOM',
   peakTpProgress:round(progress,4),observedSpread:round(spread,6),
   proposedStopPrice:round(proposed,6),headroomPips:round(headroom/pip)};
 const netAtProposedStop=proxy(t,proposed,.5);
 if(netAtProposedStop<Math.max(5,t.actualNet*.2))
  return {status:'CANNOT_SECURE_POSITIVE_AFTER_COST_NET',
    netAtProposedStop,peakTpProgress:round(progress,4)};
 return {status:'SIMULATED_STOP_CANDIDATE',policy,stopAtClose:proposed,
  netAtStopAfterHalfPipExtraSlippage:netAtProposedStop,realBookedNet:t.actualNet,
  snapshotAsOf:new Date(quote.at).toISOString(),
  ageSeconds:round(gap,2),quoteMarkAtClose:mark,
  observedSpread:round(spread,6),
  peakTpProgress:round(progress,4),initialRetention:retention,
  initialPeakPriceDistance:peak,observations,
  maxGapPreCloseSeconds:round(largestGap,2),
  cannotProveBrokerMinStopOrAmendment:true};
}
function simulateHybrid(trade,quotes,now,horizon=120,policy='USER_50_65_60_70_80_75'){
 const t=trade;
 const past=proposedAtClose(t,quotes,policy);
 if(now<t.closed+horizon*MINUTE+10000)return {status:'NOT_MATURED',proposal:past};
 if(past.status!=='SIMULATED_STOP_CANDIDATE')
  return {status:'ACTUAL_PROFIT_CLOSE_RETAINED',reason:past.status,
   proposal:past,actualNet:t.actualNet,proxyIncrementVsActual:0};
 let stop=past.stopAtClose,peak=past.initialPeakPriceDistance,previous=t.closed;
 let gapMax=0,observations=0,firstGap=null;
 const start=lowerBound(quotes,t.closed+1),end=t.closed+horizon*MINUTE;
 for(let i=start;i<quotes.length;i++){
  const q=quotes[i];if(q.at>end)break;
  const interval=(q.at-previous)/1000;
  if(firstGap===null)firstGap=interval;
  gapMax=Math.max(interval,gapMax);previous=q.at;observations++;
  const mark=t.direction==='BUY'?q.bid:q.ask;
  const stopTouch=t.sgn*(mark-stop)<=0;
  const tpTouch=t.sgn*(mark-t.tp)>=0;
  if(stopTouch||tpTouch){
   const at=tpTouch?t.tp:mark;
   const estimate=proxy(t,at,.5);
   return {status:'SHADOW_FIRST_OBSERVED_EXIT',
    event:tpTouch?'ORIGINAL_TP_OBSERVED':'PROPOSED_TRAIL_STOP_OBSERVED',
    at:new Date(q.at).toISOString(),
    quoteMark:mark,activeStopPrice:round(stop,6),
    observations,afterCloseMaxGapSeconds:round(gapMax,2),
    afterCloseFirstGapSeconds:round(firstGap,2),
    hasFrequentQuotePath:gapMax<=12,
    proposal:past,actualNet:t.actualNet,
    indicativeNetAfterHalfPipSlip:estimate,
    indicativeIncrementVsActual:round(estimate-t.actualNet),
    brokerFillNotVerified:true};
  }
  peak=Math.max(peak,Math.max(0,t.sgn*(mark-t.entry)));
  const f=limitFraction(peak/(t.sgn*(t.tp-t.entry)),policy);
  if(f!==null){
   const targetStop=t.entry+t.sgn*peak*f;
   if(t.sgn*(targetStop-stop)>0)stop=targetStop;
  }
 }
 gapMax=Math.max(gapMax,(end-previous)/1000);
 return {status:'OPEN_AT_HORIZON_NOT_AN_EXECUTED_RETURN',
  proposal:past,observations,afterCloseMaxGapSeconds:round(gapMax,2),
  hasFrequentQuotePath:gapMax<=12,actualNet:t.actualNet};
}
/**
 * M1 candle OHLC is sampled midpoint, not side-specific quote extrema.
 * Wicks may reveal a STOP could have been crossed earlier or in the same
 * minute as a quote-observed TP. They cannot confirm order executions.
 */
function corroborateWickOrder(t,first,rawBars){
 if(!first||!['TP_FIRST_OBSERVED','STOP_FIRST_OBSERVED'].includes(first.status))
  return {status:'NO_SIDE_QUOTE_CROSS'};
 const eventAt=ms(first.eventAt);
 const from=Math.ceil(t.closed/MINUTE)*MINUTE,to=Math.floor(eventAt/MINUTE)*MINUTE;
 const map=new Map(),dupes=new Set();
 for(const b of rawBars||[]){
  const at=ms(b.bucket_time);if(!Number.isFinite(at))continue;
  if(map.has(at))dupes.add(at);
  map.set(at,b);
 }
 let checked=0,missing=0,earlierOpposite=false,sameMinuteOpposite=false;
 const threshold=first.status==='TP_FIRST_OBSERVED'?t.stop:t.tp;
 for(let at=from;at<=to;at+=MINUTE){
  const bar=map.get(at);
  const high=num(bar?.high),low=num(bar?.low),sampleCount=num(bar?.sample_count);
  const positive=num(bar?.positive_quote_sample_count);
  const last=ms(bar?.last_positive_sample_at);
  if(dupes.has(at)||bar?.source!=='ctrader-broker-native'||
   high===null||low===null||high<low||low<=0||
   !(sampleCount>=1)||!(positive>=1)||!Number.isFinite(last)||
   last<at||last>=at+MINUTE){
   missing++;continue;
  }
  checked++;
  const opposite=first.status==='TP_FIRST_OBSERVED'?
    (t.direction==='BUY'?low<=threshold:high>=threshold):
    (t.direction==='BUY'?high>=threshold:low<=threshold);
  if(opposite&&at===to)sameMinuteOpposite=true;
  else if(opposite)earlierOpposite=true;
 }
 return {
  status:earlierOpposite?'MIDPOINT_OPPOSITE_BARRIER_POSSIBLE_EARLIER':
   sameMinuteOpposite?'MIDPOINT_SAME_MINUTE_ORDER_AMBIGUOUS':
   missing>0?'MISSING_FULL_M1_CANDLE_EVIDENCE':
   checked===0?'ONLY_FRACTIONAL_MINUTE_UNOBSERVED':
   'NO_OPPOSITE_MIDPOINT_WICK_IN_COMPLETE_M1_BARS',
  checkedFullM1Bars:checked,missingFullM1Bars:missing,
  previousMinuteWickConflict:earlierOpposite,
  sameMinuteWickConflict:sameMinuteOpposite,
  partialExitMinuteNeverVerified:true,sideSpecificTickOrderNotCertified:true};
}
module.exports={limitFraction,proposedAtClose,simulateHybrid,corroborateWickOrder,proxy};
