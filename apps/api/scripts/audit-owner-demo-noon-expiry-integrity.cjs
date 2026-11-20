#!/usr/bin/env node
'use strict';
// Strictly read-only owner Pepperstone USD DEMO expiry integrity check.
// Never enables/disables trading or sends broker orders.
const fs=require('node:fs'),path=require('node:path');
const {ARTIFACT,END}=require('./audit-owner-pepperstone-demo-noon-lot-trial.cjs');
const START='2026-11-20T11:45:00.000Z';
const OUT='/home/lightworld/webapps/irexpro-research/owner-noon-lot-trial/latest-expiry-integrity.json';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const QUERY=[
 'SELECT ti.created_at,ti.instrument,ti.direction,ti.requested_lot_size,',
 "ti.metadata->>'m1_owner_demo_noon_lot_trial_artifact' trial_artifact,",
 "ti.metadata->>'multimodel_plan_b_route' strategy_route,",
 't.opened_at,t.lot_size filled_lots,t.status trade_status',
 'FROM trading.trade_intents ti',
 'JOIN broker.broker_connections b ON b.id=ti.broker_connection_id AND b.user_id=ti.user_id',
 'LEFT JOIN trading.trades t ON t.trade_intent_id=ti.id AND t.user_id=ti.user_id',
 'WHERE ti.user_id=$1 AND ti.broker_connection_id=$2 AND b.user_id=$1',
 'AND b.broker_id=$3 AND b.account_type=$4 AND b.account_currency=$5',
 'AND b.deleted_at IS NULL',
 'AND (ti.created_at>=$6::timestamptz OR t.opened_at>=$6::timestamptz)',
 'AND ti.created_at<=$7::timestamptz',
 'ORDER BY ti.created_at,t.opened_at LIMIT 301',
].join(' ');
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?NaN:Date.parse(x);
function summarize(rows,asOf=new Date()){
 const end=ms(END),now=asOf.getTime();
 if(!Number.isFinite(now)||now<ms(START))throw Error('INVALID_AUDIT_CLOCK');
 if(rows.length>300)throw Error('EXCESS_ROWS_REVIEW_REQUIRED');
 const r={artifact:'irexpro-owner-demo-noon-expiry-integrity-readonly-v1',
  asOf:asOf.toISOString(),expiresAtUtc:END,scope:'EXACT_OWNER_PEPPERSTONE_USD_DEMO',
  phase:now>=end?'EXPIRED_BY_SERVER_CLOCK':'ACTIVE',
  rowsExamined:rows.length,beforeNoonIntents:0,afterNoonIntents:0,
  afterNoonExpiredTrialArtifacts:0,afterNoonRequestedAboveFour:0,
  afterNoonFills:0,afterNoonFilledAboveFour:0,preNoonIntentLateFills:0,
  postNoonRequestedOverFour:[],postNoonFilledOverFour:[],postNoonExpiredTrialArtifactExamples:[],
  expiresAutomaticallyInCode:true,brokerDispatchVerified:false,
  noOrders:true,noSqlWrites:true,readOnly:true,
  limitations:['Time-scoped historical intent and fill records, not a broker-side order audit.',
   'Orders with intents created before noon and filled afterward are counted separately.',
   'The audit never treats missing orders as proof of successful trading or profitable outcomes.',
   'A post-expiry lot size above 4 is a review flag, not an assertion of illegitimate execution.',
   'This does not modify the trading API, account, lot limits, strategy or risk configuration.']};
 for(const x of rows){
  const created=ms(x.created_at),opened=ms(x.opened_at);
  if(!Number.isFinite(created)||created>now)throw Error('INVALID_SOURCE_TIME');
  const afterCreated=created>=end,afterFill=Number.isFinite(opened)&&opened>=end;
  const requested=num(x.requested_lot_size),filled=num(x.filled_lots);
  const preview={createdAt:new Date(created).toISOString(),openedAt:Number.isFinite(opened)?new Date(opened).toISOString():null,
   instrument:x.instrument,route:x.strategy_route||'UNKNOWN',
   requestedLots:requested,filledLots:filled,trialArtifactPresent:x.trial_artifact===ARTIFACT};
  if(afterCreated){
   r.afterNoonIntents++;
   if(x.trial_artifact===ARTIFACT){
    r.afterNoonExpiredTrialArtifacts++;r.postNoonExpiredTrialArtifactExamples.push(preview);
   }
   if(requested!=null&&requested>4){
    r.afterNoonRequestedAboveFour++;r.postNoonRequestedOverFour.push(preview);
   }
  }else r.beforeNoonIntents++;
  if(afterFill){
   r.afterNoonFills++;
   if(!afterCreated)r.preNoonIntentLateFills++;
   if(filled!=null&&filled>4){
    r.afterNoonFilledAboveFour++;r.postNoonFilledOverFour.push(preview);
   }
  }
 }
 r.postNoonRequestedOverFour=r.postNoonRequestedOverFour.slice(0,15);
 r.postNoonFilledOverFour=r.postNoonFilledOverFour.slice(0,15);
 r.postNoonExpiredTrialArtifactExamples=r.postNoonExpiredTrialArtifactExamples.slice(0,15);
 r.requiresExpiryInvestigation=Boolean(r.afterNoonExpiredTrialArtifacts||r.afterNoonRequestedAboveFour||r.afterNoonFilledAboveFour);
 return r;
}
async function run(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID,
 conn=process.env.IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID;
 if(!UUID.test(owner||'')||!UUID.test(conn||''))throw Error('OWNER_SCOPE_UNAVAILABLE');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  database:process.env.DB_NAME,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  application_name:'irexpro-owner-noon-expiry-integrity-READONLY',
  statement_timeout:15000,connectionTimeoutMillis:6000});
 const now=new Date();
 let rows;await db.connect();
 try{await db.query('BEGIN READ ONLY');
  rows=(await db.query(QUERY,[owner,conn,'pepperstone-ctrader','DEMO','USD',START,now.toISOString()])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 const report=summarize(rows,now);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,JSON.stringify(report,null,2),{mode:0o600});
 console.log('OWNER_DEMO_NOON_EXPIRY_INTEGRITY '+JSON.stringify({
  asOf:report.asOf,phase:report.phase,afterNoonIntents:report.afterNoonIntents,
  expiredTrialIntents:report.afterNoonExpiredTrialArtifacts,
  requestedOverFour:report.afterNoonRequestedAboveFour,
  filledOverFourAfterNoon:report.afterNoonFilledAboveFour,
  needsReview:report.requiresExpiryInvestigation,noOrders:true}));
 return report;
}
module.exports={START,END,QUERY,summarize,run};
if(require.main===module)run().catch(e=>{console.error('NOON_EXPIRY_AUDIT_FAILED',String(e.message).slice(0,180));process.exitCode=1});
