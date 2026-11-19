'use strict';
/**
 * Prospective Pepperstone DEMO directional forecast calibration.
 * Frozen experiment start 2026-11-16 17:50 UTC. First as-of qualified
 * candidate per instrument per 15m; compare BUY/SELL using *future* native
 * broker bid/ask 3/5/10/15m marks with cost allowance. No orders/authority.
 */
const fs=require('node:fs'),path=require('node:path');
const {mark,validQuote}=require('./audit-pepperstone-alternative-route-opportunities.cjs');
const {analyzeM1Barriers}=require('./forward-direction-m1-barrier-review.cjs');
const {evaluateDayPurgedDirection}=require('./owner-demo-day-purged-directional-calibration.cjs');
const START='2026-11-16T17:50:00.000Z';
const ARTIFACT='irexpro-forward-direction-side-calibration-v1';
const REPORT='/home/lightworld/webapps/irexpro-research/forward-direction-calibration/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTES=new Set(['TREND_CONTINUATION','CONFIRMED_REVERSAL','EARLY_TRANSITION']);
const PAIRS=new Set(['AUDUSD','EURUSD','GBPUSD','USDCHF','USDJPY','USDCAD']);
const MS=60000,HORIZONS=[3,5,10,15];
// Research replay, not live quotes: keep DB load predictable on shared VPS.
const RESEARCH_CADENCE_MS=15*60000;
const numeric=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const millis=x=>x==null?NaN:new Date(x).getTime();
const byTime=(a,b)=>millis(a.evaluated_at)-millis(b.evaluated_at);
const SQL_SESSION=[
 'SELECT s.broker_connection_id AS id FROM trading.trading_sessions s',
 'JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id',
 "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
 "AND s.account_currency='USD' AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.deleted_at IS NULL",
 'ORDER BY s.started_at DESC LIMIT 1',
].join(' ');
const SQL_SIGNALS=[
 'SELECT d.instrument,d.direction,d.bar_time,d.evaluated_at,d.route AS m1_route,',
 "d.governance #>> '{multimodelEnsemble,strategyRoute}' AS planb_route,",
 "d.governance #>> '{multimodelEnsemble,directionQuality}' AS planb_quality,",
 "d.governance #>> '{multimodelEnsemble,ensembleScore}' AS ensemble_score,",
 "d.governance #>> '{multimodelEnsemble,paperAdmitted}' AS admitted,",
 "d.governance #>> '{multimodelGovernance,paperExecutionEligible}' AS governance_eligible,",
 "d.candidate->>'score' AS m1_score,",
 "d.candidate->>'stopDistance' AS stop_distance,",
 "d.candidate->>'targetDistance' AS target_distance",
 'FROM trading.m1_tactical_decisions d',
 'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
 'AND d.evaluated_at>=$3::timestamptz AND d.evaluated_at<$4::timestamptz',
 "AND d.governance #>> '{multimodelEnsemble,paperAdmitted}'='true'",
 "AND d.governance #>> '{multimodelGovernance,paperExecutionEligible}'='true'",
 'ORDER BY d.evaluated_at,d.instrument,d.direction LIMIT 40001',
].join(' ');
const SQL_PROGRESS=[
 'SELECT count(*)::int AS total_scans,',
 "count(*) filter(where d.governance #>> '{multimodelEnsemble,paperAdmitted}'='true')::int AS paper_admitted,",
 "count(*) filter(where d.governance #>> '{multimodelGovernance,paperExecutionEligible}'='true')::int AS governance_eligible,",
 "count(*) filter(where d.governance #>> '{multimodelEnsemble,paperAdmitted}'='true'",
 "AND d.governance #>> '{multimodelGovernance,paperExecutionEligible}'='true')::int AS qualified_total,",
 "count(*) filter(where d.evaluated_at >= $5::timestamptz",
 "AND d.governance #>> '{multimodelEnsemble,paperAdmitted}'='true'",
 "AND d.governance #>> '{multimodelGovernance,paperExecutionEligible}'='true')::int AS qualified_pending,",
 "max(d.evaluated_at) AS latest_scan_at,",
 "max(d.evaluated_at) filter(where d.governance #>> '{multimodelEnsemble,paperAdmitted}'='true'",
 "AND d.governance #>> '{multimodelGovernance,paperExecutionEligible}'='true') AS latest_qualified_at",
 'FROM trading.m1_tactical_decisions d',
 'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
 'AND d.evaluated_at >= $3::timestamptz AND d.evaluated_at < $4::timestamptz',
].join(' ');
const SQL_QUOTES=[
 'SELECT instrument,bucket_time,',
 'last_positive_sample_at AS last_quote_sample_at,',
 'last_positive_bid AS bid_close,last_positive_ask AS ask_close,',
 'source,positive_quote_sample_count,high,low,last_positive_spread',
 'FROM market_data.provider_quote_candles',
 "WHERE connection_id=$1 AND timeframe='M1' AND source='ctrader-broker-native'",
 'AND positive_quote_sample_count>0 AND last_positive_spread>0',
 'AND bucket_time>=$2::timestamptz AND bucket_time<$3::timestamptz',
 'ORDER BY instrument,bucket_time',
].join(' ');
function selectEpisodes(rows){
 const grouped=new Map(),skipped={invalid:0,missingScore:0,ambiguous:0,overlap:0};
 for(const row of rows){
  const score=numeric(row.ensemble_score),quality=numeric(row.planb_quality);
  if(!PAIRS.has(row.instrument)||!ROUTES.has(row.planb_route)||
   !['BUY','SELL'].includes(row.direction)||!Number.isFinite(millis(row.evaluated_at))||
   !Number.isFinite(millis(row.bar_time))||row.admitted!=='true'||
   row.governance_eligible!=='true'){skipped.invalid++;continue;}
  if(score===null||quality===null){skipped.missingScore++;continue;}
  const key=row.instrument+'|'+new Date(row.bar_time).toISOString();
  const list=grouped.get(key)||[];list.push({...row,score,quality});grouped.set(key,list);
 }
 const options=[];
 for(const [key,list] of grouped){
  // Both side candidates belong to the same contemporaneous M1 bar.
  // The as-of decision timestamp is the time the whole paired scan finished.
  const candidates=list.sort((a,b)=>b.score-a.score||byTime(a,b));
  const first=candidates[0];
  if(candidates[1] && Math.abs(candidates[1].score-first.score)<1e-9 &&
     candidates[1].direction!==first.direction){skipped.ambiguous++;continue;}
  const latestAt=Math.max(...list.map(x=>millis(x.evaluated_at)));
  if(!Number.isFinite(latestAt)){skipped.invalid++;continue;}
  options.push({
   instrument:first.instrument,direction:first.direction,
   evaluated_at:new Date(latestAt).toISOString(),
   barTime:new Date(first.bar_time).toISOString(),
   planb_route:first.planb_route,planbScore:first.score,
   planbQuality:first.quality,
   oppositeDirection:first.direction==='BUY'?'SELL':'BUY',
   sameBarOppositeObserved:list.some(x=>x.direction!==first.direction),
   m1Route:first.m1_route,
   stop_distance:first.stop_distance,target_distance:first.target_distance,
   tieBreak:'HIGHEST_PREENTRY_PLANB_ENSEMBLE_SCORE_AT_SAME_BAR',
  });
 }
 const latestByInstrument=new Map(),out=[];
 for(const x of options.sort(byTime)){
  const when=millis(x.evaluated_at),last=latestByInstrument.get(x.instrument);
  if(last!==undefined && when-last<15*MS){skipped.overlap++;continue;}
  latestByInstrument.set(x.instrument,when);
  out.push(x);
 }
 return {episodes:out,skipped};
}
function evaluateEpisode(e,book){
 const outcomes={};
 for(const h of HORIZONS){
  const chosen=mark(e,book,h);
  const reverse=mark({...e,direction:e.oppositeDirection},book,h);
  const available=chosen.state==='FIXED_HOLD_BROKER_QUOTE_PROXY'&&
    reverse.state==='FIXED_HOLD_BROKER_QUOTE_PROXY';
  outcomes[h]={
   status:available?'PAIR_COMPARABLE':'MISSING_NATIVE_BID_ASK',
   chosenNetPips:available?chosen.netPips:null,
   reverseNetPips:available?reverse.netPips:null,
   chosenNormalizedNetUsd:available?chosen.netUSDPerStandardLot:null,
   reverseNormalizedNetUsd:available?reverse.netUSDPerStandardLot:null,
   chosenWin:available?chosen.netPips>0:null,
   oppositeWin:available?reverse.netPips>0:null,
   chosenBarrierReview:analyzeM1Barriers(e,book,h,e.direction),
   oppositeBarrierReview:analyzeM1Barriers(e,book,h,e.oppositeDirection),
   firstHitStopLoss:'NOT_EVALUATED',
  };
 }
 return {...e,outcomes};
}
function bucket(items,h){
 const usable=items.map(x=>x.outcomes[h]).filter(x=>x.status==='PAIR_COMPARABLE');
 const sum=key=>usable.reduce((s,x)=>s+x[key],0);
 const round=n=>+n.toFixed(3);
 const statusCounts=key=>usable.reduce((out,item)=>{
  const status=item[key]?.status??'UNKNOWN_NOT_REVIEWED';
  out[status]=(out[status]??0)+1;return out;
 },{});
 return {
  selected:items.length,observed:usable.length,missing:items.length-usable.length,
  chosenBarrierReviewCounts:statusCounts('chosenBarrierReview'),
  oppositeBarrierReviewCounts:statusCounts('oppositeBarrierReview'),
  chosenPositiveMarkWithPossibleEarlierStop:usable.filter(
   x=>x.chosenWin&&x.chosenBarrierReview?.status==='POSSIBLE_STOP_BEFORE_TARGET'
  ).length,
  chosenWins:usable.filter(x=>x.chosenWin).length,
  counterWins:usable.filter(x=>x.oppositeWin).length,
  bothLose:usable.filter(x=>!x.chosenWin&&!x.oppositeWin).length,
  chosenMeanNetPips:usable.length?round(sum('chosenNetPips')/usable.length):null,
  counterMeanNetPips:usable.length?round(sum('reverseNetPips')/usable.length):null,
  chosenNormalizedNetUsd:usable.length?+sum('chosenNormalizedNetUsd').toFixed(2):null,
  counterNormalizedNetUsd:usable.length?+sum('reverseNormalizedNetUsd').toFixed(2):null,
 };
}
function qualityBand(value){
 const n=numeric(value);
 return n===null?'UNKNOWN':n<0.55?'BELOW_0_55':
  n<0.60?'FROM_0_55_TO_0_60':
  n<0.65?'FROM_0_60_TO_0_65':'AT_LEAST_0_65';
}
function summary(episodes){
 const byRoute={},byDay={},byQualityBand={},byInstrumentSide={},byM1Route={};
 const describe=items=>Object.fromEntries(HORIZONS.map(h=>[h,bucket(items,h)]));
 for(const row of episodes){
  (byRoute[row.planb_route]??=[]).push(row);
  (byDay[row.evaluated_at.slice(0,10)]??=[]).push(row);
  (byQualityBand[qualityBand(row.planbQuality)]??=[]).push(row);
  (byInstrumentSide[row.instrument+'|'+row.direction]??=[]).push(row);
  (byM1Route[row.m1Route||'UNKNOWN']??=[]).push(row);
 }
 const grouped=group=>Object.fromEntries(
  Object.entries(group).sort(([a],[b])=>a.localeCompare(b))
   .map(([key,values])=>[key,describe(values)]));
 return {
  byHorizon:describe(episodes),
  byRoute:grouped(byRoute),
  byDay:grouped(byDay),
  byQualityBand:grouped(byQualityBand),
  byInstrumentSide:grouped(byInstrumentSide),
  byM1Route:grouped(byM1Route),
 };
}
async function run(db,userId,asOf=new Date()){
 if(!UUID.test(userId||''))throw Error('INVALID_OWNER');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='25000ms'");
  const session=(await db.query(SQL_SESSION,[userId])).rows[0];
  if(!session)throw Error('NOT_OWNER_PEPPERSTONE_DEMO_USD');
  const from=new Date(Math.max(millis(START),asOf.getTime()-7*86400000));
  const through=new Date(Math.max(millis(START),asOf.getTime()-19*MS));
  const rows=through>from?(await db.query(SQL_SIGNALS,[
   userId,session.id,from.toISOString(),through.toISOString()])).rows:[];
  if(rows.length>=40001)throw Error('SIGNAL_HISTORY_TRUNCATED');
  // Separate still-maturing qualified forecasts from missing signals.
  // A 19-minute latency boundary guarantees complete 15-minute horizons.
  const progress=(await db.query(SQL_PROGRESS,[
   userId,session.id,from.toISOString(),asOf.toISOString(),through.toISOString(),
  ])).rows[0];
  const quotes=(await db.query(SQL_QUOTES,[
   session.id,from.toISOString(),asOf.toISOString()])).rows;
  if(quotes.length>85000)throw Error('QUOTE_HISTORY_TOO_LARGE');
  await db.query('COMMIT');
  const book=new Map();
  for(const q of quotes){
   if(!validQuote(q))continue;
   if(!book.has(q.instrument))book.set(q.instrument,new Map());
   book.get(q.instrument).set(millis(q.bucket_time),q);
  }
  const selected=selectEpisodes(rows);
  const episodes=selected.episodes.map(r=>evaluateEpisode(r,book));
  const lastBrokerQuoteAt=quotes.filter(validQuote).reduce((last,q)=>{
   const at=millis(q.last_quote_sample_at);
   return at>last?at:last;
  },-Infinity);
  const qualifiedTotal=Number(progress?.qualified_total??0);
  const qualifiedPending=Number(progress?.qualified_pending??0);
  const telemetry={
   scannerDecisions:Number(progress?.total_scans??0),
   paperAdmitted:Number(progress?.paper_admitted??0),
   governanceEligible:Number(progress?.governance_eligible??0),
   jointlyQualified:qualifiedTotal,
   waitingForMaturity:qualifiedPending,
   maturedQualified:qualifiedTotal-qualifiedPending,
   latestScanAt:progress?.latest_scan_at??null,
   latestQualifiedAt:progress?.latest_qualified_at??null,
   latestNativeBrokerQuoteAt:Number.isFinite(lastBrokerQuoteAt)?
    new Date(lastBrokerQuoteAt).toISOString():null,
   nativeBrokerDataFresh:Number.isFinite(lastBrokerQuoteAt)&&
     asOf.getTime()-lastBrokerQuoteAt<=10*MS,
   outcomeMaturityBufferMinutes:19,
   status:episodes.length>0?'MATURED_RESEARCH_EPISODES':
    qualifiedPending>0?'QUALIFIED_SIGNALS_WAITING_FOR_OUTCOME':
    qualifiedTotal>0?'MATURED_SIGNALS_NOT_SELECTED':
    'NO_QUALIFIED_SIGNALS_YET',
  };
  return {
   artifact:ARTIFACT,generatedAt:asOf.toISOString(),prospectiveStart:START,
   observationWindow:{from:from.toISOString(),through:through.toISOString()},
   source:'OWNER_PEPPERSTONE_CTRADER_DEMO_USD_NATIVE_QUOTES',
   rawAdmittedDecisions:rows.length,verifiedQuoteRows:quotes.length,
   telemetry,selectedEpisodes:episodes.length,skipped:selected.skipped,
   authority:'SHADOW_ONLY',modifiesExecution:false,placesOrders:false,
   experimentalSideSelection:'HIGHEST_PLANB_SCORE_SAME_BAR_THEN_FIRST_15M_INSTRUMENT',
   normalizedCommissionUsdPerStandardLot:6,slippageAllowancePips:0.2,
   ...summary(episodes),
   dayPurgedDirectionalResearch:evaluateDayPurgedDirection(episodes,asOf),
   episodes,
   limitations:[
    'The primary signal is a predeclared *research* selector, NOT a broker execution decision.',
    'Both directions are virtual and use a single standard-lot normalization, not account sizing.',
    'Reverse side and first-side marks use identical as-of times and broker-native bid/ask proxies.',
    'Quotes are last observations inside the minute, not executable-at-decision broker fills.',
    'No broker SL/TP first-hit, holding costs, unexpected spread changes, or real slippage modeled.',
    'An observed score is not a calibrated probability of winning and cannot authorize orders.',
    'An empty or missing quote cohort is UNKNOWN; no returns are imputed.',
   ],
  };
 }catch(e){try{await db.query('ROLLBACK')}catch{}throw e;}
}
function archiveFinalizedDays(report,base=path.dirname(REPORT)){
 const now=millis(report.generatedAt),archived=[];
 if(!Number.isFinite(now)||report.authority!=='SHADOW_ONLY'||
  report.modifiesExecution!==false||report.placesOrders!==false)
  throw Error('ARCHIVE_REQUIRES_VERIFIED_SHADOW_REPORT');
 const dailyDir=path.join(base,'daily');
 for(const day of Object.keys(report.byDay)){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))continue;
  const nextMidnight=Date.parse(day+'T00:00:00Z')+86400000;
  // All 15m marks plus provider settlement buffer must have elapsed.
  if(now<nextMidnight+20*60000)continue;
  const destination=path.join(dailyDir,day+'.json');
  if(fs.existsSync(destination))continue; // Immutable finalized snapshot.
  const episodes=report.episodes.filter(x=>x.evaluated_at.slice(0,10)===day);
  if(!episodes.length)continue;
  fs.mkdirSync(dailyDir,{recursive:true,mode:0o700});
  const data={artifact:report.artifact,day,finalizedAt:report.generatedAt,
   authority:'SHADOW_ONLY',modifiesExecution:false,placesOrders:false,
   cohort:summary(episodes),episodes};
  const tmp=destination+'.tmp.'+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});
  fs.renameSync(tmp,destination);
  archived.push(day);
 }
 return archived;
}
async function collect(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const client=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME||'irexpro_dev',
  user:process.env.DB_USER||'irexpro',password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-prospective-direction-calibrator-readonly',
  connectionTimeoutMillis:10000,query_timeout:30000});
 try{
  await client.connect();const report=await run(client,process.env.VPS_FOREX_SCANNER_USER_ID);
  fs.mkdirSync(path.dirname(REPORT),{recursive:true,mode:0o700});
  const tmp=REPORT+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(report,null,2),{mode:0o600});
  fs.renameSync(tmp,REPORT);
  archiveFinalizedDays(report);
  return report;
 }finally{await client.end();}
}
// If PostgreSQL is overloaded, enrich a verified recent existing snapshot
// without pretending any new broker quote was fetched. Keep its original
// generatedAt, with a separate time for this research-only calculation.
function enrichCachedReport(file=REPORT,now=new Date()){
 const r=JSON.parse(fs.readFileSync(file,'utf8'));
 const age=now.getTime()-Date.parse(r.generatedAt);
 if(r.artifact!==ARTIFACT||r.authority!=='SHADOW_ONLY'||
    r.modifiesExecution!==false||r.placesOrders!==false||
    !Array.isArray(r.episodes)||!Number.isFinite(age)||age<0||
    age>6*3600000)
  throw Error('NO_VERIFIED_RECENT_RESEARCH_SNAPSHOT');
 r.dayPurgedDirectionalResearch=evaluateDayPurgedDirection(
   r.episodes,new Date(r.generatedAt));
 r.directionResearchRefreshedAt=now.toISOString();
 r.directionResearchBasedOnCachedBrokerQuotes=true;
 const tmp=file+'.enrichment.'+process.pid+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(r,null,2),{mode:0o600});
 fs.renameSync(tmp,file);
 return {originalQuoteReportAt:r.generatedAt,computedAt:now.toISOString(),
   outOfSample:r.dayPurgedDirectionalResearch.qualifiedOutOfSample,
   requiresFreshBrokerQuery:true,modifiesExecution:false};
}
async function main(){
 const watch=process.argv.includes('--watch');let busy=false,lastSignature='';
 async function cycle(){
  if(busy)return;busy=true;
  try{
   const r=await collect();
   const signature=JSON.stringify({
    episodes:r.selectedEpisodes,summary:r.byHorizon,
    directionalCalibration:r.dayPurgedDirectionalResearch?.byChoice,
    telemetry:{qualified:r.telemetry.jointlyQualified,
     matured:r.telemetry.maturedQualified,status:r.telemetry.status},
   });
   if(signature!==lastSignature){
    console.log('FORWARD_DIRECTION_CALIBRATION',JSON.stringify({
     generatedAt:r.generatedAt,selected:r.selectedEpisodes,
     admittedRows:r.rawAdmittedDecisions,telemetry:r.telemetry,
     byHorizon:r.byHorizon,
     dayPurgedDirection:{
      qualifiedOutOfSample:r.dayPurgedDirectionalResearch?.qualifiedOutOfSample,
      byChoice:r.dayPurgedDirectionalResearch?.byChoice,
     },
    }));
    lastSignature=signature;
   }
  }catch(e){
   console.error('FORWARD_DIRECTION_CALIBRATION_FAILED',String(e?.message).slice(0,170));
   try{
    const cached=enrichCachedReport();
    console.log('DIRECTION_RESEARCH_CACHED_SNAPSHOT',JSON.stringify(cached));
   }catch(error){
    console.warn('DIRECTION_RESEARCH_CACHE_NOT_AVAILABLE',
      String(error?.message).slice(0,110));
   }
  }finally{busy=false;}
 }
 await cycle();if(watch)setInterval(()=>void cycle(),RESEARCH_CADENCE_MS);
}
module.exports={START,ARTIFACT,SQL_SESSION,SQL_SIGNALS,SQL_PROGRESS,SQL_QUOTES,
 selectEpisodes,evaluateEpisode,bucket,qualityBand,summary,
 archiveFinalizedDays,RESEARCH_CADENCE_MS,enrichCachedReport,run};
if(require.main===module)main().catch(e=>{console.error('CALIBRATION_FATAL',e.message);process.exitCode=1});
