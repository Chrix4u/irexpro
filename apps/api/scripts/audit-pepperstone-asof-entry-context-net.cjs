#!/usr/bin/env node
'use strict';
/**
 * Research-only owner DEMO comparison: causal pre-intent broker quotes,
 * immutable submitted model diagnostics, actual broker-settled net outcomes.
 * Entry feature samples must have BOTH market and observation timestamps
 * at or before the trade intent. No hypothetical orders or broker changes.
 */
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {
 evaluateFrozenCheckpoint,evaluateCheckpointMark,
}=require('./owner-demo-entry-timing-checkpoint-shadow.cjs');
const ARTIFACT='irexpro-owner-pepperstone-demo-causal-entry-net-diagnostic-v1';
const OUT='/home/lightworld/webapps/irexpro-research/entry-context-net/latest-report.json';
const ROOT='/home/lightworld/webapps/irexpro-research/native-quote-snapshots';
const PAIRS=['EURUSD','AUDUSD','USDJPY','USDCAD'];
const ROUTES=['EARLY_TRANSITION','CONFIRMED_REVERSAL'];
const HORIZONS=[1,3,5,10];
const MAX_TRADES=450;
const MINUTE=60000,DAY=86400000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
 "SELECT t.id::text AS trade_key,t.instrument,t.direction,t.opened_at,t.closed_at,",
 "t.fill_price,t.stop_loss,t.take_profit,t.lot_size,t.realised_pnl,t.commission,",
 "t.swap,t.max_favorable_pnl,t.close_reason,ti.created_at AS intent_at,",
 "ti.metadata->>'multimodel_plan_b_route' AS strategy_route,",
 "ti.metadata->>'multimodel_governance_net_expected_r' AS expected_r,",
 "ti.metadata->>'multimodel_plan_b_score' AS plan_b_score,",
 "ti.metadata->>'multimodel_trained_expert_confidence' AS expert_confidence,",
 "ti.metadata->>'multimodel_trained_expert_state' AS expert_state,",
 "ti.metadata->>'multimodel_trained_expert_direction' AS expert_direction,",
 "ti.metadata->>'multimodel_trained_expert_long_votes' AS expert_long_votes,",
 "ti.metadata->>'multimodel_trained_expert_short_votes' AS expert_short_votes,",
 "ti.metadata->>'m1_tactical_route' AS m1_route,",
 "ti.metadata->>'multimodel_execution_authority_path' AS authority_path,",
 "ti.metadata->>'feature_rsi14' AS m1_rsi14,",
 "ti.metadata->>'feature_extension_atr' AS extension_atr,",
 "ti.metadata->>'m1_policy_version' AS policy_version,",
 "ti.metadata->>'signal_suggested_entry_price' AS planned_entry,",
 "ca.created_at AS allocation_at,",
 "ca.sizing_inputs->>'finalRiskAtStop' AS final_risk_at_stop",
 "FROM trading.trades t JOIN broker.broker_connections b",
 "ON b.id=t.broker_connection_id AND b.user_id=t.user_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
 "AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id",
 "LEFT JOIN LATERAL (SELECT c.created_at,c.sizing_inputs",
 " FROM trading.capital_allocations c",
 " WHERE c.trade_intent_id=ti.id AND c.created_at<=t.opened_at",
 " ORDER BY c.created_at DESC LIMIT 1) ca ON true",
 "WHERE t.user_id=$1 AND b.user_id=$1",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.deleted_at IS NULL AND t.account_currency='USD'",
 "AND t.status='CLOSED' AND t.closed_at IS NOT NULL",
 "AND t.opened_at >= $2::timestamptz AND t.closed_at < $3::timestamptz",
 "AND ti.metadata->>'multimodel_plan_b_route' IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
 "AND t.instrument IN ('EURUSD','AUDUSD','USDJPY','USDCAD')",
 "ORDER BY t.opened_at,t.id LIMIT 451",
].join(' ');
const n=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ts=x=>x==null?NaN:new Date(x).getTime();
const round=(v,k=3)=>Number(v.toFixed(k));
const sign=s=>s==='BUY'?1:s==='SELL'?-1:0;
const pip=s=>s.endsWith('JPY')?.01:.0001;
function parseLine(r){
 if(!Array.isArray(r)||r.length!==5)return null;
 const [source,seen,pair,bid,ask]=r;
 const at=ts(source),observed=ts(seen),b=n(bid),a=n(ask);
 if(!PAIRS.includes(pair)||!Number.isFinite(at)||!Number.isFinite(observed)||
  observed<at||observed-at>10000||b===null||a===null||b<=0||a<=b)
  return null;
 return {at,observed,bid:b,ask:a,mid:(b+a)/2,spread:a-b};
}
function lowerBound(a,at){
 let lo=0,hi=a.length;
 while(lo<hi){const mid=(lo+hi)>>>1;
  if(a[mid].at<at)lo=mid+1;else hi=mid}
 return lo;
}
function lastAsOf(quotes,target,maxAgeMs=20000){
 for(let idx=lowerBound(quotes,target+1)-1;idx>=0;idx--){
  const q=quotes[idx];if(q.at<target-maxAgeMs)break;
  if(q.observed<=target&&target-q.observed<=maxAgeMs)return q;
 }
 return null;
}
function asOfFeatures(t,quotes){
 if(!Number.isFinite(t.intentAt)||!Number.isFinite(t.openedAt)||
  t.intentAt>t.openedAt||t.openedAt-t.intentAt>120000)
  return {status:'INVALID_INTENT_TIME'};
 const current=lastAsOf(quotes,t.intentAt,15000);
 if(!current)return {status:'NO_FRESH_PRE_INTENT_QUOTE'};
 const quality={
  status:'FRESH_ASOF_BROKER_QUOTE',
  latestEventAt:new Date(current.at).toISOString(),
  latestObservedAt:new Date(current.observed).toISOString(),
  quoteAgeSeconds:round((t.intentAt-current.observed)/1000,2),
  spreadPips:round(current.spread/pip(t.instrument),3),
  m1Direction:'UNAVAILABLE',m5Direction:'UNAVAILABLE',
  aligned15sPips:null,aligned60sPips:null,aligned300sPips:null,
  m5QuoteCoverage:'UNAVAILABLE',
  neverUsesPostIntentQuote:true,
 };
 for(const [key,delta] of [['aligned15sPips',15000],
  ['aligned60sPips',60000],['aligned300sPips',300000]]){
  const prior=lastAsOf(quotes,t.intentAt-delta,20000);
  if(prior)quality[key]=round(t.sgn*(current.mid-prior.mid)/pip(t.instrument),3);
 }
 if(quality.aligned60sPips!==null){
  quality.m1Direction=quality.aligned60sPips>=.3?'AGREES':
   quality.aligned60sPips<=-.3?'OPPOSES':'FLAT';
 }
 const start=t.intentAt-300000;
 const previous=quotes.slice(lowerBound(quotes,start),lowerBound(quotes,t.intentAt+1))
  .filter(q=>q.observed<=t.intentAt);
 if(quality.aligned300sPips!==null&&previous.length>=10){
  let maxGap=0,last=start;
  const coverage=new Set();
  for(const q of previous){
   maxGap=Math.max(maxGap,q.at-last);last=q.at;
   coverage.add(Math.floor((q.at-start)/MINUTE));
  }
  maxGap=Math.max(maxGap,t.intentAt-last);
  quality.m5MaxObservedGapSeconds=round(maxGap/1000,2);
  quality.m5MinutesWithQuotes=coverage.size;
  if(maxGap<=30000&&coverage.size>=5){
   quality.m5QuoteCoverage='FREQUENT_POLL_QUOTE_SAMPLES';
   quality.m5Direction=quality.aligned300sPips>=.6?'AGREES':
    quality.aligned300sPips<=-.6?'OPPOSES':'FLAT';
  }else quality.m5QuoteCoverage='GAPPED_POLL_QUOTE_SAMPLES';
 }
 return quality;
}
function afterOpenMark(t,quotes,minutes,now){
 const at=t.openedAt+minutes*MINUTE;
 if(now<at+10000)return {status:'NOT_MATURED'};
 const q=lastAsOf(quotes,at,10000);
 if(!q||q.at<t.openedAt)return {status:'NO_FRESH_HORIZON_QUOTE'};
 const side=t.direction==='BUY'?q.bid:q.ask;
 return {
  status:'SAMPLED_MARK_ONLY',
  afterActualExit:at>=t.closedAt,
  horizonMinutes:minutes,
  alignedPipsFromBrokerEntry:round(t.sgn*(side-t.entry)/pip(t.instrument),3),
  directionAtHorizon:t.sgn*(side-t.entry)>.00000001?'CORRECT':
   t.sgn*(side-t.entry)<-.00000001?'WRONG':'NEUTRAL',
  quoteAgeSeconds:round((at-q.observed)/1000,2),
  observedAt:new Date(q.observed).toISOString(),
  cannotInferBrokerFill:true,
 };
}
function tradeFromRow(r){
 const openedAt=ts(r.opened_at),closedAt=ts(r.closed_at),intentAt=ts(r.intent_at),
  allocationAt=ts(r.allocation_at),sgn=sign(r.direction),
  entry=n(r.fill_price),stop=n(r.stop_loss),tp=n(r.take_profit),
  risk=n(r.final_risk_at_stop),gross=n(r.realised_pnl),fee=n(r.commission),
  swap=n(r.swap);
 if(!PAIRS.includes(r.instrument)||!ROUTES.includes(r.strategy_route)||
  !sgn||!Number.isFinite(openedAt)||!Number.isFinite(closedAt)||openedAt>=closedAt||
  entry===null||stop===null||tp===null||entry<=0||stop<=0||tp<=0||
  sgn*(entry-stop)<=0||sgn*(tp-entry)<=0||gross===null||fee===null||swap===null)
  return {status:'INVALID_OR_INCOMPLETE_BROKER_SETTLEMENT'};
 const validRisk=risk!==null&&risk>0&&Number.isFinite(allocationAt)&&
  allocationAt<=openedAt;
 const expected=n(r.expected_r);
 return {
  status:'VALID',tradeKey:String(r.trade_key||''),instrument:r.instrument,
  direction:r.direction,sgn,entry,stop,tp,openedAt,closedAt,intentAt,
  day:new Date(openedAt).toISOString().slice(0,10),
  route:r.strategy_route,authorityPath:r.authority_path||'UNKNOWN',
  modelPolicy:r.policy_version||'UNKNOWN',
  m1Route:r.m1_route||'UNKNOWN',
  expertState:r.expert_state||'UNKNOWN',
  expertDirection:r.expert_direction||'UNKNOWN',
  expertVotesFor:r.direction==='BUY'?n(r.expert_long_votes):n(r.expert_short_votes),
  expertVotesAgainst:r.direction==='BUY'?n(r.expert_short_votes):n(r.expert_long_votes),
  expertConfidence:n(r.expert_confidence),
  expectedR:expected,planBScore:n(r.plan_b_score),
  m1Rsi14:n(r.m1_rsi14),extensionAtr:n(r.extension_atr),
  plannedEntry:n(r.planned_entry),
  gross,commission:fee,swap,net:round(gross+fee+swap,2),
  riskAtStop:validRisk?risk:null,
  netRealizedR:validRisk?round((gross+fee+swap)/risk,5):null,
  maxFavorableBrokerNet:n(r.max_favorable_pnl),closeReason:r.close_reason,
 };
}
function summarize(rows){
 const good=rows.filter(r=>r.status==='VALID');
 const priced=good.filter(r=>r.netRealizedR!==null);
 const paired=priced.filter(r=>r.expectedR!==null);
 const wins=good.filter(r=>r.net>0),losses=good.filter(r=>r.net<0);
 const avg=x=>x.length?round(x.reduce((s,z)=>s+z,0)/x.length,4):null;
 const h={};
 for(const m of HORIZONS){
  const available=good.map(x=>x.forward[m+'m']).filter(x=>x.status==='SAMPLED_MARK_ONLY');
  const during=available.filter(x=>!x.afterActualExit);
  const after=available.filter(x=>x.afterActualExit);
  h[m+'m']={freshBrokerQuoteMarks:available.length,
   withinPosition: during.length,
   afterActualExitMarketOnly:after.length,
   directionCorrectDuringOpen:during.filter(x=>x.directionAtHorizon==='CORRECT').length,
   directionWrongDuringOpen:during.filter(x=>x.directionAtHorizon==='WRONG').length,
   noQuoteOrNotMature:good.length-available.length};
 }
 return {
  trades:rows.length,validSettlements:good.length,
  netBookUsd:round(good.reduce((s,r)=>s+r.net,0),2),
  winners:wins.length,losers:losses.length,
  netWinRate:good.length?round(wins.length/good.length,4):null,
  averageWinUsd:avg(wins.map(r=>r.net)),
  averageLossUsd:avg(losses.map(r=>r.net)),
  grossUsd:round(good.reduce((s,r)=>s+r.gross,0),2),
  commissionsUsd:round(good.reduce((s,r)=>s+r.commission,0),2),
  nWithRisk:priced.length,nWithPairedForecast:paired.length,
  meanRealizedNetR:avg(priced.map(r=>r.netRealizedR)),
  meanSubmittedForecastR:avg(paired.map(r=>r.expectedR)),
  meanRealizedMinusForecastR:avg(paired.map(r=>r.netRealizedR-r.expectedR)),
  asOfQuoteAvailable:good.filter(r=>r.asOf.status==='FRESH_ASOF_BROKER_QUOTE').length,
  asOfM1MomentumAgree:good.filter(r=>r.asOf.m1Direction==='AGREES').length,
  asOfM1MomentumOppose:good.filter(r=>r.asOf.m1Direction==='OPPOSES').length,
  asOfM5QuoteCoverage:good.filter(r=>r.asOf.m5QuoteCoverage==='FREQUENT_POLL_QUOTE_SAMPLES').length,
  byHorizon:h,
 };
}
function group(rows,pick){
 const groups=new Map();
 for(const row of rows){
  const key=String(pick(row)??'UNAVAILABLE');if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(row);
 }
 return Object.fromEntries([...groups].sort(([a],[b])=>a.localeCompare(b))
  .map(([key,items])=>[key,summarize(items)]));
}
function scoreBucket(n){
 if(n===null)return 'UNKNOWN';
 return n<0.2?'LESS_THAN_0.2':n<0.4?'0.2_TO_0.4':'0.4_PLUS';
}
function firstMinuteClass(t){
 const at=t.forward?.['1m'];
 if(!at||at.status!=='SAMPLED_MARK_ONLY')return 'NO_FRESH_1M_MARK';
 if(at.afterActualExit)return 'CLOSED_BEFORE_1M';
 return at.directionAtHorizon;
}
function checkpointSummary(rows){
 const selected=rows.filter(t=>t.timingCheckpoint?.state==='DEFERRED_ENTRY_RESEARCH_CANDIDATE');
 const horizons={};
 for(const m of [3,5,10]){
  const obs=selected.map(t=>t.timingForward[m+'m']);
  const fresh=obs.filter(x=>x.status==='QUOTE_ONLY_HYPOTHETICAL_MARK');
  const during=fresh.filter(x=>!x.afterOriginalRealTradeClosed);
  horizons[m+'m']={
   quoteMarks:fresh.length,whileRealTradeStillOpen:during.length,
   afterRealTradeClosedCensored:fresh.length-during.length,
   directionalPositiveDuringOpen:during.filter(x=>x.directionPositive).length,
   directionalNegativeDuringOpen:during.filter(x=>!x.directionPositive).length,
   notObservedOrNotMature:selected.length-fresh.length,
   noBrokerFillsSimulated:true,
  };
 }
 return {frozenPolicy:'UNTRAINED_OBSERVATIONAL_60S_SNAPSHOT_V1',
  tradesReviewed:rows.length,asOfCheckpointCandidates:selected.length,
  horizons,eligibleForPromotion:false,modifiesExecution:false};
}
function analyze(rows,archive,asOf){
 const valid=rows.map(tradeFromRow);
 for(const t of valid){
  if(t.status!=='VALID')continue;
  const quotes=archive[t.instrument]??[];
  t.asOf=asOfFeatures(t,quotes);
  t.forward=Object.fromEntries(HORIZONS.map(h=>[
   h+'m',afterOpenMark(t,quotes,h,asOf.getTime())
  ]));
  t.timingCheckpoint=evaluateFrozenCheckpoint(t,quotes,asOfFeatures,asOf.getTime());
  t.timingForward=Object.fromEntries([3,5,10].map(h=>[
   h+'m',evaluateCheckpointMark(t,quotes,t.timingCheckpoint,h,asOf.getTime())
  ]));
 }
 const good=valid.filter(t=>t.status==='VALID');
 return {
  artifact:ARTIFACT,generatedAt:asOf.toISOString(),
  scope:'OWNER_PEPPERSTONE_CTRADER_USD_DEMO_EARLY_TRANSITION_CONFIRMED_REVERSAL',
  mode:'READ_ONLY',modifiesExecution:false,modifiesModels:false,placesOrders:false,
  modifiesLotSizing:false,permitsLivePromotion:false,
  independentTradingDates:new Set(good.map(t=>t.day)).size,
  assessment:'INSUFFICIENT_INDEPENDENT_FORWARD_DAYS_FOR_MODEL_PROMOTION',
  summary:summarize(valid),
  byTradingDay:group(good,t=>t.day),
  byStrategy:group(good,t=>t.route),
  byFrozen60sShadowCheckpoint:group(good,t=>t.timingCheckpoint.state),
  byRouteAndFrozen60sCheckpoint:group(good,t=>t.route+'/'+t.timingCheckpoint.state),
  frozen60sShadowOutcome:checkpointSummary(good),
  byPairSide:group(good,t=>t.instrument+'/'+t.direction),
  byPlanBExpectedR:group(good,t=>scoreBucket(t.expectedR)),
  byFirstMinuteObservedDirection:group(good,firstMinuteClass),
  byRouteAndFirstMinute:group(good,t=>t.route+'/'+firstMinuteClass(t)),
  byM1TacticalRoute:group(good,t=>t.m1Route),
  byAsOfM1Momentum:group(good,t=>t.asOf.m1Direction),
  byAsOfM5QuoteContext:group(good,t=>t.asOf.m5Direction),
  byStrategyAndAsOfM1Momentum:group(good,t=>t.route+'/'+t.asOf.m1Direction),
  byExpertState:group(good,t=>t.expertState),
  details:valid,
  limitations:[
   'The frozen 60-second timing shadow is calculated only after the originally traded position has opened. It is an OBSERVATIONAL delayed-entry candidate, not a full counterfactual broker order or a new training set.',
   'Entry quote features are selected solely from independently timestamped snapshots where market event AND observed times precede the original submitted trade intent.',
   'The archived broker quote collector is POLLED, not tick-complete; five-minute momentum is sampled price change, NOT a certified native M5 candlestick or trained strategy model.',
   'The M1/M5 as-of labels are heuristic bins chosen for diagnosis, not fitted thresholds or validated trade gates.',
   'The recorded model expected R, vote count and specialist route are from the original pre-order trade intent, not re-scored after the trade.',
   'The 1/3/5/10-minute future price marks are outcomes only. Marks AFTER actual position close are explicitly flagged and are never counted as in-position returns.',
   'After-entry quote marks are market-direction observations, not executable fills, actual unrealized P&L, or an alternative order simulation.',
   'Actual net is gross plus signed commission and swap. Risk-normalized net excludes rows lacking a valid allocation created before entry.',
   'Correlated currencies, model policy changes and few distinct market days prohibit a reliable out-of-sample profit claim.',
   'No entry restrictions, lot changes, profit-protection changes, broker SL/TP amendments, new orders or LIVE execution are authorized here.',
  ],
 };
}
async function loadArchive(rows,root=ROOT){
 const archive=Object.fromEntries(PAIRS.map(x=>[x,[]]));
 const info={read:0,accepted:0,sourceDays:[],missingDays:[]};
 if(!rows.length)return {archive,info};
 const days=new Set();
 for(const r of rows){
  const opened=ts(r.opened_at),decision=ts(r.intent_at);
  for(let day=Math.floor((decision-330000)/DAY)*DAY;
   day<=opened+11*MINUTE;day+=DAY)
   days.add(new Date(day).toISOString().slice(0,10));
 }
 if(days.size>20)throw Error('TOO_MANY_ARCHIVE_DAYS');
 for(const day of [...days].sort()){
  const file=path.join(root,day+'.jsonl');
  if(!fs.existsSync(file)){info.missingDays.push(day);continue;}
  const size=fs.statSync(file);
  if(!size.isFile()||size.size>90000000)throw Error('ARCHIVE_FILE_INVALID');
  info.sourceDays.push(day);
  for await(const line of readline.createInterface({
   input:fs.createReadStream(file),crlfDelay:Infinity})){
   if(line.length>280)continue;
   info.read++;
   let raw;try{raw=JSON.parse(line)}catch{continue}
   const q=parseLine(raw);if(!q)continue;
   archive[raw[2]].push(q);info.accepted++;
  }
 }
 for(const pair of PAIRS){
  archive[pair].sort((a,b)=>a.at-b.at||a.observed-b.observed);
  const dedup=[];
  for(const q of archive[pair]){
   if(dedup.length&&dedup[dedup.length-1].at===q.at)continue;
   dedup.push(q);
  }
  archive[pair]=dedup;
 }
 return {archive,info};
}
async function audit(client,owner,from,to=new Date()){
 if(!UUID.test(owner||''))throw Error('UNVERIFIED_OWNER');
 const start=ts(from),end=ts(to);
 if(!Number.isFinite(start)||!Number.isFinite(end)||
  start>=end||end-start>14*DAY)throw Error('INVALID_AUDIT_WINDOW');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 let rows;
 try{
  await client.query("SET LOCAL statement_timeout='25000ms'");
  rows=(await client.query(SQL,[owner,new Date(start).toISOString(),
   new Date(end).toISOString()])).rows;
  if(rows.length>MAX_TRADES)throw Error('TRUNCATED_OWNER_COHORT');
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
 const {archive,info}=await loadArchive(rows);
 const report=analyze(rows,archive,new Date(end));
 return {...report,quoteArchive:info};
}
async function main(){
 require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||
  path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const {getDatabaseSslOptions}=require('../dist/config/database-tls');
 const c=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-owner-demo-asof-entry-net-readonly'});
 try{
  await c.connect();const report=await audit(c,process.env.VPS_FOREX_SCANNER_USER_ID,
   '2026-11-17T00:00:00Z',new Date());
  fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
  const temp=OUT+'.'+process.pid+'.tmp';
  const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(report,null,2))}
  finally{fs.closeSync(fd)}
  fs.renameSync(temp,OUT);
  console.log('ASOF_OWNER_DEMO_ENTRY_CONTEXT',JSON.stringify({
   at:report.generatedAt,summary:report.summary,
   byDay:report.byTradingDay,byExpectedR:report.byPlanBExpectedR,
   byM1Context:report.byAsOfM1Momentum,quoteArchive:report.quoteArchive,
  }));
 }finally{await c.end()}
}
module.exports={ARTIFACT,SQL,parseLine,lowerBound,lastAsOf,asOfFeatures,
 afterOpenMark,tradeFromRow,scoreBucket,firstMinuteClass,checkpointSummary,summarize,analyze,loadArchive,audit};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_DEMO_ASOF_ENTRY_AUDIT_FAILED',e.message);
 process.exitCode=1;
});
