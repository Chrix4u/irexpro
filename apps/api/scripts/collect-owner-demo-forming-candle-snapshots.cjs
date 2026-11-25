'use strict';
const {appendBoundedText}=require('./bounded-research-file.cjs');

/**
 * Replays as-of broker-native POSITIVE bid/ask observations, already
 * collected at runtime by collect-pepperstone-native-quote-snapshots.cjs.
 * Produces immutable M1/M5 *forming candle* snapshots at :15/:30/:45
 * of each UTC minute. M5 snapshots cover a partially elapsed five-minute
 * window. NO future bar OHLC or next-candle labels are ever consumed.
 *
 * Source: [native_quote_time, collector_observed_time, pair, bid, ask]
 * Only timestamps already observed by a decision cutoff are admissible.
 * The source is sampled positive-spread quotes, NOT full-tick OHLC.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='irexpro-forming-candle-asof-quote-shadow-v1';
const FOCUS=Object.freeze(['EURUSD','AUDUSD','USDJPY','USDCAD']);
const MINUTE_MS=60000;
const FIVE_MS=300000;
const STAGE_MS=15000;
const MAX_OBSERVATION_LAG_MS=10000;
const MAX_DECISION_QUOTE_AGE_MS=8500;
const FIRST_QUOTE_WINDOW_MS=12000;
const MIN_OBSERVED_SAMPLES=2;
const RETAIN_DAYS=90;
const MAX_DAY_BYTES=32*1024*1024;
const ROOT='/home/lightworld/webapps/irexpro-research/forming-candle-snapshots';
const SOURCE='/home/lightworld/webapps/irexpro-research/native-quote-snapshots';

function toMs(v){const n=new Date(v).getTime();return Number.isFinite(n)?n:null;}
function validQuote(row){
  if(!Array.isArray(row)||row.length!==5||!FOCUS.includes(row[2]))return null;
  const source=toMs(row[0]),observed=toMs(row[1]);
  const bid=Number(row[3]),ask=Number(row[4]);
  if(source===null||observed===null||source>observed||
      observed-source>MAX_OBSERVATION_LAG_MS||
      !(bid>0&&ask>bid&&Number.isFinite(ask)))return null;
  return {source,observed,instrument:row[2],bid,ask,mid:(bid+ask)/2};
}
function candleFromQuotes(quotes,beginMs,cutoffMs){
  const selected=quotes.filter(q=>q.source>=beginMs&&q.source<=cutoffMs&&
      q.observed<=cutoffMs).sort((a,b)=>a.source-b.source||a.observed-b.observed);
  if(selected.length<MIN_OBSERVED_SAMPLES)return null;
  const first=selected[0],last=selected[selected.length-1];
  if(first.source-beginMs>FIRST_QUOTE_WINDOW_MS||
    cutoffMs-last.observed>MAX_DECISION_QUOTE_AGE_MS)return null;
  const open=first.mid,close=last.mid;
  const high=Math.max(...selected.map(q=>q.mid)),low=Math.min(...selected.map(q=>q.mid));
  const range=high-low,body=close-open;
  return {
    open,high,low,close,body,range,
    color:body>0?'GREEN':body<0?'RED':'FLAT',
    upperWick:high-Math.max(open,close),
    lowerWick:Math.min(open,close)-low,
    closeLocation:range>0?(close-low)/range:0.5,
    lastBid:last.bid,lastAsk:last.ask,lastSpread:last.ask-last.bid,
    sampleCount:selected.length,
    firstSourceAt:new Date(first.source).toISOString(),
    lastSourceAt:new Date(last.source).toISOString(),
    lastObservedAt:new Date(last.observed).toISOString(),
    // Never claim exact tick volume or broker OHLC from sampled quotes.
    priceSource:'sampled-positive-native-bid-ask',
    fullTickOhlc:false,
  };
}
function snapshotsAt(quotes,cutoffMs){
  const slot=Math.floor(cutoffMs/STAGE_MS)*STAGE_MS;
  if(slot!==cutoffMs||slot%MINUTE_MS===0)return [];
  const checked=quotes.map(q=>Array.isArray(q)?validQuote(q):q)
    .filter(q=>q&&FOCUS.includes(q.instrument)&&q.observed<=slot&&q.source<=slot);
  const m1Start=Math.floor(slot/MINUTE_MS)*MINUTE_MS;
  const m5Start=Math.floor(slot/FIVE_MS)*FIVE_MS;
  const results=[];
  for(const instrument of FOCUS){
    const q=checked.filter(x=>x.instrument===instrument);
    for(const [tf,begin] of [['M1',m1Start],['M5',m5Start]]){
      const c=candleFromQuotes(q,begin,slot);
      if(!c)continue;
      if(tf==='M5'){
        // A partial M5 candle cannot be trained as a complete path if
        // any previously elapsed M1 minute had no observed native quote.
        const minuteCount=Math.floor((slot-begin)/MINUTE_MS)+1;
        const buckets=new Set(q.filter(x=>x.source>=begin&&x.source<=slot)
          .map(x=>Math.floor((x.source-begin)/MINUTE_MS)));
        if(Array.from({length:minuteCount},(_,i)=>i).some(i=>!buckets.has(i)))continue;
      }
      results.push({
        artifact:ARTIFACT,instrument,timeframe:tf,
        barStart:new Date(begin).toISOString(),
        decisionAt:new Date(slot).toISOString(),
        elapsedSeconds:(slot-begin)/1000,
        stageSecondWithinMinute:(slot-m1Start)/1000,
        ...c,
        sourceProvenance:'ctrader-broker-native-positive-quote-archive',
        fromCompletedFutureCandle:false,
        includesNextBarLabel:false,
        modifiesExecution:false,
        brokerOrderAuthority:false,
      });
    }
  }
  return results;
}
function archiveRows(text){
  const quotes=[];
  for(const line of text.split('\n')){
    if(!line.trim())continue;
    try{const parsed=validQuote(JSON.parse(line));if(parsed)quotes.push(parsed);}
    catch{/* Truncated in-flight last line: not an eligible sample. */}
  }
  return quotes;
}
function latestTail(file,maxBytes=220*1024){
  let handle;
  try{
    handle=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  }catch(err){
    if(err.code==='ENOENT')return '';
    throw err;
  }
  try{
    const stat=fs.fstatSync(handle);
    if(!stat.isFile()||stat.size===0)return '';
    const length=Math.min(stat.size,maxBytes),buffer=Buffer.alloc(length);
    let offset=0;
    while(offset<length){
      const n=fs.readSync(handle,buffer,offset,length-offset,stat.size-length+offset);
      if(n===0)break;
      offset+=n;
    }
    let text=buffer.toString('utf8',0,offset);
    if(length<stat.size){const i=text.indexOf('\n');text=i<0?'':text.slice(i+1);}
    return text;
  }finally{fs.closeSync(handle);}
}
function sourceQuotesForSlot(slot,dir=SOURCE){
  const days=[new Date(slot).toISOString().slice(0,10)];
  const m5Start=Math.floor(slot/FIVE_MS)*FIVE_MS;
  if(new Date(m5Start).toISOString().slice(0,10)!==days[0])
    days.unshift(new Date(m5Start).toISOString().slice(0,10));
  return archiveRows(days.map(d=>latestTail(path.join(dir,d+'.jsonl'))).join('\n'));
}
function snapshotKey(s){return [s.decisionAt,s.instrument,s.timeframe].join('|');}
function restoreRecentSeen(dir=ROOT,now=new Date()){
  const seen=new Set();
  for(const lag of [1,0]){
    const day=new Date(now.getTime()-lag*86400000).toISOString().slice(0,10);
    const text=latestTail(path.join(dir,day+'.jsonl'),400*1024);
    for(const line of text.split('\n')){
      try{const x=JSON.parse(line);if(x.artifact===ARTIFACT)seen.add(snapshotKey(x));}
      catch{}
    }
  }
  return seen;
}
function persist(snapshots,opts={}){
  const dir=opts.dir||ROOT,seen=opts.seen||new Set();
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  let written=0,duplicates=0,capped=0;
  for(const x of snapshots){
    if(x.artifact!==ARTIFACT||x.modifiesExecution!==false||
       x.brokerOrderAuthority!==false||x.includesNextBarLabel!==false)
      throw Error('INVALID_RESEARCH_SNAPSHOT_CONTRACT');
    const key=snapshotKey(x);
    if(seen.has(key)){duplicates++;continue;}
    const day=x.decisionAt.slice(0,10);
    const file=path.join(dir,day+'.jsonl');
    const line=JSON.stringify(x)+'\n';
    if(!appendBoundedText(file,line,MAX_DAY_BYTES)){capped++;continue;}
    seen.add(key);written++;
  }
  return {written,duplicates,capped};
}
function pruneSnapshots(dir=ROOT,now=new Date()){
  if(!fs.existsSync(dir))return [];
  const before=new Date(now.getTime()-RETAIN_DAYS*86400000).toISOString().slice(0,10);
  const removed=[];
  for(const file of fs.readdirSync(dir)){
    if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)||file.slice(0,10)>=before)continue;
    const full=path.join(dir,file);
    if(fs.statSync(full).isFile()){fs.unlinkSync(full);removed.push(file);}
  }
  return removed;
}
/**
 * Efficient forward-only replay of previously saved *as-of* native quotes.
 * Crucially, the latest complete candle is NEVER read during feature
 * construction. A quote first observed after a slot stays invisible.
 */
function replayArchivedDay(text,fromMs,toMs){
  if(!(Number.isFinite(fromMs)&&Number.isFinite(toMs))||
      toMs<fromMs||toMs-fromMs>86400000)
    throw Error('BACKFILL_WINDOW_MUST_BE_AT_MOST_ONE_DAY');
  const rows=archiveRows(text).sort((a,b)=>a.observed-b.observed);
  const end=Math.min(toMs,Date.now()-15000);
  let pointer=0,buffer=[];
  const result=[];
  const start=Math.ceil(fromMs/STAGE_MS)*STAGE_MS;
  for(let slot=start;slot<=end;slot+=STAGE_MS){
    while(pointer<rows.length&&rows[pointer].observed<=slot){
      const q=rows[pointer++];if(q.source<=slot)buffer.push(q);
    }
    const begin=Math.floor(slot/FIVE_MS)*FIVE_MS;
    if(buffer.length)buffer=buffer.filter(q=>q.source>=begin&&q.source<=slot);
    if(slot%MINUTE_MS!==0)
      result.push(...snapshotsAt(buffer,slot));
  }
  return result;
}
function backfillArchives(opts={}){
  const source=opts.source||SOURCE,dir=opts.dir||ROOT;
  const now=opts.now||new Date();
  const seen=new Set();
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const days=[1,0].map(n=>new Date(now.getTime()-n*86400000).toISOString().slice(0,10));
  let candidates=0,written=0,duplicates=0,capped=0;
  for(const day of days){
    const outFile=path.join(dir,day+'.jsonl');
    if(fs.existsSync(outFile)){
      for(const line of fs.readFileSync(outFile,'utf8').split('\n')){
        try{const x=JSON.parse(line);if(x.artifact===ARTIFACT)seen.add(snapshotKey(x));}
        catch{}
      }
    }
    const file=path.join(source,day+'.jsonl');
    if(!fs.existsSync(file))continue;
    const body=fs.readFileSync(file,'utf8');
    const from=Date.parse(day+'T00:00:00.000Z');
    const end=Math.min(from+86400000-STAGE_MS,now.getTime()-15000);
    if(end<=from)continue;
    const generated=replayArchivedDay(body,from,end);
    const result=persist(generated,{dir,seen});
    candidates+=generated.length;written+=result.written;
    duplicates+=result.duplicates;capped+=result.capped;
  }
  return {days,candidates,written,duplicates,capped,
    noBrokerQueries:true,noDatabaseWrites:true,modifiesExecution:false};
}
function processSlot(slot,opts={}){
  const source=opts.source||SOURCE;
  const q=sourceQuotesForSlot(slot,source);
  return persist(snapshotsAt(q,slot),opts);
}
async function main(){
  if(process.argv.includes('--backfill')){
    console.log('FORMING_CANDLE_BACKFILL',JSON.stringify(backfillArchives()));
    return;
  }
  if(!process.argv.includes('--watch'))throw Error('RESEARCH_WATCH_OR_BACKFILL_FLAG_REQUIRED');
  const seen=restoreRecentSeen(ROOT,new Date());
  let lastSlot=null,active=false,cycles=0,stored=0,lastDay='';
  async function step(){
    if(active)return;
    active=true;
    try{
      // Wait 2.5s so the already-running native quote collector can append
      // all quotes it had observed by the *strict as-of* cutoff.
      const now=Date.now(),slot=Math.floor((now-2500)/STAGE_MS)*STAGE_MS;
      if(slot===lastSlot||slot%MINUTE_MS===0)return;
      lastSlot=slot;
      const result=processSlot(slot,{dir:ROOT,source:SOURCE,seen});
      cycles++;stored+=result.written;
      const day=new Date(slot).toISOString().slice(0,10);
      if(lastDay!==day){pruneSnapshots(ROOT,new Date(slot));lastDay=day;}
      if(cycles%80===1||result.capped>0)
        console.log('FORMING_CANDLE_SHADOW',JSON.stringify({
          at:new Date(now).toISOString(),slot:new Date(slot).toISOString(),
          cycles,stored,added:result.written,capped:result.capped,
          researchOnly:true,orders:false,databaseWrites:false,
        }));
    }catch(e){console.error('FORMING_CANDLE_SHADOW_FAILURE',String(e.message).slice(0,170));}
    finally{active=false;}
  }
  await step();
  const interval=setInterval(()=>void step(),2000);
  const stop=()=>{clearInterval(interval);process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
module.exports={ARTIFACT,FOCUS,ROOT,SOURCE,STAGE_MS,RETAIN_DAYS,
  validQuote,candleFromQuotes,snapshotsAt,archiveRows,latestTail,
  sourceQuotesForSlot,restoreRecentSeen,persist,pruneSnapshots,processSlot,replayArchivedDay,backfillArchives};
if(require.main===module)main().catch(e=>{
  console.error('FORMING_CANDLE_SHADOW_FATAL',String(e.message).slice(0,170));
  process.exitCode=1;
});
