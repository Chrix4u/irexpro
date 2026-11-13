#!/usr/bin/env node
'use strict';
/**
 * Owner-bound, after-fee, prospective read-only outcomes for the frozen
 * Plan B CONFIRMED_REVERSAL / M1_TREND_CONTINUATION shadow hypothesis.
 * No order, stop, lot, session, model, or database mutations.
 * Results are candle MIDPOINT proxies, NOT broker fills or tick first touches.
 */
const fs=require('node:fs'),path=require('node:path');
const {score,quoteEligible}=require('./audit-planb-downstream-brake-firsttouch.cjs');
const ARTIFACT='irexpro-planb-reversal-m1-continuation-outcome-audit-v1';
const FIRST_PROSPECTIVE='2026-11-13T00:45:00.000Z';
const PAIRS=new Set(['EURUSD','AUDUSD','USDCAD','USDJPY']);
const q={
 scope:`SELECT s.user_id,b.id,b.broker_id AS broker,b.account_type AS account,
  b.account_currency AS currency,b.status,b.authorization_status AS authorization
 FROM trading.trading_sessions s JOIN broker.broker_connections b
 ON b.id=s.broker_connection_id AND b.user_id=s.user_id
 WHERE s.user_id=$1 AND b.broker_id='pepperstone-ctrader'
 AND b.account_type='DEMO' AND b.account_currency='USD'
 AND b.status='CONNECTED' AND b.authorization_status='ACTIVE'
 AND b.deleted_at IS NULL
 ORDER BY s.started_at DESC LIMIT 1`,
 coverage:`SELECT count(*)::int AS "scans",
 count(*) FILTER (WHERE d.governance ? 'planBReversalM1ContinuationShadow')::int AS "fieldSeen",
 count(*) FILTER (WHERE d.governance#>>'{planBReversalM1ContinuationShadow,artifact}'=
 'planb-reversal-m1-continuation-asof-shadow-v1')::int AS "validShadowRows"
 FROM trading.m1_tactical_decisions d
 WHERE d.user_id=$1 AND d.broker_connection_id=$2
 AND d.evaluated_at >=$3::timestamptz AND d.evaluated_at <$4::timestamptz`,
 decisions:`SELECT d.id,d.evaluated_at AS "evaluatedAt",d.instrument,d.direction,d.route,
  d.execution_authority AS "executionAuthority",d.blockers,
  d.governance#>'{planBReversalM1ContinuationShadow}' AS shadow,
  d.candidate->>'stopDistance' AS "stopDistance",
  d.candidate->>'targetDistance' AS "targetDistance",
  d.governance#>>'{multimodelGovernance,estimatedExecutionCostR}' AS "spreadCostR",
  d.governance#>>'{multimodelGovernance,executionSpreadEvidenceValid}' AS "spreadValid",
  d.governance#>>'{multimodelGovernance,eventRisk}' AS "eventRisk"
 FROM trading.m1_tactical_decisions d
 WHERE d.user_id=$1 AND d.broker_connection_id=$2
 AND d.evaluated_at >=$3::timestamptz AND d.evaluated_at <$4::timestamptz
 AND d.governance#>>'{planBReversalM1ContinuationShadow,mismatchObserved}'='true'
 ORDER BY d.evaluated_at,d.id LIMIT 5001`,
 quotes:`SELECT instrument,bucket_time AS timestamp,source,open,high,low,close,
  last_quote_sample_at,positive_quote_sample_count,bid_close,ask_close
 FROM market_data.provider_quote_candles
 WHERE connection_id=$1 AND timeframe='M1' AND source='ctrader-broker-native'
 AND bucket_time >=$2::timestamptz AND bucket_time <$3::timestamptz
 ORDER BY instrument,bucket_time LIMIT 40001`,
 fees:`SELECT t.closed_at AS "closedAt",t.instrument,t.lot_size AS lots,
 t.commission,t.swap FROM trading.trades t
 WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.status='CLOSED'
 AND t.account_currency='USD' AND t.closed_at >=$3::timestamptz
 AND t.closed_at <$4::timestamptz
 ORDER BY t.closed_at LIMIT 2001`
};
const at=x=>{const n=new Date(x).getTime();return Number.isFinite(n)?n:null};
const round=n=>Number(n.toFixed(4));
function eligibleRow(x) {
 const s=x&&x.shadow;
 return !!s&&s.artifact==='planb-reversal-m1-continuation-asof-shadow-v1'&&
  s.shadowOnly===true&&s.modifiesExecution===false&&
  s.automaticPromotionEligible===false&&s.brokerOrderAuthority==='NONE'&&
  s.mismatchObserved===true&&
  typeof s.eligibleForProspectiveStudy==='boolean'&&
  PAIRS.has(x.instrument)&&['BUY','SELL'].includes(x.direction)&&
  x.direction===s.direction&&x.instrument===s.instrument&&at(x.evaluatedAt)!==null;
}
function episodes(rows) {
 // Strict chronological first-observation leader: no selecting whichever
 // minute has the best subsequent outcome or preferred model label.
 const last=new Map(),out=[];
 for(const x of [...rows].sort((a,b)=>at(a.evaluatedAt)-at(b.evaluatedAt))){
  if(!eligibleRow(x))continue;
  const k=x.instrument+'/'+x.direction;
  const t=at(x.evaluatedAt);
  if(last.has(k)&&t-last.get(k)<30*60000)continue;
  last.set(k,t);out.push(x);
 }
 return out;
}
function summary(rows){
 const reasons={},days=new Set();
 let observed=0,wins=0,losses=0,total=0,gain=0,loss=0;
 let stopped=0,target=0,mark=0;
 for(const r of rows){
  const o=r.observation;
  if(o.state!=='OBSERVED_M1_MIDPOINT_PROXY'){
   reasons[o.state]=(reasons[o.state]||0)+1;continue;
  }
  observed++;days.add(new Date(r.evaluatedAt).toISOString().slice(0,10));
  total+=o.netR;
  if(o.netR>0){wins++;gain+=o.netR}
  else if(o.netR<0){losses++;loss-=o.netR}
  if(o.outcome==='SL')stopped++;
  if(o.outcome==='TP')target++;
  if(o.outcome==='MTM')mark++;
 }
 return {episodeLeaders:rows.length,observed,unobservable:rows.length-observed,
  wins,losses,distinctUtcDays:days.size,estimatedNetR:round(total),
  meanNetR:observed?round(total/observed):null,
  proxyProfitFactor:loss>0?round(gain/loss):null,
  firstStopProxy:stopped,firstTargetProxy:target,markToMarketProxy:mark,
  missingByReason:reasons,
  // Research maturity alone never authorizes execution or a strategy promotion.
  minimumSampleMature:observed>=60&&days.size>=10,
  brokerOrderAuthority:'NONE',autoPromotionAllowed:false};
}
async function audit(db,user,from,to,now=Date.now()){
 const start=at(from),end=at(to);
 if(!/^[0-9a-f-]{36}$/i.test(user||'')||start===null||end===null||
  start<at(FIRST_PROSPECTIVE)||end<=start||end-start>48*3600000||
  end>now+60000)throw Error('INVALID_OWNER_OR_PROSPECTIVE_WINDOW');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='22000ms'");
  const scope=(await db.query(q.scope,[user])).rows[0];
  if(!scope||scope.broker!=='pepperstone-ctrader'||scope.account!=='DEMO'||
     scope.currency!=='USD')throw Error('NO_OWNER_VERIFIED_DEMO_BROKER');
  const coverage=(await db.query(q.coverage,[user,scope.id,from,to])).rows[0];
  const decisionRows=(await db.query(q.decisions,[user,scope.id,from,to])).rows;
  if(decisionRows.length>5000)throw Error('DECISION_HISTORY_TRUNCATED');
  const quoteRows=(await db.query(q.quotes,[scope.id,from,
   new Date(end+17*60000).toISOString()])).rows;
  if(quoteRows.length>40000)throw Error('BROKER_QUOTE_HISTORY_TRUNCATED');
  const fees=(await db.query(q.fees,[user,scope.id,
   new Date(start-21*86400000).toISOString(),to])).rows;
  if(fees.length>2000)throw Error('BROKER_FEE_HISTORY_TRUNCATED');
  await db.query('COMMIT');
  const groupedQuotes=new Map();
  for(const x of quoteRows){
   if(!groupedQuotes.has(x.instrument))groupedQuotes.set(x.instrument,[]);
   groupedQuotes.get(x.instrument).push(x);
  }
  const leaders=episodes(decisionRows);
  const cases=leaders.map(x=>({...x,observation:score(x,
   groupedQuotes.get(x.instrument)||[],fees,Math.min(end,now))}));
  const group=fn=>Object.fromEntries([...new Set(cases.map(fn))].sort()
    .map(k=>[k,summary(cases.filter(x=>fn(x)===k))]));
  return {artifact:ARTIFACT,mode:'READ_ONLY',
   broker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
   from,to,rawMismatchDecisions:decisionRows.length,
   observerCoverage:{
    scans:Number(coverage?.scans||0),
    fieldSeen:Number(coverage?.fieldSeen||0),
    validShadowRows:Number(coverage?.validShadowRows||0),
    state:Number(coverage?.scans||0)===0?'NO_SCANS_YET':
      Number(coverage?.fieldSeen||0)===0?'OBSERVER_NOT_PERSISTED':
      Number(coverage?.validShadowRows||0)===0?'OBSERVER_FIELD_PRESENT_BUT_NO_VALID_RECORDS':
      'FROZEN_OBSERVER_RECORDED',
    readyForOutcomeEvaluation:Number(coverage?.validShadowRows||0)>0,
   },
   validFrozenShadowDecisions:decisionRows.filter(eligibleRow).length,
   excludedInvalidShadowRecords:decisionRows.filter(x=>!eligibleRow(x)).length,
   all:summary(cases),
   prospectivelyEligible:summary(cases.filter(x=>x.shadow.eligibleForProspectiveStudy)),
   comparisonExcluded:summary(cases.filter(x=>!x.shadow.eligibleForProspectiveStudy)),
   byPairSide:group(x=>x.instrument+'/'+x.direction),
   byReason:group(x=>x.shadow.reason),
   byUtcDay:group(x=>new Date(x.evaluatedAt).toISOString().slice(0,10)),
   source:'original decision time -> first 15 subsequent completed broker M1 candles',
   limitations:[
    'All outcomes are after-cost broker M1 MIDPOINT candle proxies; not executable bid/ask prices or broker fill evidence.',
    'M1 candle stop/target ordering ambiguous in the same bar is excluded; spread widening can stop trades earlier.',
    'A missing candle, invalid time, original execution geometry or causal historical commission is never called a win.',
    'Different excluded reasons are not matched controls. 30-minute episode separation reduces but cannot remove overlap.',
    'Ten distinct UTC days and 60 independent evaluated episodes are minimum research maturity, not statistical proof.',
    'No broker orders, trade authority, lot changes, risk relaxations, model promotion or LIVE deployment.',
   ],brokerOrderAuthority:'NONE',autoPromotionAllowed:false};
 }catch(e){await db.query('ROLLBACK');throw e}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  application_name:'irexpro-reversal-continuation-prospective-readonly',
  connectionTimeoutMillis:6000,statement_timeout:22000});
 try{
  await db.connect();
  const to=process.env.IREXPRO_REVERSAL_SHADOW_END||new Date().toISOString();
  const from=process.env.IREXPRO_REVERSAL_SHADOW_START||FIRST_PROSPECTIVE;
  const r=await audit(db,process.env.VPS_FOREX_SCANNER_USER_ID,from,to);
  const out='/home/lightworld/webapps/irexpro-research/reversal-continuation-prospective/latest.json';
  fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});
  fs.writeFileSync(out,JSON.stringify(r,null,2),{mode:0o600});
  console.log('REVERSAL_CONTINUATION_PROSPECTIVE '+JSON.stringify({
   from:r.from,to:r.to,observerCoverage:r.observerCoverage,
   rawMismatchDecisions:r.rawMismatchDecisions,
   all:r.all,prospectivelyEligible:r.prospectivelyEligible,
   comparisonExcluded:r.comparisonExcluded}));
 }finally{await db.end()}
}
module.exports={ARTIFACT,FIRST_PROSPECTIVE,q,eligibleRow,episodes,summary,audit,quoteEligible};
if(require.main===module)main().catch(e=>{
 console.error('REVERSAL_CONTINUATION_PROSPECTIVE_FAILED',e.code||'',
  String(e.message||'UNKNOWN').slice(0,200));process.exitCode=1;
});
