#!/usr/bin/env node
'use strict';

/**
 * 2026-11-04 PRIMARY_PLAN_B authority compatibility check.
 * This preserves only the historical PRIMARY route decision, NOT
 * bootstrap, M5 fallback, high conviction rescue, broker risk or orders.
 * Read-only and account-currency separated.
 *
 * The historical primary rule below is transcribed from Git commit
 * 0ccae758:apps/api/src/modules/ai/multimodel-demo-authority.ts.
 * Contemporaneous price paths and trained model binaries are NOT replayed.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='nov04-primary-planb-legacy-authority-replay-v1';
const WINDOWS=Object.freeze([
 {key:'nov04_ctrader_eur',from:'2026-11-04T00:00:00Z',to:'2026-11-05T00:00:00Z',legacy:true},
 {key:'nov10_pepperstone_usd',from:'2026-11-10T00:00:00Z',to:'2026-11-11T00:00:00Z',legacy:false},
 {key:'nov11_pepperstone_usd',from:'2026-11-11T00:00:00Z',to:'2026-11-12T00:00:00Z',legacy:false},
 {key:'nov12_pepperstone_usd',from:'2026-11-12T00:00:00Z',to:'2026-11-13T00:00:00Z',legacy:false},
 {key:'nov13_partial_pepperstone_usd',from:'2026-11-13T00:00:00Z',to:'2026-11-14T00:00:00Z',legacy:false},
]);
const MAX_ROWS=4000;
const QUERY=`
SELECT d.evaluated_at,d.instrument,d.direction,d.route,d.execution_authority,d.blockers,
d.governance->'multimodelEnsemble' AS ensemble,
d.governance->'multimodelGovernance' AS strategy_governance,
d.governance->'multimodelTrainedExpert' AS expert,
d.governance->'multimodelAuthority' AS current_authority,
d.governance->'demoProfitabilityReliabilityGate' AS profitability_gate,
d.governance->'demoPrimaryOnlyProbation' AS route_probation,
d.governance->'multimodelLossStreakBrake' AS loss_brake,
d.governance->'portfolioNetLossBrake' AS portfolio_brake
FROM trading.m1_tactical_decisions d
WHERE d.user_id=$1 AND d.broker_connection_id=$2
 AND d.evaluated_at >= $3::timestamptz AND d.evaluated_at < $4::timestamptz
 AND (
 d.governance#>>'{multimodelEnsemble,paperAdmitted}'='true'
 OR d.governance#>>'{multimodelAuthority,authorityPath}'='PRIMARY_PLAN_B'
 )
ORDER BY d.evaluated_at,d.id
LIMIT $5::int
`;
function nov04PrimaryAuthority(row) {
 const e=row.ensemble,g=row.strategy_governance,x=row.expert;
 if(!e||!g||!x||!['BUY','SELL'].includes(row.direction)||
  !['TREND_CONTINUATION','CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(e.strategyRoute)||
  !['M1_TREND_CONTINUATION','M1_CONFIRMED_REVERSAL','M1_EARLY_TRANSITION','ABSTAIN'].includes(row.route))
  return {valid:false,eligible:false,reason:'INCOMPLETE_REPLAY_EVIDENCE'};
 if(e.paperAdmitted!==true)return {valid:true,eligible:false,reason:'PLAN_B_NOT_ADMITTED'};
 if(g.paperExecutionEligible!==true)return {
  valid:true,eligible:false,reason:'GOVERNANCE_REJECTED',
 };
 if(e.strategyRoute==='TREND_CONTINUATION')
  return {valid:true,eligible:row.route==='M1_TREND_CONTINUATION',
   reason:row.route==='M1_TREND_CONTINUATION'?'LEGACY_PRIMARY':'M1_TIMING_MISMATCH'};
 if(e.strategyRoute==='EARLY_TRANSITION')
  return {valid:true,eligible:row.route==='M1_EARLY_TRANSITION',
   reason:row.route==='M1_EARLY_TRANSITION'?'LEGACY_PRIMARY':'M1_TIMING_MISMATCH'};
 if(row.route==='M1_CONFIRMED_REVERSAL')
  return {valid:true,eligible:true,reason:'LEGACY_PRIMARY'};
 if(row.route!=='M1_EARLY_TRANSITION')
  return {valid:true,eligible:false,reason:'REVERSAL_M1_NOT_CONFIRMED'};
 const longVotes=x.longVotes??0,shortVotes=x.shortVotes??0,total=longVotes+shortVotes;
 const sameVotes=row.direction==='BUY'?longVotes:shortVotes;
 const aligned=x.allBrokerNative===true&&x.direction===row.direction&&
  total>=3&&sameVotes===total&&
  Number.isFinite(x.ensembleConfidence)&&x.ensembleConfidence>=0.7;
 return {valid:true,eligible:aligned,
  reason:aligned?'LEGACY_PRIMARY_REVERSAL_EARLY_EXPERT_BRIDGE':'REVERSAL_EARLY_EXPERT_NOT_CONFIRMED'};
}
function compareWindow(rows,scope){
 let admitted=0,government=0,oldPrimary=0,currentPrimary=0,actualApproved=0,
 oldOnly=0,currentOnly=0,bothPrimary=0,primaryDownstreamBlocked=0,missing=0;
 const blockerCounts={},oldReasons={},byPairSideRoute={},oldOnlyExamples=[];
 for(const row of rows){
  const old=nov04PrimaryAuthority(row),current=row.current_authority||{};
  if(!old.valid){missing++;continue;}
  if(row.ensemble.paperAdmitted===true)admitted++;
  if(row.ensemble.paperAdmitted===true&&row.strategy_governance.paperExecutionEligible===true)government++;
  const currentExecutable=current.authorityPath==='PRIMARY_PLAN_B';
  if(old.eligible)oldPrimary++;
  if(currentExecutable)currentPrimary++;
  if(old.eligible&&currentExecutable)bothPrimary++;
  if(old.eligible&&!currentExecutable){
   oldOnly++;
   if(oldOnlyExamples.length<4)oldOnlyExamples.push({
     evaluatedAt:row.evaluated_at,instrument:row.instrument,direction:row.direction,
     route:row.route,strategyRoute:row.ensemble.strategyRoute,
     currentBlockers:current.blockers,
   });
  }
  if(!old.eligible&&currentExecutable)currentOnly++;
  if(row.execution_authority==='BROKER_NATIVE')actualApproved++;
  if(currentExecutable&&row.execution_authority!=='BROKER_NATIVE'){
   primaryDownstreamBlocked++;
   const blocks=Array.isArray(row.blockers)?row.blockers:['UNKNOWN_BLOCKER'];
   for(const b of blocks)blockerCounts[b]=(blockerCounts[b]||0)+1;
  }
  oldReasons[old.reason]=(oldReasons[old.reason]||0)+1;
  const key=[row.instrument,row.direction,row.ensemble.strategyRoute].join('/');
  const g=byPairSideRoute[key]??={paperAdmitted:0,oldPrimary:0,currentPrimary:0,brokerAuthorized:0};
  g.paperAdmitted++;if(old.eligible)g.oldPrimary++;
  if(currentExecutable)g.currentPrimary++;
  if(row.execution_authority==='BROKER_NATIVE')g.brokerAuthorized++;
 }
 return {
  broker:scope.broker,currency:scope.currency,interval:scope.interval,
  comparedPaperAdmittedOrPrimary:rows.length,missingReplayInputs:missing,
  admitted,governanceAdmitted:government,
  oldPrimary,currentPrimary,agreementOnPrimary:bothPrimary,
  oldOnly,currentOnly,oldOnlyExamples,
  actualApproved,primaryDownstreamBlocked,
  downstreamPrimaryBlockers:Object.fromEntries(Object.entries(blockerCounts).sort((a,b)=>b[1]-a[1])),
  oldReasons:Object.fromEntries(Object.entries(oldReasons).sort((a,b)=>b[1]-a[1])),
  byPairSideRoute:Object.fromEntries(Object.entries(byPairSideRoute).sort(([a],[b])=>a.localeCompare(b))),
 };
}
async function run(db,userId){
 if(!/^[0-9a-f-]{36}$/i.test(userId||''))throw Error('OWNER_NOT_VERIFIED');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='18000ms'");
  const legacy=(await db.query(`SELECT t.broker_connection_id::text id
    FROM trading.trades t JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id
    WHERE t.user_id=$1 AND t.created_at>='2026-11-04T00:00:00Z' AND t.created_at<'2026-11-05T00:00:00Z'
     AND b.broker_id='ctrader' AND b.account_type='DEMO' AND t.account_currency='EUR'
    ORDER BY t.created_at LIMIT 1`,[userId])).rows[0];
  const recent=(await db.query(`SELECT s.broker_connection_id::text id
   FROM trading.trading_sessions s JOIN broker.broker_connections b
    ON b.id=s.broker_connection_id AND b.user_id=s.user_id
   WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
    AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
    AND b.status='CONNECTED' AND b.authorization_status='ACTIVE'
   ORDER BY s.started_at DESC LIMIT 1`,[userId])).rows[0];
  if(!legacy?.id||!recent?.id||legacy.id===recent.id)throw Error('TWO_DISTINCT_OWNER_BOUND_DEMO_ACCOUNTS_REQUIRED');
  const periods={};
  for(const w of WINDOWS){
   const id=w.legacy?legacy.id:recent.id;
   const q=await db.query(QUERY,[userId,id,w.from,w.to,MAX_ROWS+1]);
   if(q.rows.length>MAX_ROWS)throw Error('TRUNCATED_DECISION_WINDOW_'+w.key);
   periods[w.key]=compareWindow(q.rows,{
    broker:w.legacy?'ctrader':'pepperstone-ctrader',currency:w.legacy?'EUR':'USD',
    interval:[w.from,w.to],
   });
  }
  await db.query('COMMIT');
  return {
   artifact:ARTIFACT,mode:'READ_ONLY_NO_BROKER_AUTHORITY',
   referenceCommit:'0ccae758',referenceTimestamp:'2026-11-04T08:26:04Z',
   altersRisk:false,altersOrders:false,restartsAi:false,
   caution:'Replays ONLY historical primary authority on current stored model/quote decisions. Not a price-path replay, completed-order simulation, or permission to trade.',
   periods,
  };
 }catch(e){await db.query('ROLLBACK');throw e}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  statement_timeout:18000,connectionTimeoutMillis:5000,
  application_name:'irexpro-nov04-primary-authority-readonly'});
 try{
  await db.connect();
  const r=await run(db,process.env.VPS_FOREX_SCANNER_USER_ID);
  const file='/home/lightworld/webapps/irexpro-research/nov04-legacy-primary-authority/latest.json';
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file,JSON.stringify(r,null,2),{mode:0o600});
  console.log('NOV04_LEGACY_PRIMARY_REPLAY '+JSON.stringify(r));
 }finally{await db.end()}
}
module.exports={ARTIFACT,WINDOWS,QUERY,nov04PrimaryAuthority,compareWindow,run};
if(require.main===module)main().catch(e=>{
 console.error('NOV04_LEGACY_PRIMARY_REPLAY_FAILED',e.code||'',
  String(e.message||'unknown').slice(0,250));process.exitCode=1;
});
