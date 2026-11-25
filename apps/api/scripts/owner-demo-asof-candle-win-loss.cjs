'use strict';
/**
 * Pre-entry formation using independently time-stamped broker-native
 * bid/ask quote snapshots. Sampled forming candles are NOT full-tick OHLC
 * nor an independently trained expert's prediction.
 *
 * Never use the later-mutated provider_quote_candles OHLC table to
 * recreate "what was known" at an older trade decision.
 */
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const ARTIFACT='irexpro-forming-candle-asof-quote-shadow-v1';
const SOURCE='/home/lightworld/webapps/irexpro-research/forming-candle-snapshots';
const number=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ts=x=>x==null?null:Number.isFinite(Date.parse(x))?Date.parse(x):null;
const round=(x,p=4)=>x==null||!Number.isFinite(x)?null:Number(x.toFixed(p));
const empty=()=>({status:'NO_VERIFIED_PRE_ENTRY_SNAPSHOT',M1:null,M5:null});
function validSnapshot(x,trade){
 if(!x||x.artifact!==ARTIFACT||x.sourceProvenance!=='ctrader-broker-native-positive-quote-archive'||
  x.brokerOrderAuthority!==false||x.modifiesExecution!==false||x.fromCompletedFutureCandle!==false||
  x.includesNextBarLabel!==false||x.fullTickOhlc!==false||
  !['M1','M5'].includes(x.timeframe)||x.instrument!==trade.instrument)return false;
 const at=ts(trade.decisionAt),time=ts(x.decisionAt),
  observed=ts(x.lastObservedAt),first=ts(x.firstSourceAt),last=ts(x.lastSourceAt),
  bar=ts(x.barStart);
 const maxAge=90_000; // latest 15/30/45-second snapshot of prior minute
 if([at,time,observed,first,last,bar].some(v=>v==null)||time>at||
   at-time>maxAge||observed>time||last>time||first>last||bar>time ||
   ![15,30,45].includes(x.stageSecondWithinMinute))return false;
 if(x.timeframe==='M1' && time-bar>=60_000 ||
   x.timeframe==='M5' && time-bar>=300_000)return false;
 const vals=[x.open,x.high,x.low,x.close,x.body,x.range,
 x.upperWick,x.lowerWick,x.closeLocation,x.lastSpread,x.sampleCount];
 if(vals.some(v=>number(v)==null))return false;
 const [o,h,l,c,body,range,upper,lower,close,spread,samples]=vals.map(Number);
 return o>0&&l>0&&h>=Math.max(o,c)&&l<=Math.min(o,c)&&
  range>0&&samples>=2&&spread>0&&upper>=0&&lower>=0&&
  Math.abs(body-(c-o))<.000001&&Math.abs(range-(h-l))<.000001&&
  close>=0&&close<=1;
}
function derive(x,direction) {
 const sign=direction==='BUY'?1:-1;
 const upper=number(x.upperWick)/number(x.range),lower=number(x.lowerWick)/number(x.range);
 const bodySigned=number(x.body)/number(x.range)*sign;
 const alignedClose=(number(x.closeLocation)-.5)*2*sign;
 return {
  at:x.decisionAt,stageSeconds:x.elapsedSeconds,barStart:x.barStart,
  color:x.color,bodyAlignedRatio:round(bodySigned),
  closeAligned:round(alignedClose),
  opposingRejectionWickRatio:round(sign===1?upper:lower),
  supportiveRejectionWickRatio:round(sign===1?lower:upper),
  sampleCount:x.sampleCount,fullTickOhlc:false,
  independentlyObservedAt:x.lastObservedAt,
  source:'SAMPLED_BROKER_NATIVE_ASOF_QUOTES',
 };
}
async function annotate(trades,dir=SOURCE){
 const byDay=new Map(),matched=new Map();
 for(const trade of trades){
  matched.set(trade.tradeKey,empty());
  if(!trade.matchedDecision||!trade.decisionAt)continue;
  const day=trade.decisionAt.slice(0,10);
  if(!byDay.has(day))byDay.set(day,new Map());
  const symbols=byDay.get(day);
  if(!symbols.has(trade.instrument))symbols.set(trade.instrument,[]);
  symbols.get(trade.instrument).push(trade);
 }
 let sourceRows=0,validRows=0,badLines=0,files=0;
 for(const [day,symbols] of byDay){
  const file=path.join(dir,day+'.jsonl');
  if(!fs.existsSync(file))continue;
  files++;
  const input=fs.createReadStream(file,{encoding:'utf8',highWaterMark:128*1024});
  const rl=readline.createInterface({input,crlfDelay:Infinity});
  for await (const line of rl){
   if(!line.trim())continue;
   let x;try{x=JSON.parse(line);}catch{badLines++;continue}
   sourceRows++;
   const targets=symbols.get(x.instrument);
   if(!targets||!['M1','M5'].includes(x.timeframe))continue;
   for(const t of targets){
    if(!validSnapshot(x,t))continue;
    validRows++;
    const previous=matched.get(t.tradeKey);
    const snapshot=derive(x,t.direction);
    if(!previous[x.timeframe]||ts(snapshot.at)>ts(previous[x.timeframe].at)){
      previous[x.timeframe]=snapshot;
      previous.status='AT_LEAST_ONE_VERIFIED_ASOF_QUOTE_CANDLE';
    }
   }
  }
 }
 return {annotated:matched,
  coverage:{requestedTradeCount:trades.length,archiveFiles:files,
   sourceRowsExamined:sourceRows,validSnapshotTradeMatches:validRows,badLines,
   verifiedM1:trades.filter(t=>matched.get(t.tradeKey).M1).length,
   verifiedM5:trades.filter(t=>matched.get(t.tradeKey).M5).length,
   verifiedBoth:trades.filter(t=>matched.get(t.tradeKey).M1&&matched.get(t.tradeKey).M5).length}};
}
const FORMATION_FLAGS=Object.freeze([
 ['M1_FORMING_BODY_OPPOSES',e=>e.M1!=null&&e.M1.bodyAlignedRatio<=-.30],
 ['M5_FORMING_BODY_OPPOSES',e=>e.M5!=null&&e.M5.bodyAlignedRatio<=-.30],
 ['M1_FORMING_OPPOSING_WICK',e=>e.M1!=null&&e.M1.opposingRejectionWickRatio>=.5],
 ['M5_FORMING_OPPOSING_WICK',e=>e.M5!=null&&e.M5.opposingRejectionWickRatio>=.5],
 ['M1_FORMING_CLOSE_OPPOSES',e=>e.M1!=null&&e.M1.closeAligned<=-.5],
 ['M5_FORMING_CLOSE_OPPOSES',e=>e.M5!=null&&e.M5.closeAligned<=-.5],
 ['BOTH_M1_M5_FORMING_BODIES_OPPOSE',e=>e.M1!=null&&e.M5!=null&&e.M1.bodyAlignedRatio<=-.3&&e.M5.bodyAlignedRatio<=-.3],
 ['M5_FORMING_OPPOSES_WITH_H1_OPPOSE', (e,r)=>e.M5!=null&&e.M5.bodyAlignedRatio<=-.3&&r.entry.alignedH1!=null&&r.entry.alignedH1<-.25],
]);
function summarize(rows){
 const w=rows.filter(x=>x.label==='WIN'),l=rows.filter(x=>x.label==='LOSS');
 return {n:rows.length,wins:w.length,losses:l.length,
  lossFraction:rows.length?round(l.length/rows.length):null,
  netUsd:round(rows.reduce((s,x)=>s+x.netUsd,0),2)};
}
function analyze(trades,candles){
 const records=trades.map(t=>({...t,candle:candles.annotated.get(t.tradeKey)}));
 const groups=[];
 for(const [flag,predicate] of FORMATION_FLAGS) {
  for(const route of ['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION']) {
   const sub=records.filter(r=>r.entryRoute===route&&r.candle.M1&&r.candle.M5);
   const earlier=sub.filter(r=>r.tradeDate<'2026-11-19');
   const later=sub.filter(r=>r.tradeDate>='2026-11-19');
   function compare(items){const yes=items.filter(r=>predicate(r.candle,r)),
   no=items.filter(r=>!predicate(r.candle,r));return {
    flagged:summarize(yes),unflagged:summarize(no),
    lossExcess:yes.length&&no.length?round(yes.filter(x=>x.label==='LOSS').length/yes.length-no.filter(x=>x.label==='LOSS').length/no.length):null,
    // Counterfactual NOT broker simulation. Sacrifices flagged winners.
    hypotheticalRemovalNetUsd:round(-yes.reduce((s,x)=>s+x.netUsd,0),2),
   }}
   const train=compare(earlier),test=compare(later),all=compare(sub);
   groups.push({flag,route,eligibleVerifiedBoth:sub.length,
    discoveryNov17Nov18:train,laterNov19:test,all,
    robustAcrossSessions:false,noExecutionAuthority:true});
  }
 }
 return {artifact:'owner-demo-preentry-forming-candle-win-loss-v1',
  researchOnly:true,changesExecution:false,
  sampledQuoteSource:true,fullTickCandleExpert:false,
  independentExpertIsDifferentModule:true,
  coverage:candles.coverage,
  byRouteBothVerified:['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION'].map(route=>{
   const sub=records.filter(r=>r.entryRoute===route);
   return {route,total:sub.length,withM1:sub.filter(r=>r.candle.M1).length,
    withM5:sub.filter(r=>r.candle.M5).length,
    both:sub.filter(r=>r.candle.M1&&r.candle.M5).length}
  }),
  formationComparisons:groups,
  limitations:[
   'Sampled independent quote archive only, NOT full-tick OHLC and NOT a trained candlestick expert forecast.',
   'Only quotes with observedAt <= candidate decisionAt are used, no later revised candle table.',
   'No output with missing candle evidence is coded as a favorable candle.',
   'Discovery and later date had historical attention; later date is not pristine sealed validation.',
   'No formation filter may block a broker order from this retrospective study alone.',
  ]};
}
module.exports={validSnapshot,derive,annotate,FORMATION_FLAGS,analyze};
