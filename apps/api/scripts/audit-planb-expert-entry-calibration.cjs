'use strict';

/**
 * As-of model disagreement and rapid loss-retry calibration.
 * This is read-only, observational, and NEVER integrated with order dispatch,
 * trading authorization, risk vetoes, lot sizing, or model promotion.
 */
const {resolve}=require('node:path');
const {mkdirSync,writeFileSync}=require('node:fs');

const ARTIFACT='planb-expert-opportunity-and-reentry-readonly-v1';
const REPORT='/home/lightworld/webapps/irexpro-research/planb-expert-entry/latest-report.json';
const MAX_ROWS=3000;
const HISTORY_DAYS=30;
const OPPORTUNITY_EXPLORATORY_BAND=0.35; // Post-hoc exploration; NOT an execution threshold.
const RECENT_LOSS_WINDOW_MS=10*60*1000;
const RETRY_ENTRY_DISTANCE_R=0.35; // Research definition only, not a proposed gate.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_SQL=[
  'SELECT current_timestamp AS "snapshotAt" FROM broker.broker_connections',
  "WHERE id=$1 AND user_id=$2 AND broker_id='ctrader'",
  "AND account_type='DEMO' AND deleted_at IS NULL",
].join(' ');

// Every expert score was saved BEFORE intent submission. Match the exact
// account/user + decision ID; never attach a score from a later scan.
const ROWS_SQL=[
  'SELECT t.id,t.instrument,t.direction,t.opened_at AS "openedAt",',
  't.realised_pnl AS gross,t.commission,t.swap,',
  'i.created_at AS "intentAt",',
  'i.metadata->>\'multimodel_plan_b_route\' AS route,',
  'i.metadata->>\'signal_suggested_entry_price\' AS "plannedEntry",',
  'd.created_at AS "decisionAt",',
  "d.governance #>> '{multimodelTrainedExpert,state}' AS \"expertState\",",
  "d.governance #>> '{multimodelTrainedExpert,meanOpportunityProbability}' AS \"expertOpportunity\",",
  "d.governance #>> '{multimodelTrainedExpert,ensembleConfidence}' AS \"expertConfidence\",",
  'p.closed_at AS "priorLossAt",p.fill_price AS "priorEntry",',
  'p.stop_loss AS "priorStop"',
  'FROM trading.trades t',
  'JOIN trading.trade_intents i ON i.id=t.trade_intent_id',
  'AND i.user_id=t.user_id AND i.broker_connection_id=t.broker_connection_id',
  'LEFT JOIN trading.m1_tactical_decisions d',
  'ON d.id::text=i.metadata->>\'m1_decision_id\'',
  'AND d.user_id=t.user_id AND d.broker_connection_id=t.broker_connection_id',
  'AND d.created_at<=i.created_at',
  'LEFT JOIN LATERAL (',
  ' SELECT q.closed_at,q.fill_price,q.stop_loss',
  ' FROM trading.trades q',
  ' WHERE q.user_id=t.user_id AND q.broker_connection_id=t.broker_connection_id',
  ' AND q.instrument=t.instrument AND q.direction=t.direction',
  " AND q.status='CLOSED' AND q.closed_at<i.created_at",
  " AND q.closed_at>=i.created_at-interval '15 minutes'",
  ' AND q.realised_pnl IS NOT NULL AND q.commission IS NOT NULL',
  ' AND q.realised_pnl+q.commission+coalesce(q.swap,0)<0',
  ' ORDER BY q.closed_at DESC,q.id DESC LIMIT 1',
  ') p ON TRUE',
  'WHERE t.user_id=$1 AND t.broker_connection_id=$2',
  "AND t.status='CLOSED' AND t.account_currency='EUR'",
  "AND i.metadata->>'multimodel_execution_authority_path'='PRIMARY_PLAN_B'",
  "AND t.instrument IN ('AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY')",
  'AND t.opened_at>=$3::timestamptz AND t.opened_at<=$4::timestamptz',
  'ORDER BY t.opened_at,t.id LIMIT $5::int',
].join('\n');

function number(value){
  if(value===null||value===undefined||value==='')return null;
  const x=Number(value);
  return Number.isFinite(x)?x:null;
}
function millis(value){
  if(value===null||value===undefined||value==='')return null;
  const t=new Date(value).getTime();
  return Number.isFinite(t)?t:null;
}
function money(x){return Math.round((x+Number.EPSILON)*100)/100;}
function normalize(row){
  const gross=number(row.gross),commission=number(row.commission);
  const openedAt=millis(row.openedAt),intentAt=millis(row.intentAt);
  if(!row.id||openedAt===null||intentAt===null||intentAt>openedAt||
    !['BUY','SELL'].includes(row.direction)||
    !['TREND_CONTINUATION','EARLY_TRANSITION','CONFIRMED_REVERSAL'].includes(row.route)||
    !['AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY'].includes(row.instrument)) {
    throw Error('INVALID_BROKER_TRADE_PROVENANCE');
  }
  const complete=gross!==null&&commission!==null;
  const expertAt=millis(row.decisionAt);
  const expert=number(row.expertOpportunity);
  const verified=expertAt!==null&&expertAt<=intentAt &&
    expertAt>=intentAt-5*60*1000&&
    expert!==null&&expert>=0&&expert<=1;
  const band=!verified?'UNVERIFIED_EXPERT_PROVENANCE':
    expert<OPPORTUNITY_EXPLORATORY_BAND?'EXPLORATORY_LOW':'EXPLORATORY_HIGH';
  const priorLossAt=millis(row.priorLossAt);
  const plannedEntry=number(row.plannedEntry);
  const previousEntry=number(row.priorEntry);
  const previousStop=number(row.priorStop);
  const priorDistance=previousEntry===null||previousStop===null?
    null:Math.abs(previousEntry-previousStop);
  const retryDistance=plannedEntry===null||previousEntry===null||
    priorDistance===null||priorDistance<=0?null:
    Math.abs(plannedEntry-previousEntry)/priorDistance;
  const rapidRepeat=priorLossAt!==null &&
    priorLossAt<intentAt &&
    intentAt-priorLossAt<=RECENT_LOSS_WINDOW_MS &&
    retryDistance!==null&&retryDistance<=RETRY_ENTRY_DISTANCE_R;
  return {
    day:new Date(openedAt).toISOString().slice(0,10),
    id:String(row.id),instrument:row.instrument,direction:row.direction,
    route:row.route,openedAt,intentAt,
    expertBand:band,expertOpportunity:verified?expert:null,
    expertState:verified?(row.expertState||'UNKNOWN'):'UNVERIFIED',
    expertConfidence:verified?number(row.expertConfidence):null,
    rapidSameSideLossRetry:rapidRepeat,
    priorLossDistanceR:retryDistance,
    hasCompleteBrokerEconomics:complete,
    net:complete?gross+commission+(number(row.swap)??0):null,
    gross:complete?gross:null,commission:complete?commission:null,
  };
}
function summarize(rows){
  let positives=0,net=0,gross=0,fees=0;
  const days=new Set(),pricedDays=new Set();
  let priced=0,failed=0;
  for(const item of rows){
    days.add(item.day);
    if(item.net===null){failed++;continue;}
    priced++;pricedDays.add(item.day);
    if(item.net>0)positives++;
    net+=item.net;gross+=item.gross;fees+=item.commission;
  }
  return {
    records:rows.length,priced,unpriced:failed,days:days.size,pricedDays:pricedDays.size,
    netWins:positives,
    netWinFraction:priced?Number((positives/priced).toFixed(4)):null,
    netEUR:priced?money(net):null,
    grossEUR:priced?money(gross):null,
    commissionsEUR:priced?money(fees):null,
    coverageComplete:failed===0,
    forwardQualified:false,
    reason:pricedDays.size<12?'INSUFFICIENT_INDEPENDENT_DAYS':'NEEDS_FORWARD_HOLDOUT',
  };
}
function byGroup(rows,fn){
  const groups={};
  for(const item of rows)(groups[fn(item)]??=[]).push(item);
  return Object.fromEntries(Object.entries(groups).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,items])=>[key,summarize(items)]));
}
function analyze(raw,asOf){
  const rows=raw.map(normalize).sort((a,b)=>a.openedAt-b.openedAt||a.id.localeCompare(b.id));
  const seen=new Set();
  for(const item of rows){if(seen.has(item.id))throw Error('DUPLICATE_BROKER_TRADE');seen.add(item.id)}
  const daily=byGroup(rows,x=>x.day);
  const expertRoute=byGroup(rows,x=>x.route+'/'+x.expertBand);
  const pairSide=byGroup(rows,x=>x.instrument+'/'+x.direction+'/'+x.route+'/'+x.expertBand);
  const retry=byGroup(rows,x=>x.rapidSameSideLossRetry?'RECENT_SIMILAR_LOSS_RETRY':'OTHER');
  return {
    artifact:ARTIFACT,asOf:new Date(asOf).toISOString(),
    mode:'READ_ONLY_SHADOW',modifiesOrders:false,modifiesExecution:false,
    exploratoryOpportunitySplit:OPPORTUNITY_EXPLORATORY_BAND,
    exploratoryRepeatWindowMinutes:RECENT_LOSS_WINDOW_MS/60000,
    exploratoryEntryToleranceRiskR:RETRY_ENTRY_DISTANCE_R,
    total:summarize(rows),expertRoute,pairSide,retry,byDay:daily,
    limitations:[
      'Expert opportunity threshold 0.35 and 10m/0.35R re-entry definition were selected during exploratory research: NOT prospective or validated.',
      'No training, fitted probability calibration, or out-of-sample inference is made from these labels.',
      'High-scoring expert ABSTAIN is not a CONFIRM; expert votes/confidence do not grant execution authority.',
      'Only realized, account-owned DEMO trades are observed. Rejected candidates and what-if fills are not in the cohort.',
      'Broker fill and gross/commission are measured after trade; plannedEntry is the as-of pre-order entry for retry measurement.',
      'Missing expert provenance or broker economics stays visible and never becomes a zero-fee win.',
      'Strategy versions and day regimes differ; no model should be promoted or blocked from these observational bands.',
      'No broker change, model weight/threshold modification, order side, lot size, emergency stop or LIVE/DEMO authority change.',
    ],
  };
}
async function run({client,userId,connectionId}){
  if(!UUID.test(userId||'')||!UUID.test(connectionId||''))throw Error('INVALID_DEMO_SCOPE');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='25000ms'");
    const owner=(await client.query(OWNER_SQL,[connectionId,userId])).rows[0];
    if(!owner)throw Error('NOT_USER_OWNED_CTRADER_DEMO');
    const asOf=new Date(owner.snapshotAt);
    const since=new Date(asOf.getTime()-HISTORY_DAYS*86400000);
    const results=(await client.query(ROWS_SQL,
      [userId,connectionId,since.toISOString(),asOf.toISOString(),MAX_ROWS+1])).rows;
    if(results.length>MAX_ROWS)throw Error('EXCEEDED_BOUNDED_HISTORY');
    const report=analyze(results,asOf);
    await client.query('COMMIT');
    return report;
  }catch(e){await client.query('ROLLBACK');throw e}
}
async function main(){
  require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||
    resolve(__dirname,'../.env'),quiet:true});
  const {Client}=require('pg');
  const {getDatabaseSslOptions}=require('../dist/config/database-tls');
  const client=new Client({
    host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
    password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    connectionTimeoutMillis:10000,
    application_name:'irexpro-expert-opportunity-retry-research-readonly',
  });
  try {
    await client.connect();
    const report=await run({
      client,userId:process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId:process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
    });
    mkdirSync(resolve(REPORT,'..'),{recursive:true,mode:0o700});
    writeFileSync(REPORT,JSON.stringify(report,null,2),{encoding:'utf8',mode:0o600});
    console.log('EXPERT_CALIBRATION_SHADOW '+JSON.stringify({
      artifact:report.artifact,asOf:report.asOf,total:report.total,
      expertRoute:report.expertRoute,retry:report.retry,
    }));
  }finally{await client.end()}
}
module.exports={ARTIFACT,ROWS_SQL,OWNER_SQL,number,millis,normalize,summarize,analyze,run};
if(require.main===module)main().catch(e=>{
  console.error('EXPERT_CALIBRATION_FAILED '+String(e?.message||'unknown').slice(0,150));
  process.exitCode=1;
});
