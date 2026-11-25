#!/usr/bin/env node
'use strict';
/**
 * Owner Pepperstone USD DEMO native positive-stop readiness.
 * Reports shadow gate eligibility, actual published optional slDistance,
 * precision rounding, and broker-minimum proof. ZERO broker writes/orders.
 */
const fs=require('node:fs'),path=require('node:path');
const FROM='2026-11-19T00:00:00Z';
const OUT='/home/lightworld/webapps/irexpro-research/profit-protection-rollout/latest-broker-stop-readiness.json';
const SQL=[
 'SELECT a.resource_id, a.created_at, t.instrument, t.direction,',
 "COALESCE(a.metadata->>'strategyRoute','UNKNOWN') strategy_route,",
 "a.metadata->>'recommendation' recommendation,",
 "a.metadata->>'protectedRunnerPreflightReason' preflight,",
 "a.metadata->'protectedRunnerReadinessShadow'->>'eligibleForIndependentProviderValidation' ready_runner,",
 "a.metadata->'protectedRunnerReadinessShadow'->>'reason' runner_reason,",
 "a.metadata->'protectedRunnerReadinessShadow'->>'proposedStopForResearchOnly' proposed_raw,",
 "a.metadata->>'brokerRoundedShadowStop' proposed_rounded,",
 "a.metadata->>'publishedStopDistance' native_distance,",
 "a.metadata->>'publishedStopDistanceUnit' native_distance_unit,",
 "a.metadata->'protectedRunnerNativeDistanceShadow'->>'reason' stop_reason,",
 "a.metadata->'protectedRunnerNativeDistanceShadow'->>'candidateMeetsAdvertisedMinDistance' native_verified,",
 "a.metadata->'protectedRunnerNativeDistanceShadow'->>'stopHeadroomPrice' headroom,",
 "a.metadata->>'noTradeAuthority' no_trade_authority,",
 "a.metadata->>'stopAmendments' stop_amendments",
 'FROM audit.audit_logs a',
 'JOIN trading.trades t ON t.id::text=a.resource_id AND t.user_id=a.actor_user_id',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 "WHERE a.action='DEMO_POSITION_EXIT_INTELLIGENCE_SHADOW' AND a.actor_user_id=$1",
 'AND t.user_id=$1 AND b.user_id=$1 AND b.deleted_at IS NULL',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD'",
 'AND a.created_at>=$2::timestamptz',
 'ORDER BY a.created_at DESC LIMIT 3001',
].join(' ');
const number=x=>x==null||x===''?null:Number.isFinite(+x)?+x:null;
function summarize(rows,now=new Date()){
 const records=rows.map(x=>({
  at:new Date(x.created_at).toISOString(),tradeId:x.resource_id,
  instrument:x.instrument,direction:x.direction,route:x.strategy_route,
  recommendation:x.recommendation,runnerReason:x.runner_reason,
  runnerCandidate:x.ready_runner==='true',
  nativeDistanceReason:x.stop_reason,
  nativeDistanceVerified:x.native_verified==='true',
  rawStop:number(x.proposed_raw),brokerRoundedStop:number(x.proposed_rounded),
  publishedSlDistance:x.native_distance,publishedSlUnit:x.native_distance_unit,
  headroomPrice:number(x.headroom),
  noTradeAuthority:x.no_trade_authority==='true',
  brokerAmendCount:number(x.stop_amendments),
 }));
 const attempted=records.filter(x=>x.runnerCandidate);
 const tally=(xs,key)=>Object.fromEntries(
  [...new Set(xs.map(x=>x[key]??'UNKNOWN'))].sort().map(k=>
   [String(k),xs.filter(x=>(x[key]??'UNKNOWN')===k).length]));
 const unique=x=>new Set(x.map(t=>t.tradeId)).size;
 const summary={
  asOf:now.toISOString(),fromUtc:FROM,
  sampledExitIntelligenceObservations:records.length,
  sampledPositions:unique(records),
  runnerCandidates:attempted.length,
  runnerCandidatePositions:unique(attempted),
  nativeProofPassedObservations:attempted.filter(x=>x.nativeDistanceVerified).length,
  nativeProofPassedPositions:unique(attempted.filter(x=>x.nativeDistanceVerified)),
  missingNativeStopDistanceObservations:attempted.filter(x=>
   x.nativeDistanceReason==='MIN_STOP_DISTANCE_UNAVAILABLE').length,
  nativeByReason:tally(attempted,'nativeDistanceReason'),
  providerPublishedDistance:tally(attempted,'publishedSlDistance'),
  providerPublishedUnit:tally(attempted,'publishedSlUnit'),
  rawStopOffGridResolved:attempted.filter(x=>
   x.rawStop!==null && x.brokerRoundedStop!==null &&
   Math.abs(x.rawStop-x.brokerRoundedStop)>1e-8).length,
  anyBrokerAmendmentsRecorded:records.some(x=>x.brokerAmendCount!==null&&x.brokerAmendCount>0),
  brokerOrdersSentByThisAudit:0,
  brokerStopModificationsSentByThisAudit:0,
  noTradingAuthority:records.every(x=>x.noTradeAuthority),
  topRecentCandidateEvidence:attempted.slice(0,15).map(x=>({
   at:x.at,pair:x.instrument,side:x.direction,
   route:x.route,rawStop:x.rawStop,
   tickRoundedStop:x.brokerRoundedStop,
   nativeStopDistance:x.publishedSlDistance,
   nativeStopUnit:x.publishedSlUnit,
   reason:x.nativeDistanceReason,headroom:x.headroomPrice,
   nativeBrokerValidated:x.nativeDistanceVerified,
  })),
  limitations:[
   'Historical archived shadow observations, not live provider amendment acknowledgments.',
   'A provider-published zero distance is distinct from an absent optional slDistance field.',
   'Readiness does not grant authority to modify a broker position, bypass profit locks, or trade LIVE.',
   'Sampled candidate evaluation runs about once per minute per position, not at five-second execution cadence.',
   'A native minimum-distance proof does not prove an executable stop: refreshed broker quote, position identity, idempotent amendment, readback and durable stop synchronization are still required.',
  ],
 };
 return summary;
}
async function run(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!/^[a-f0-9-]{36}$/i.test(owner||''))throw Error('OWNER_NOT_CONFIGURED');
 const{Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  application_name:'irexpro-owner-demo-stop-readiness-READONLY',statement_timeout:14000});
 await db.connect();let rows;
 try{await db.query('BEGIN READ ONLY');
  rows=(await db.query(SQL,[owner,FROM])).rows;await db.query('ROLLBACK')}
 catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 if(rows.length>3000)throw Error('AUDIT_HISTORY_LIMIT_EXCEEDED');
 const summary=summarize(rows);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,JSON.stringify(summary,null,2),{mode:0o600});
 console.log('OWNER_DEMO_BROKER_STOP_READINESS '+JSON.stringify({
  at:summary.asOf,observations:summary.sampledExitIntelligenceObservations,
  uniqueCandidates:summary.runnerCandidatePositions,pass:summary.nativeProofPassedPositions,
  reasons:summary.nativeByReason,noBrokerOrders:true,
 }));
 return summary;
}
module.exports={SQL,FROM,OUT,summarize,run};
if(require.main===module)run().catch(e=>{
 console.error('OWNER_DEMO_BROKER_STOP_READINESS_FAILED',String(e.message).slice(0,160));process.exitCode=1
});
