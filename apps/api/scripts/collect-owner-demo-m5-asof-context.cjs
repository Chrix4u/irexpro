'use strict';
/**
 * PROSPECTIVE ONLY: immutable previous-M5-context snapshot at +15 seconds
 * into each new five-minute bar. Uses archived broker-positive bid/ask
 * observed by the cutoff; NEVER reads native M5 OHLC or active trade state.
 *
 * Intended for retraining a SEPARATE quote-derived M5 model. Do not substitute
 * sampled midquote OHLC into the currently deployed native M5 expert.
 */
const fs=require('node:fs'),path=require('node:path');
const {latestTail,archiveRows}=require('./collect-owner-demo-forming-candle-snapshots.cjs');
const {quoteM5AsOf,WIDTH,INSTRUMENTS}=require('./research-owner-demo-m5-causal-context-parity.cjs');
const ARTIFACT='irexpro-prospective-asof-quoted-m5-context-v2';
const SOURCE='/home/lightworld/webapps/irexpro-research/native-quote-snapshots';
const ROOT='/home/lightworld/webapps/irexpro-research/m5-context-asof';
const STAGE=15000,MIN_AGE=4000,MAX_AGE=11500;
const MAX_DAY_BYTES=6*1024*1024,RETAIN_DAYS=90;
const ms=x=>new Date(x).getTime();
function chooseStage(now){
 if(!Number.isSafeInteger(now)||now<0)throw Error('INVALID_SYSTEM_TIME');
 const end=Math.floor((now-STAGE-MIN_AGE)/WIDTH)*WIDTH;
 const slot=end+STAGE;
 const age=now-slot;
 return age>=MIN_AGE&&age<=MAX_AGE?slot:null;
}
function sourceForStage(slot,dir=SOURCE){
 if(slot%WIDTH!==STAGE)throw Error('INVALID_M5_CONTEXT_STAGE');
 const priorStart=Math.floor(slot/WIDTH)*WIDTH-WIDTH;
 const days=[new Date(priorStart).toISOString().slice(0,10),
   new Date(slot).toISOString().slice(0,10)];
 const text=[...new Set(days)].map(day=>latestTail(
   path.join(dir,day+'.jsonl'),384*1024)).join('\n');
 return archiveRows(text).filter(q=>q.source>=priorStart&&q.source<=slot&&
   q.observed<=slot);
}
function createSnapshots(slot,quotes,recordedAt=Date.now()){
 if(slot%WIDTH!==STAGE||recordedAt-slot<MIN_AGE||recordedAt-slot>MAX_AGE)
   throw Error('NOT_PROSPECTIVE_FIXED_M5_STAGE');
 const start=slot-STAGE-WIDTH;
 const out=[];
 for(const instrument of INSTRUMENTS){
   const q=quoteM5AsOf(quotes,instrument,start,slot);
   if(q.status!=='CERTIFIED_ASOF_QUOTE_SAMPLE')continue;
   // We also need what the newly forming M5 actually looks like at +15s.
   // Do NOT use a quote observed after the cutoff, even when its source
   // timestamp was within the first fifteen seconds.
   const current=quotes.filter(x=>x.instrument===instrument&&
     x.source>=slot-STAGE&&x.source<=slot&&x.observed<=slot&&
     x.observed-x.source>=0&&x.observed-x.source<=10000&&
     x.ask>x.bid&&x.bid>0)
     .sort((a,b)=>a.source-b.source||a.observed-b.observed);
   if(current.length<2)continue;
   const latest=current.at(-1);
   if(slot-latest.observed>8500||latest.ask-latest.bid<=0)continue;
   out.push({
     artifact:ARTIFACT,instrument,timeframe:'M5',
     priorBarStart:new Date(start).toISOString(),
     priorBarEnd:new Date(start+WIDTH).toISOString(),
     decisionAt:new Date(slot).toISOString(),
     capturedAt:new Date(recordedAt).toISOString(),
     quoteOHLC:{open:q.open,high:q.high,low:q.low,close:q.close},
     quotePathSampleCount:q.sourceSampleCount,
     minuteCoverage:q.minutesWithQuotes,
     currentQuoteAsOf:{
       bid:latest.bid,ask:latest.ask,mid:(latest.ask+latest.bid)/2,
       spread:latest.ask-latest.bid,
       sourceAt:new Date(latest.source).toISOString(),
       observedAt:new Date(latest.observed).toISOString(),
       samplesWithinFirst15Seconds:current.length,
       midVsPreviousQuoteM5Close:(latest.ask+latest.bid)/2-q.close,
     },
     firstSourceObservedAt:q.firstObservedAt,
     lastSourceObservedAt:q.lastObservedAt,
     provenance:'IMMUTABLE_POSITIVE_NATIVE_BIDASK_ASOF',
     priceRepresentation:'SAMPLED_MIDQUOTE_NOT_NATIVE_M5_OHLC',
     fullTickOhlc:false,
     noNativeM5Read:true,
     noFutureCandleInfo:true,
     labelKnown:false,brokerOrderAuthority:false,
     modifiesExecution:false,researchOnly:true,
   });
 }
 return out;
}
function snapshotKey(x){return [x.decisionAt,x.instrument,x.timeframe].join('|');}
function restoreSeen(dir=ROOT,now=new Date()){
 const seen=new Set();
 for(const delta of [1,0]){
   const day=new Date(now.getTime()-delta*86400000).toISOString().slice(0,10);
   const text=latestTail(path.join(dir,day+'.jsonl'),256*1024);
   for(const line of text.split('\n')){
     if(!line)continue;
     try{const x=JSON.parse(line);if(x.artifact===ARTIFACT)seen.add(snapshotKey(x));}
     catch{}
   }
 }
 return seen;
}
function persist(rows,{dir=ROOT,seen=new Set()}={}){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 let written=0,duplicates=0,capped=0;
 for(const x of rows){
   const live=x.currentQuoteAsOf;
   if(x.artifact!==ARTIFACT||x.researchOnly!==true||
       x.modifiesExecution!==false||x.brokerOrderAuthority!==false||
       x.noNativeM5Read!==true||x.noFutureCandleInfo!==true||
       x.labelKnown!==false||x.priceRepresentation!=='SAMPLED_MIDQUOTE_NOT_NATIVE_M5_OHLC'||
       !live||!Number.isFinite(live.bid)||!Number.isFinite(live.ask)||
       !(live.ask>live.bid>0)||!Number.isFinite(live.midVsPreviousQuoteM5Close)||
       live.samplesWithinFirst15Seconds<2||
       new Date(live.sourceAt).getTime()>Date.parse(x.decisionAt)||
       new Date(live.observedAt).getTime()>Date.parse(x.decisionAt))
     throw Error('UNSAFE_ASOF_M5_RESEARCH_RECORD');
   const k=snapshotKey(x);
   if(seen.has(k)){duplicates++;continue;}
   const f=path.join(dir,x.decisionAt.slice(0,10)+'.jsonl');
   const line=JSON.stringify(x)+'\n';
   if((fs.existsSync(f)?fs.statSync(f).size:0)+Buffer.byteLength(line)>MAX_DAY_BYTES){
     capped++;continue;
   }
   fs.appendFileSync(f,line,{mode:0o600});seen.add(k);written++;
 }
 return {written,duplicates,capped};
}
function prune(dir=ROOT,now=new Date()){
 if(!fs.existsSync(dir))return [];
 const cutoff=new Date(now.getTime()-RETAIN_DAYS*86400000).toISOString().slice(0,10);
 const dropped=[];
 for(const file of fs.readdirSync(dir)){
   if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)||file.slice(0,10)>=cutoff)continue;
   const full=path.join(dir,file);
   if(fs.statSync(full).isFile()){fs.unlinkSync(full);dropped.push(file);}
 }
 return dropped;
}
async function main(){
 if(!process.argv.includes('--watch'))throw Error('PROSPECTIVE_M5_WATCH_ONLY');
 const seen=restoreSeen(),dayRef={value:null};
 let lastSlot=null,busy=false,cycles=0,written=0;
 const step=()=>{
   if(busy)return;
   const now=Date.now(),slot=chooseStage(now);
   if(slot===null||slot===lastSlot)return;
   busy=true;
   try{
     const sources=sourceForStage(slot);
     const candidates=createSnapshots(slot,sources,Date.now());
     if(!candidates.length)return;
     const result=persist(candidates,{seen});
     lastSlot=slot;cycles++;written+=result.written;
     const day=new Date(slot).toISOString().slice(0,10);
     if(dayRef.value!==day){prune(ROOT,new Date(slot));dayRef.value=day;}
     console.log('ASOF_M5_CONTEXT_SNAPSHOT',JSON.stringify({
       capturedAt:new Date().toISOString(),decisionAt:new Date(slot).toISOString(),
       candidates:candidates.length,stored:result.written,duplicates:result.duplicates,
       totalStored:written,researchOnly:true,brokerOrders:false,sqlWrites:false,
       noNativeM5Read:true,
     }));
   }catch(e){
     console.error('ASOF_M5_CONTEXT_REJECTED',String(e.message).slice(0,180));
   }finally{busy=false;}
 };
 step();
 const timer=setInterval(step,950);
 const stop=()=>{clearInterval(timer);process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
module.exports={ARTIFACT,SOURCE,ROOT,STAGE,MAX_AGE,chooseStage,sourceForStage,
  createSnapshots,snapshotKey,restoreSeen,persist,prune};
if(require.main===module)main().catch(e=>{
 console.error('ASOF_M5_CONTEXT_FATAL',String(e.message).slice(0,180));process.exitCode=1;
});
