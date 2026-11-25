#!/usr/bin/env node
'use strict';
/**
 * Owner Pepperstone cTrader USD DEMO — read-only, as-of five-minute
 * checkpoint economics. No broker fills inferred, no trading authority.
 *
 * Important: NO_ACTION and CLOSE_DEMO have different selection thresholds,
 * so they are NOT interchangeable randomized cohorts. Historic CLOSE_DEMO
 * score timestamps were persisted post-dispatch: do not treat them as verified
 * as-of features. Distinguish broker-confirmed guard exits from generic actions.
 */
const fs=require('node:fs'),path=require('node:path');
const ROOT='/home/lightworld/webapps/irexpro-research';
const OUT=ROOT+'/drawdown-guard-postexit/latest-five-minute-checkpoint-economics.json';
const FROM='2026-11-17T00:00:00Z';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
'SELECT t.id::text trade_key,t.instrument,t.direction,t.opened_at,t.closed_at,',
't.status,t.close_reason,t.fill_price,t.exit_price,t.stop_loss,t.take_profit,t.lot_size,',
't.realised_pnl,t.commission,t.swap,',
"ti.metadata->>'multimodel_plan_b_route' route,",
'o.action,o.state,o.reason,o.checkpoint_at,o.evaluated_at,o.created_at,',
'o.current_r,o.probability,o.market_data_sources,o.response,',
'EXISTS (SELECT 1 FROM audit.audit_logs a',
" WHERE a.actor_user_id=t.user_id AND a.resource_type='Trade'",
" AND a.resource_id=t.id::text AND a.action='TRADE_CLOSE_REQUESTED'",
" AND a.metadata->>'closeReason'='AI_CLOSE_SIGNAL'",
" AND a.metadata->'aiCloseTrigger'->>'source'='DEMO_DRAWDOWN_GUARD'",
' AND a.created_at>=t.opened_at',
" AND a.created_at<=t.closed_at+interval '2 minutes') AS verified_guard_close",
'FROM trading.post_entry_shadow_observations o',
'JOIN trading.trades t ON t.id=o.trade_id AND t.user_id=o.user_id',
'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
'WHERE o.user_id=$1 AND t.user_id=$1',
" AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
" AND b.account_currency='USD' AND t.account_currency='USD' AND b.deleted_at IS NULL",
" AND o.artifact='plan-b-v89-demo-5m-drawdown-guard-v1'",
" AND o.checkpoint_minutes=5 AND o.checkpoint_at>=$2::timestamptz",
'ORDER BY o.checkpoint_at ASC LIMIT 601'
].join(' ');
function num(x){if(x==null||x==='')return null;const n=Number(x);return Number.isFinite(n)?n:null}
function ms(x){return x==null?NaN:new Date(x).getTime()}
const round=(x,n=2)=>Number(x.toFixed(n));
function windowStart(now=Date.now()){
 const midnight=Math.floor(now/86400000)*86400000;
 return new Date(Math.max(Date.parse(FROM),midnight-6*86400000)).toISOString();
}
const buckets=[
 {name:'BELOW_-0.30R',min:-Infinity,max:-.3},
 {name:'-0.30_TO_0R',min:-.3,max:0},
 {name:'0_TO_+0.15R',min:0,max:.15},
 {name:'+0.15_TO_+0.40R',min:.15,max:.4},
 {name:'ABOVE_+0.40R',min:.4,max:Infinity}
];
function bucket(r){
 if(!Number.isFinite(r))return 'MISSING_VERIFIED_ASOF_R';
 return buckets.find(x=>r>=x.min&&r<x.max)?.name||'MISSING_VERIFIED_ASOF_R';
}
function brokerClosePriceProximity(row){
 if(row.close_reason!=='BROKER_CLOSE')return 'NOT_BROKER_CLOSE';
 const price=num(row.exit_price),stop=num(row.stop_loss),target=num(row.take_profit);
 if([price,stop,target].some(n=>n===null||n<=0))return 'CLOSE_PRICE_UNVERIFIED';
 const pip=String(row.instrument).endsWith('JPY')?.01:.0001;
 // This is only PRICE PROXIMITY, never evidence of the broker's actual
 // close trigger, stop fill, or whether there was an SL modification.
 if(Math.abs(price-stop)/pip<=2)return 'EXIT_WITHIN_2P_OF_RECORDED_SL';
 if(Math.abs(price-target)/pip<=2)return 'EXIT_WITHIN_2P_OF_RECORDED_TP';
 return 'EXIT_NOT_NEAR_RECORDED_BARRIERS';
}
function classify(row){
 const opened=ms(row.opened_at),checkpoint=ms(row.checkpoint_at),evaluated=ms(row.evaluated_at),
  persisted=ms(row.created_at),closed=ms(row.closed_at);
 const validTime=Number.isFinite(opened)&&Number.isFinite(checkpoint)&&
  Math.abs(checkpoint-(opened+5*60000))<=1500;
 const total=num(row.realised_pnl),fee=num(row.commission),swap=num(row.swap);
 const settled=row.status==='CLOSED'&&Number.isFinite(closed)&&closed>opened&&
  [total,fee,swap].every(x=>x!==null);
 const observationAsOf=validTime&&Number.isFinite(evaluated)&&
  Number.isFinite(persisted)&&evaluated>=opened&&persisted>=opened&&
  (!settled||(evaluated<=closed&&persisted<=closed));
 const route=String(row.route||'UNVERIFIED');
 const instrument=String(row.instrument||'UNVERIFIED').toUpperCase();
 const direction=String(row.direction||'UNVERIFIED');
 const base={route,instrument,direction,
  observationAsOf,status:row.status||'UNVERIFIED',
  closeReason:row.close_reason||null,settled,
  brokerClosePriceProximity:brokerClosePriceProximity(row),
  netUsd:settled?round(total+fee+swap):null,
  checkpointDayUtc:Number.isFinite(checkpoint)?new Date(checkpoint).toISOString().slice(0,10):'UNKNOWN',
  snapshotValidity:validTime?'VALID_FIVE_MINUTE_CHECKPOINT':'INVALID_CHECKPOINT_TIMESTAMP',
  entryPrice:num(row.fill_price),stopLoss:num(row.stop_loss),
  lotSize:num(row.lot_size)};
 if(row.action==='OBSERVE'&&row.state==='NO_ACTION'){
  const r=num(row.current_r),p=num(row.probability);
  // Durable observation must exist BEFORE the settled trade exit.
  const scoreSafe=observationAsOf&&r!==null&&p!==null&&p>=0&&p<=1&&
    row.response?.source_state==='READY';
  return {...base,cohort:'GUARD_CONTINUED',scoreVerified:scoreSafe,
   checkpointR:scoreSafe?r:null,checkpointBucket:scoreSafe?bucket(r):'UNVERIFIED',
   modelProbability:scoreSafe?p:null};
 }
 if(row.action==='CLOSE_DEMO'){
  const independentlyVerified=Boolean(row.verified_guard_close)&&
   settled&&row.close_reason==='AI_CLOSE_SIGNAL';
  return {...base,cohort:independentlyVerified?'CONFIRMED_GUARD_EXIT':'UNVERIFIED_GUARD_CLOSE_ACTION',
   scoreVerified:false,checkpointR:null,checkpointBucket:'NOT_HISTORICALLY_ASOF_VERIFIED',
   modelProbability:null};
 }
 return {...base,cohort:row.state==='WAITING_FOR_BROKER_DATA'?'NO_BROKER_CHECKPOINT':'OTHER_OBSERVATION',
  scoreVerified:false,checkpointR:null,checkpointBucket:'UNVERIFIED',
  modelProbability:null};
}
function empty(){
 return {observations:0,settled:0,open:0,winners:0,losers:0,flats:0,
  totalNetUsd:0,grossWinningsUsd:0,grossLossesUsd:0,meanWinUsd:null,
  meanLossUsd:null,profitFactor:null,winRate:null,
  averageNetPerSettledTradeUsd:null,maxObservedLossUsd:null,
  observedBeforeClose:0,verifiedFiveMinuteScores:0};
}
function group(records,pick){
 const groups={};
 for(const r of records){
  const key=pick(r);
  const v=groups[key]??=empty();
  v.observations++;
  v.open+=r.status==='OPEN';
  v.observedBeforeClose+=r.observationAsOf;
  v.verifiedFiveMinuteScores+=r.scoreVerified;
  if(!r.settled||r.netUsd===null)continue;
  v.settled++;v.totalNetUsd+=r.netUsd;
  if(r.netUsd>0){v.winners++;v.grossWinningsUsd+=r.netUsd}
  else if(r.netUsd<0){v.losers++;v.grossLossesUsd+=r.netUsd}
  else v.flats++;
  if(r.netUsd<0){
   v.maxObservedLossUsd=v.maxObservedLossUsd===null?r.netUsd:Math.min(v.maxObservedLossUsd,r.netUsd);
  }
 }
 for(const v of Object.values(groups)){
  v.totalNetUsd=round(v.totalNetUsd);v.grossWinningsUsd=round(v.grossWinningsUsd);
  v.grossLossesUsd=round(v.grossLossesUsd);
  v.winRate=v.settled?round(v.winners/v.settled,4):null;
  v.meanWinUsd=v.winners?round(v.grossWinningsUsd/v.winners):null;
  v.meanLossUsd=v.losers?round(v.grossLossesUsd/v.losers):null;
  v.profitFactor=v.grossLossesUsd<0?round(v.grossWinningsUsd/(-v.grossLossesUsd),4):null;
  v.averageNetPerSettledTradeUsd=v.settled?round(v.totalNetUsd/v.settled):null;
 }
 return groups;
}
function summarize(rows,fromUtc=windowStart()){
 const records=rows.map(classify);
 const continued=records.filter(r=>r.cohort==='GUARD_CONTINUED'&&r.scoreVerified);
 const confirmed=records.filter(r=>r.cohort==='CONFIRMED_GUARD_EXIT');
 const paired={
  checkpointRnotEntryFeature:true,
  trainedClassifier:false,guardThresholdChanged:false,executionAuthority:'NONE',
  pairedComparisonIsNotCausal:true,
  continueVsExitNotRandomized:true,
  asOfGuardExitScoreExcludedUnlessPreCloseVerified:true
 };
 const noActionByBinRoute=group(continued,r=>r.checkpointBucket+'|'+r.route);
 const noActionByBinInstrument=group(continued,r=>r.checkpointBucket+'|'+r.instrument);
 const result={
  artifact:'irexpro-owner-five-minute-checkpoint-economics-v1',
  asOf:new Date().toISOString(),fromUtc,rollingDays:7,
  ownerScoped:true,broker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
  researchOnly:true,noSqlWrites:true,tradeAuthority:'NONE',
  cohortAccounting:{
   totalCheckpointObservations:records.length,
   allCohorts:group(records,r=>r.cohort),
   verifiedContinuations:continued.length,
   independentlyVerifiedGuardCloses:confirmed.length,
   unverifiedNoActionScores:records.filter(r=>r.cohort==='GUARD_CONTINUED'&&!r.scoreVerified).length
  },
  continued:{byRoute:group(continued,r=>r.route),
   byInstrument:group(continued,r=>r.instrument),
   byRiskBucket:group(continued,r=>r.checkpointBucket),
   byRiskBucketAndRoute:noActionByBinRoute,
   byRiskBucketAndInstrument:noActionByBinInstrument,
   byCheckpointDay:group(continued,r=>r.checkpointDayUtc),
   byDayAndRoute:group(continued,r=>r.checkpointDayUtc+'|'+r.route),
   byRouteAndDirection:group(continued,r=>r.route+'|'+r.direction),
   byOriginalCloseReason:group(continued,r=>r.closeReason||'OPEN'),
   brokerClosePriceProximity:group(continued.filter(r=>r.closeReason==='BROKER_CLOSE'),
    r=>r.brokerClosePriceProximity),
   brokerClosePriceProximityByRoute:group(continued.filter(r=>r.closeReason==='BROKER_CLOSE'),
    r=>r.route+'|'+r.brokerClosePriceProximity)},
  confirmedGuardCloses:{byRoute:group(confirmed,r=>r.route),
   byInstrument:group(confirmed,r=>r.instrument),
   byCheckpointDay:group(confirmed,r=>r.checkpointDayUtc)},
  safety:paired,
  limitations:[
   'Checkpoint R is POST-entry and cannot be used as a feature at the original entry without look-ahead.',
   'NO_ACTION and CLOSE_DEMO are selected by different five-minute states; outcome differences are associative, not causal policy uplift.',
   'Historical CLOSE_DEMO five-minute score timestamps persisted after the broker-close request and are deliberately excluded from time-safe score cohorts.',
   'A score-safe NO_ACTION record is recorded before the trade closes, but final broker net economics are available only AFTER settlement.',
   'Full original stop-loss continuation simulation requires complete tick path, broker stop precedence and after-cost fill reconstruction; no avoided-loss dollars are imputed.',
   'Samples are clustered by market day, instrument and correlated USD exposure, and the limited period cannot establish reliable walk-forward profitability.',
   'Monitoring makes no trading decisions, does not change exits or stops, and is not LIVE eligible.'
  ]
 };
 return result;
}
async function runCheckpointEconomics(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!uuid.test(owner||''))throw Error('OWNER_SCOPE_UNAVAILABLE');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  statement_timeout:18000,application_name:'irexpro-five-minute-economics-READONLY'});
 const fromUtc=windowStart();let rows;
 await db.connect();
 try{
  await db.query('BEGIN READ ONLY');
  rows=(await db.query(SQL,[owner,fromUtc])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{await db.end()}
 if(rows.length>600)throw Error('CHECKPOINT_OBSERVATION_LIMIT');
 const result=summarize(rows,fromUtc);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 const payload=JSON.stringify(result,null,2);
 fs.writeFileSync(OUT,payload,{mode:0o600});
 const archive=path.join(path.dirname(OUT),'daily',
  result.asOf.slice(0,10)+'-five-minute-checkpoint-economics.json');
 fs.writeFileSync(archive,payload,{mode:0o600});
 console.log('GUARD_CHECKPOINT_ECONOMICS '+JSON.stringify({
  asOf:result.asOf,observations:result.cohortAccounting.totalCheckpointObservations,
  confirmedCloses:result.cohortAccounting.independentlyVerifiedGuardCloses,
  continued:result.cohortAccounting.verifiedContinuations,
  continuedNet:result.cohortAccounting.allCohorts.GUARD_CONTINUED?.totalNetUsd,
  researchOnly:true,trading:false
 }));
 return result;
}
module.exports={SQL,windowStart,bucket,classify,group,summarize,runCheckpointEconomics};
if(require.main===module)runCheckpointEconomics().catch(e=>{
 console.error('FIVE_MINUTE_ECONOMICS_AUDIT_ERROR',String(e.message).slice(0,200));process.exitCode=1});
