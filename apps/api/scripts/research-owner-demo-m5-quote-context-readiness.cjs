'use strict';
/**
 * Prospective quote-based preceding M5 context -> matured current M5 target.
 *
 * Training FEATURES must come only from immutable v2 +15s snapshots.
 * Labels may only come from later fully closed owner Pepperstone native M5
 * after a >= 15m settlement delay. The outcome is NEVER an order fill.
 */
const ARTIFACT='irexpro-owner-demo-m5-quote-context-readiness-v1';
const SNAP_ARTIFACT='irexpro-prospective-asof-quoted-m5-context-v2';
const WIDTH=300000;
const FOCUS=Object.freeze(['EURUSD','AUDUSD','USDJPY','USDCAD']);
const PIPS=Object.freeze({EURUSD:0.0001,AUDUSD:0.0001,USDJPY:0.01,USDCAD:0.0001});
const LAG_MS=15*60000;
const number=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const stamp=v=>{const n=Date.parse(v);return Number.isFinite(n)?n:null;};
function qualifySnapshot(s){
 if(!s||s.artifact!==SNAP_ARTIFACT||!FOCUS.includes(s.instrument)||
    s.timeframe!=='M5'||s.provenance!=='IMMUTABLE_POSITIVE_NATIVE_BIDASK_ASOF'||
    s.priceRepresentation!=='SAMPLED_MIDQUOTE_NOT_NATIVE_M5_OHLC'||
    s.researchOnly!==true||s.modifiesExecution!==false||
    s.brokerOrderAuthority!==false||s.labelKnown!==false||
    s.noNativeM5Read!==true||s.noFutureCandleInfo!==true||
    s.fullTickOhlc!==false||s.minuteCoverage!==5||
    !(s.quotePathSampleCount>=10))return {status:'UNTRUSTED_ASOF_SNAPSHOT'};
 const at=stamp(s.decisionAt),start=stamp(s.priorBarStart),
   end=stamp(s.priorBarEnd),captured=stamp(s.capturedAt),
   first=stamp(s.firstSourceObservedAt),last=stamp(s.lastSourceObservedAt);
 if([at,start,end,captured,first,last].some(x=>x===null)||
    start%WIDTH!==0||end-start!==WIDTH||at-end!==15000||
    captured<at+4000||captured>at+11500||
    first<start||last<first||last>at)
   return {status:'INVALID_ASOF_TIMELINE'};
 const o=s.quoteOHLC;
 const vals=o&&['open','high','low','close'].map(k=>number(o[k]));
 if(!vals||vals.some(x=>x===null)||!(vals[0]>0&&vals[2]>0&&
    vals[1]>=Math.max(vals[0],vals[3])&&
    vals[2]<=Math.min(vals[0],vals[3])))
   return {status:'INVALID_SAMPLED_QUOTE_OHLC'};
 const q=s.currentQuoteAsOf;
 const bid=number(q?.bid),ask=number(q?.ask),mid=number(q?.mid),
   spread=number(q?.spread),delta=number(q?.midVsPreviousQuoteM5Close),
   curSource=stamp(q?.sourceAt),curObserved=stamp(q?.observedAt);
 if([bid,ask,mid,spread,delta,curSource,curObserved].some(x=>x===null)||
   !(ask>bid>0&&spread>0)||q?.samplesWithinFirst15Seconds<2||
   Math.abs((ask-bid)-spread)>Math.max(1e-8,spread*.05)||
   Math.abs((bid+ask)/2-mid)>1e-8||
   Math.abs((mid-vals[3])-delta)>1e-8||
   curSource<end||curSource>at||curObserved<curSource||
   curObserved>at||(at-curObserved)>8500||
   curObserved-curSource>10000)
   return {status:'INVALID_CURRENT_BROKER_QUOTE'};
 return {status:'ASOF_VERIFIED',
   symbol:s.instrument,barStart:new Date(end).toISOString(),
   forecastAt:new Date(at).toISOString(),
   previousQuoteBodyPips:(vals[3]-vals[0])/PIPS[s.instrument],
   previousQuoteRangePips:(vals[1]-vals[2])/PIPS[s.instrument],
   liveMidDeltaFromPriorClosePips:delta/PIPS[s.instrument],
   spreadPips:spread/PIPS[s.instrument],
   previousQuoteOHLC:vals,quoteLastSampleAt:s.lastSourceObservedAt,
   currentQuoteAt:s.currentQuoteAsOf.observedAt};
}
function outcome(s,bar,now){
 const at=stamp(now);
 const q=qualifySnapshot(s);
 if(q.status!=='ASOF_VERIFIED')return q;
 const m5Start=stamp(q.barStart);
 if(at===null||at<m5Start+WIDTH+LAG_MS)
   return {status:'NATIVE_LABEL_NOT_MATURE',symbol:q.symbol,forecastAt:q.forecastAt};
 if(!bar)return {status:'NATIVE_M5_OUTCOME_MISSING',symbol:q.symbol,forecastAt:q.forecastAt};
 const bucket=stamp(bar.bucket_time),created=stamp(bar.created_at),
   updated=stamp(bar.updated_at),values=['open','high','low','close'].map(k=>number(bar[k]));
 if(bar.instrument!==q.symbol||bar.timeframe!=='M5'||
    bar.source!=='ctrader-broker-native'||bucket!==m5Start||
    created===null||updated===null||created<bucket||
    created>at||updated>at||updated<created||
    number(bar.sample_count)<2||
    values.some(v=>v===null)||!(values[0]>0&&values[2]>0&&
    values[1]>=Math.max(values[0],values[3])&&
    values[2]<=Math.min(values[0],values[3])))
    return {status:'UNVERIFIED_NATIVE_M5_OUTCOME',symbol:q.symbol,forecastAt:q.forecastAt};
 // All threshold inputs are known at +15s. Final M5 OHLC enters only
 // the LABEL and outcome after the native bar has matured.
 const threshold=Math.max(q.spreadPips,.05*q.previousQuoteRangePips);
 const classify=move=>move>threshold?'GREEN_OR_UP':
    move< -threshold?'RED_OR_DOWN':'COST_SMALL_OR_FLAT';
 const futureMovePips=(values[3]-values[0])/PIPS[q.symbol];
 const previousColor=classify(q.previousQuoteBodyPips);
 const earlyMove=classify(q.liveMidDeltaFromPriorClosePips);
 const actual=classify(futureMovePips);
 return {status:'MATURED_RESEARCH_LABEL',symbol:q.symbol,
   forecastAt:q.forecastAt,barStart:q.barStart,
   previousQuoteBodyPips:+q.previousQuoteBodyPips.toFixed(6),
   previousQuoteRangePips:+q.previousQuoteRangePips.toFixed(6),
   earlyMoveFromPreviousClosePips:+q.liveMidDeltaFromPriorClosePips.toFixed(6),
   observedSpreadPips:+q.spreadPips.toFixed(6),
   costSmallThresholdPips:+threshold.toFixed(6),
   label:actual,nativeBodyPips:+futureMovePips.toFixed(6),
   previousM5ContinuationBaseline:previousColor,
   earlyMidDeltaBaseline:earlyMove,
   previousBaselineCorrect:previousColor===actual,
   earlyBaselineCorrect:earlyMove===actual,
   outcomesAsOf:new Date(at).toISOString(),
   nativeLastUpdatedAt:new Date(updated).toISOString(),
   actualTradingPnlKnown:false,roundTripCommissionIncluded:false,
   researchOnly:true,modifiesExecution:false,promotionAllowed:false};
}
function assessResearchTrainingReadiness(days,distinctSlots,byPair){
 const dayMinimum=20,slotMinimum=1000,pairMinimum=200;
 const pairCounts=Object.fromEntries(FOCUS.map(x=>[x,byPair[x]?.total||0]));
 const checks={
   utcDays:days>=dayMinimum,
   distinctMarketSlots:distinctSlots>=slotMinimum,
   everyInstrument:FOCUS.every(x=>pairCounts[x]>=pairMinimum),
 };
 const ready=Object.values(checks).every(Boolean);
 return {
   ready,checks,observed:{utcDays:days,distinctMarketSlots:distinctSlots,
     perInstrumentMaturedRows:pairCounts},
   earliestRequiredUtcDays:dayMinimum,
   earliestRequiredDistinctMarketSlots:slotMinimum,
   earliestRequiredPerInstrumentMaturedRows:pairMinimum,
   reason:ready?'SUFFICIENT_COUNT_FOR_SEPARATE_RESEARCH_TRAINING_ONLY':
     'INSUFFICIENT_INDEPENDENT_MARKET_HISTORY',
   autoModelPromotion:false,autoBrokerExecution:false,
   afterCommissionProfitabilityProven:false,
 };
}
function summarize(snapshots,nativeRows,now){
 const keyed=new Map();
 for(const bar of nativeRows||[]){
   if(bar?.timeframe==='M5'&&FOCUS.includes(bar.instrument)){
     const k=bar.instrument+'|'+bar.bucket_time;
     if(keyed.has(k))throw Error('DUPLICATE_NATIVE_M5_LABEL');
     keyed.set(k,bar);
   }
 }
 const seen=new Set(),excluded={},countByInstrument={},
    matured=[],missing=[],pending=[];
 for(const s of snapshots||[]){
   const decision=stamp(s?.decisionAt),k=String(s?.instrument)+'|'+String(decision);
   if(seen.has(k)){excluded.DUPLICATE_SNAPSHOT=(excluded.DUPLICATE_SNAPSHOT||0)+1;continue;}
   seen.add(k);
   const candidate=qualifySnapshot(s);
   if(candidate.status!=='ASOF_VERIFIED'){
     excluded[candidate.status]=(excluded[candidate.status]||0)+1;continue;
   }
   const label=outcome(s,keyed.get(candidate.symbol+'|'+candidate.barStart),now);
   if(label.status==='NATIVE_LABEL_NOT_MATURE'){pending.push(candidate);continue;}
   if(label.status!=='MATURED_RESEARCH_LABEL'){
     excluded[label.status]=(excluded[label.status]||0)+1;
     missing.push(candidate);continue;
   }
   matured.push(label);
   (countByInstrument[label.symbol]||= {total:0,previousCorrect:0,earlyCorrect:0,labels:{}});
   const g=countByInstrument[label.symbol];g.total++;
   if(label.previousBaselineCorrect)g.previousCorrect++;
   if(label.earlyBaselineCorrect)g.earlyCorrect++;
   g.labels[label.label]=(g.labels[label.label]||0)+1;
 }
 for(const g of Object.values(countByInstrument)){
   g.previousBaselineAccuracy=g.total?+(g.previousCorrect/g.total).toFixed(4):null;
   g.earlyBaselineAccuracy=g.total?+(g.earlyCorrect/g.total).toFixed(4):null;
 }
 const maturedDays=new Set(matured.map(x=>x.forecastAt.slice(0,10)));
 const distinctSlots=new Set(matured.map(x=>x.forecastAt));
 const captureDays=new Set((snapshots||[]).filter(s=>
    s?.artifact===SNAP_ARTIFACT).map(x=>String(x.decisionAt).slice(0,10)));
 const baselineAgg={
   previousCorrect:matured.filter(x=>x.previousBaselineCorrect).length,
   earlyCorrect:matured.filter(x=>x.earlyBaselineCorrect).length};
 return {
   artifact:ARTIFACT,asOf:new Date(now).toISOString(),
   researchOnly:true,promotionAllowed:false,
   modifiesExecution:false,brokerOrderAuthority:false,
   inputProspectiveV2Snapshots:(snapshots||[]).filter(x=>x.artifact===SNAP_ARTIFACT).length,
   validMaturedLabels:matured.length,pendingOutcomeMaturation:pending.length,
   excluded,distinctMaturedMarketSlots:distinctSlots.size,
   distinctMaturedUtcDays:maturedDays.size,
   captureUtcDays:captureDays.size,
   perInstrument:countByInstrument,
   previousCandleBaselineAccuracy:matured.length?
      +(baselineAgg.previousCorrect/matured.length).toFixed(4):null,
   earlyCurrentQuoteBaselineAccuracy:matured.length?
      +(baselineAgg.earlyCorrect/matured.length).toFixed(4):null,
   modelTrainingReadiness:assessResearchTrainingReadiness(
     maturedDays.size,distinctSlots.size,countByInstrument),
   limitation:'Quote-context v2 M5 model is NOT trained; native current M5 is a hindsight research label only; positive spread, broker commission, stop paths and real fills are not represented by candle classification.',
   labeledRows:matured,
 };
}
module.exports={ARTIFACT,SNAP_ARTIFACT,FOCUS,WIDTH,LAG_MS,
  qualifySnapshot,outcome,summarize,assessResearchTrainingReadiness};
