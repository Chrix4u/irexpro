'use strict';
/**
 * Prospectively compare chosen/reverse direction from observed, as-of
 * Pepperstone broker quote snapshots. NOT a true tick-by-tick tape:
 * first OBSERVED touch cannot exclude an earlier missed crossing.
 */
const fs=require('node:fs'),path=require('node:path');
const readline=require('node:readline');
const {ROOT,MAX_DAY_BYTES}=require('./collect-pepperstone-native-quote-snapshots.cjs');
const {START,ARTIFACT:FORWARD_ARTIFACT}=require('./audit-pepperstone-forward-direction-calibration.cjs');
const OUTPUT='/home/lightworld/webapps/irexpro-research/native-quote-snapshots/latest-path-report.json';
const PIP=p=>p.endsWith('JPY')?0.01:0.0001;
const VALID_PAIRS=new Set(['AUDUSD','EURUSD','GBPUSD','USDCHF','USDJPY','USDCAD']);
const HORIZONS=[3,5,10,15],ENTRY_MAX_DELAY_MS=12_000;
const MAX_OBSERVED_STALENESS_MS=10_000,MAX_MARK_STALENESS_MS=12_000;
const MS=60_000;
const n=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const round=(x,d=3)=>Number(x.toFixed(d));
const ms=x=>x==null?NaN:new Date(x).getTime();
function validRecord(record){
 if(!Array.isArray(record)||record.length!==5)return false;
 const [sample,observed,pair,bid,ask]=record;
 const s=ms(sample),o=ms(observed);
 return VALID_PAIRS.has(pair)&&Number.isFinite(s)&&Number.isFinite(o)&&
  s>=ms(START)&&o>=s&&o-s<=MAX_OBSERVED_STALENESS_MS&&
  n(bid)>0&&n(ask)>n(bid);
}
function prepareIndex(episodes){
 const grouped=new Map();
 for(const [i,e] of episodes.entries()){
  const at=ms(e.evaluated_at);
  if(!Number.isFinite(at)||!VALID_PAIRS.has(e.instrument))continue;
  if(!grouped.has(e.instrument))grouped.set(e.instrument,[]);
  grouped.get(e.instrument).push({i,at,through:at+17*MS});
 }
 for(const items of grouped.values())items.sort((a,b)=>a.at-b.at);
 return grouped;
}
function addRecord(record,index,byEpisode){
 if(!validRecord(record))return false;
 const at=ms(record[0]),episodes=index.get(record[2])||[];
 // An instrument's episodes are first-per-15m but 17m windows can overlap;
 // include the record in both windows only if both are genuinely eligible.
 for(let i=episodes.length-1;i>=0;i--){
  const e=episodes[i];
  if(e.at>at)continue;
  if(e.through<at)break;
  if(!byEpisode.has(e.i))byEpisode.set(e.i,[]);
  byEpisode.get(e.i).push(record);
 }
 return true;
}
async function loadSamples(episodes,root=ROOT){
 const index=prepareIndex(episodes),assigned=new Map();
 if(!fs.existsSync(root))return {assigned,read:0,accepted:0,files:[]};
 const days=new Set();
 for(const episode of episodes){
  const at=ms(episode.evaluated_at);
  if(!Number.isFinite(at))continue;
  days.add(new Date(at).toISOString().slice(0,10));
  days.add(new Date(at+17*MS).toISOString().slice(0,10));
 }
 let read=0,accepted=0;const files=[];
 for(const day of [...days].sort()){
  const file=path.join(root,day+'.jsonl');
  if(!fs.existsSync(file))continue;
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>MAX_DAY_BYTES)throw Error('QUOTE_SNAPSHOT_OVERSIZE');
  files.push(day);
  const lines=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
  for await(const line of lines){
   if(line.length>512)continue;
   let record;
   try{record=JSON.parse(line);}catch{continue;}
   read++;if(addRecord(record,index,assigned))accepted++;
  }
 }
 for(const records of assigned.values()){
  records.sort((a,b)=>ms(a[0])-ms(b[0]));
  const deduped=[],keys=new Set();
  for(const record of records){
   const key=record[2]+'|'+record[0];
   if(!keys.has(key)){keys.add(key);deduped.push(record);}
  }
  records.splice(0,records.length,...deduped);
 }
 return {assigned,read,accepted,files};
}
function sampledSide(episode,records,side,h){
 if(!['BUY','SELL'].includes(side)||!HORIZONS.includes(h))
  return {status:'INVALID_SIDE_OR_HORIZON'};
 const at=ms(episode.evaluated_at),risk=n(episode.stop_distance),
  reward=n(episode.target_distance);
 if(!(risk>0&&reward>0)||!Number.isFinite(at))
  return {status:'UNKNOWN_STOP_TARGET_OR_DECISION_TIME'};
 const entry=records.find(r=>ms(r[0])>=at);
 if(!entry||ms(entry[0])-at>ENTRY_MAX_DELAY_MS)
  return {status:'UNKNOWN_NO_PROMPT_ASOF_ENTRY_SNAPSHOT'};
 const isBuy=side==='BUY',entryPrice=isBuy?entry[4]:entry[3];
 const stop=entryPrice+(isBuy?-risk:risk);
 const target=entryPrice+(isBuy?reward:-reward);
 const entryAt=ms(entry[0]),limit=entryAt+h*MS;
 let seen=0,previousAt=entryAt,maxGap=0,firstTouch=null,last=entry;
 for(const q of records){
  const stamp=ms(q[0]);
  if(stamp<=entryAt||stamp>limit)continue;
  const gap=stamp-previousAt;
  if(gap>maxGap)maxGap=gap;
  previousAt=stamp;seen++;last=q;
  const executableExit=isBuy?q[3]:q[4];
  const stopSeen=isBuy?executableExit<=stop:executableExit>=stop;
  const targetSeen=isBuy?executableExit>=target:executableExit<=target;
  if(!firstTouch&&(stopSeen||targetSeen)){
   firstTouch={
    observedAt:q[0],
    status:stopSeen&&targetSeen?'AMBIGUOUS_SAMPLED_BARRIERS':
     stopSeen?'FIRST_OBSERVED_STOP_LEVEL':'FIRST_OBSERVED_TARGET_LEVEL',
    precedingUnobservedGapMs:gap,
    mayHaveMissedEarlierCrossing:true,
   };
  }
 }
 const endGap=limit-ms(last[0]);
 maxGap=Math.max(maxGap,endGap);
 const coverage={
  decisionAt:new Date(at).toISOString(),
  sampledEntryAt:entry[0],
  entryDelayMs:entryAt-at,
  sampledObservations:seen,
  maximumUnsampledGapMs:maxGap,
  horizonMinutes:h,
  finalSnapshotLagMs:endGap,
  quotePathCoverage:maxGap<=5_000?'FREQUENT_SAMPLES':
   maxGap<=10_000?'MODERATE_SAMPLES':
   maxGap<=30_000?'GAPPED_SAMPLES':'SPARSE_SAMPLES',
  stopTargetOrderingProven:false,
 };
 if(seen===0||endGap>MAX_MARK_STALENESS_MS)
  return {status:'UNKNOWN_NO_NEAR_HORIZON_SNAPSHOT',coverage,firstObservedTouch:firstTouch};
 const exitPrice=isBuy?last[3]:last[4];
 const pip=PIP(episode.instrument);
 const pipUsd=(episode.instrument.endsWith('USD')?1:1/exitPrice)*100000*pip;
 const beforeFeesPips=(isBuy?1:-1)*(exitPrice-entryPrice)/pip;
 const netPips=beforeFeesPips-6/pipUsd-0.2;
 return {
  status:maxGap>10_000?'COMPARABLE_WITH_SAMPLING_GAPS':'SAMPLED_PATH_COMPARABLE',
  firstObservedTouch:firstTouch??{status:'NO_TOUCH_OBSERVED_NOT_PROOF_OF_SURVIVAL'},
  coverage,stopPrice:stop,targetPrice:target,
  estimatedFixedHoldNetPips:round(netPips),
  estimatedFixedHoldNetUsdPerStandardLot:round(netPips*pipUsd,2),
  // No actual position is opened, no first-touch broker fill is asserted.
  brokerFillVerified:false,
 };
}
function summarize(episodes){
 const stats={};
 for(const h of HORIZONS){
  const chosen=episodes.map(e=>e.sampled[h]?.chosen).filter(Boolean);
  const reverse=episodes.map(e=>e.sampled[h]?.opposite).filter(Boolean);
  const usable=a=>a.filter(x=>x.status==='SAMPLED_PATH_COMPARABLE'||
   x.status==='COMPARABLE_WITH_SAMPLING_GAPS');
  const c=usable(chosen),r=usable(reverse);
  const sum=x=>round(x.reduce((v,a)=>v+a.estimatedFixedHoldNetPips,0));
  const statuses=arr=>arr.reduce((s,x)=>{
   const k=x.firstObservedTouch?.status??x.status;
   s[k]=(s[k]??0)+1;return s;
  },{});
  const quality=arr=>arr.reduce((out,x)=>{
   const name=x.coverage?.quotePathCoverage??'UNKNOWN_COVERAGE';
   out[name]=(out[name]??0)+1;return out;
  },{});
  stats[h]={
   selected:episodes.length,chosenComparable:c.length,oppositeComparable:r.length,
   chosenCoverageQuality:quality(chosen),
   oppositeCoverageQuality:quality(reverse),
   chosenFrequentOrModerateSamples:c.filter(x=>['FREQUENT_SAMPLES',
    'MODERATE_SAMPLES'].includes(x.coverage?.quotePathCoverage)).length,
   oppositeFrequentOrModerateSamples:r.filter(x=>['FREQUENT_SAMPLES',
    'MODERATE_SAMPLES'].includes(x.coverage?.quotePathCoverage)).length,
   chosenWins:c.filter(x=>x.estimatedFixedHoldNetPips>0).length,
   oppositeWins:r.filter(x=>x.estimatedFixedHoldNetPips>0).length,
   chosenNetPipsSum:sum(c),oppositeNetPipsSum:sum(r),
   chosenObservedTouchStatus:statuses(chosen),
   oppositeObservedTouchStatus:statuses(reverse),
  };
 }
 return stats;
}
function groupSummary(episodes){
 const perDay=new Map(),perRoute=new Map();
 for(const episode of episodes){
  const day=episode.evaluatedAt?.slice(0,10);
  if(/^\d{4}-\d{2}-\d{2}$/.test(day)){
   if(!perDay.has(day))perDay.set(day,[]);
   perDay.get(day).push(episode);
  }
  const route=episode.route||'UNKNOWN';
  if(!perRoute.has(route))perRoute.set(route,[]);
  perRoute.get(route).push(episode);
 }
 return {
  byDay:Object.fromEntries([...perDay].map(([day,rows])=>[day,summarize(rows)])),
  byRoute:Object.fromEntries([...perRoute].map(([route,rows])=>[route,summarize(rows)])),
 };
}
function archiveFinalizedSampled(report,root=ROOT,now=new Date()){
 if(report.authority!=='SHADOW_ONLY'||report.placesOrders!==false||
   report.modifiesExecution!==false)throw Error('UNSAFE_ARCHIVE_SOURCE');
 const folder=path.join(root,'finalized-path');
 const archived=[];
 for(const [day,statistics] of Object.entries(report.byDay||{})){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))continue;
  const dayEnd=Date.parse(day+'T00:00:00Z')+86400000;
  if(now.getTime()<dayEnd+20*MS)continue;
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const dest=path.join(folder,day+'.json');
  if(fs.existsSync(dest))continue;
  const episodes=report.episodes.filter(x=>x.evaluatedAt?.slice(0,10)===day);
  const data={artifact:report.artifact,day,finalizedAt:now.toISOString(),
   authority:'SHADOW_ONLY',modifiesExecution:false,placesOrders:false,
   statistics,episodes,limitations:report.limitations};
  const tmp=dest+'.tmp.'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});
  fs.renameSync(tmp,dest);archived.push(day);
 }
 return archived;
}
async function audit(report,root=ROOT,now=new Date()){
 if(report.artifact!==FORWARD_ARTIFACT||report.authority!=='SHADOW_ONLY'||
  report.placesOrders!==false||report.modifiesExecution!==false)
  throw Error('NOT_A_VERIFIED_READONLY_FORWARD_REPORT');
 const episodes=report.episodes??[];
 if(!Array.isArray(episodes)||episodes.length>5000)
  throw Error('FORWARD_EPISODE_LIMIT');
 const snapshots=await loadSamples(episodes,root);
 const evaluated=episodes.map((e,i)=>{
  const records=snapshots.assigned.get(i)||[];
  const sampled=Object.fromEntries(HORIZONS.map(h=>[h,{
   chosen:sampledSide(e,records,e.direction,h),
   opposite:sampledSide(e,records,e.oppositeDirection,h),
  }]));
  return {
   instrument:e.instrument,side:e.direction,route:e.planb_route,
   evaluatedAt:e.evaluated_at,quality:e.planbQuality,
   samplesForEpisode:records.length,sampled,
  };
 });
 return {
  artifact:'irexpro-sampled-broker-asof-path-v1',
  generatedAt:now.toISOString(),prospectiveStart:START,
  source:'TWO_SECOND_POLL_OF_PERSISTED_TIMESTAMPED_NATIVE_BROKER_QUOTE_SNAPSHOTS',
  authority:'SHADOW_ONLY',placesOrders:false,modifiesExecution:false,
  sampleDays:snapshots.files,readSnapshots:snapshots.read,
  validSnapshots:snapshots.accepted,selectedEpisodes:evaluated.length,
  limitations:[
   'This is NOT an exhaustive native tick stream: database polling can miss intermediate prices.',
   'First OBSERVED stop/target level may follow an earlier unobserved crossing; no broker fill is verified.',
   'Research entry requires a saved as-of broker quote within 12 seconds of the decision.',
   'Both sides charged observed entry/exit bid/ask spread, $6 per standard lot and 0.2 pip extra slippage.',
   'No actual trading stop execution, liquidity, swaps, market impact, or allocation is modeled.',
   'Episodes predating the quote collector start cannot be reconstructed; missing evidence remains unknown.',
  ],
  byHorizon:summarize(evaluated),...groupSummary(evaluated),
  episodes:evaluated,
 };
}
async function main(){
 const input='/home/lightworld/webapps/irexpro-research/forward-direction-calibration/latest-report.json';
 const watch=process.argv.includes('--watch'),once=async()=>{
  const report=JSON.parse(fs.readFileSync(input,'utf8'));
  const result=await audit(report);
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
  const tmp=OUTPUT+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(result,null,2),{mode:0o600});
  fs.renameSync(tmp,OUTPUT);
  archiveFinalizedSampled(result,ROOT,new Date(result.generatedAt));
  console.log('SAMPLED_BROKER_PATH',JSON.stringify({
   generatedAt:result.generatedAt,days:result.sampleDays,
   records:result.readSnapshots,episodes:result.selectedEpisodes,
   byHorizon:result.byHorizon,
  }));
 };
 await once();
 if(watch){let busy=false;setInterval(async()=>{
  if(busy)return;busy=true;
  try{await once()}catch(e){console.error('SAMPLED_PATH_FAILED',e.message)}
  finally{busy=false;}
 },300000)}
}
module.exports={validRecord,prepareIndex,addRecord,loadSamples,
 sampledSide,summarize,groupSummary,archiveFinalizedSampled,audit,HORIZONS};
if(require.main===module)main().catch(e=>{
 console.error('SAMPLED_PATH_FATAL',e.message);process.exitCode=1;
});
