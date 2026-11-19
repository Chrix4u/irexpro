#!/usr/bin/env node
'use strict';
/**
 * Read-only account-owner Pepperstone USD DEMO expectancy calibration.
 * Compares model Plan-B expected R frozen in broker trade intent with
 * subsequently realized broker after-commission-and-swap R divided by
 * pre-entry stop-risk. These are distinct horizons; do not equate their
 * difference with a model-prediction error without further validation.
 * No broker orders, session updates, model admission or LIVE promotion.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='irexpro-owner-demo-predicted-vs-realized-net-r-v1';
const OUTPUT='/home/lightworld/webapps/irexpro-research/model-expectancy-calibration/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
 "SELECT t.opened_at,t.closed_at,t.instrument,t.direction,t.lot_size,",
 "t.realised_pnl,t.commission,t.swap,t.close_reason,",
 "ti.metadata->>'multimodel_plan_b_route' AS route,",
 "ti.metadata->>'multimodel_plan_b_expected_r' AS expected_r,",
 "ti.metadata->>'m1_execution_cost_r' AS estimated_cost_r,",
 "ca.sizing_inputs->>'finalRiskAtStop' AS initial_risk",
 "FROM trading.trades t",
 "JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
 "AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id",
 "LEFT JOIN LATERAL (SELECT ca.sizing_inputs FROM trading.capital_allocations ca",
 "WHERE ca.user_id=t.user_id AND ca.trade_intent_id=ti.id",
 "AND ca.created_at<=t.opened_at",
 "ORDER BY ca.created_at DESC,ca.id DESC LIMIT 1) ca ON true",
 "WHERE t.user_id=$1 AND t.account_currency='USD'",
 "AND b.deleted_at IS NULL AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.account_currency='USD'",
 "AND t.status='CLOSED' AND t.closed_at>=$2::timestamptz",
 "AND t.closed_at<=$3::timestamptz",
 "ORDER BY t.closed_at ASC,t.id ASC LIMIT 501"
].join(' ');
const finite=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const rnd=(x,d=3)=>Number.isFinite(x)?+x.toFixed(d):null;
const tm=x=>{const n=new Date(x).getTime();return Number.isFinite(n)?n:null;};
function normalize(row){
 const risk=finite(row.initial_risk),
  exp=finite(row.expected_r),cost=finite(row.estimated_cost_r),
  pnl=finite(row.realised_pnl),fee=finite(row.commission),swap=finite(row.swap);
 const ready=[risk,exp,pnl,fee,swap].every(Number.isFinite)&&risk>0;
 const net=ready?pnl+fee+swap:null;
 return {
  utcDay:new Date(row.closed_at).toISOString().slice(0,10),
  route:row.route||'UNCLASSIFIED',instrument:row.instrument,
  risk:ready?risk:null,modelPlanBExpectedR:exp,
  modelExecutionCostR:cost,brokerNetR:ready?net/risk:null,
  brokerNetUsd:ready?net:null,brokerGrossUsd:pnl,
  brokerCommissionUsd:fee,brokerSwapUsd:swap,
  valid:ready,
  excludesLateCapitalAllocation:true,
 };
}
function metrics(rows){
 const valid=rows.filter(x=>x.valid);
 const total=valid.reduce((s,x)=>s+x.brokerNetUsd,0);
 const gross=valid.reduce((s,x)=>s+x.brokerGrossUsd,0);
 const cost=valid.reduce((s,x)=>s+x.brokerCommissionUsd,0);
 const swap=valid.reduce((s,x)=>s+x.brokerSwapUsd,0);
 const pos=valid.filter(x=>x.brokerNetUsd>0),
  neg=valid.filter(x=>x.brokerNetUsd<0);
 const sum=f=>valid.reduce((s,x)=>s+f(x),0);
 const wins=pos.reduce((s,x)=>s+x.brokerNetUsd,0);
 const losses=-neg.reduce((s,x)=>s+x.brokerNetUsd,0);
 const costValid=valid.filter(x=>Number.isFinite(x.modelExecutionCostR));
 return {
  settled:rows.length,completeComparable:valid.length,
  missingOrUnverifiable:rows.length-valid.length,
  wins:pos.length,losses:neg.length,
  winRate:valid.length?rnd(pos.length/valid.length,4):null,
  profitFactor:losses>0?rnd(wins/losses,4):null,
  brokerNetUsd:valid.length?rnd(total,2):null,
  brokerGrossUsd:valid.length?rnd(gross,2):null,
  commissionUsd:valid.length?rnd(cost,2):null,
  swapUsd:valid.length?rnd(swap,2):null,
  avgPlanBExpectedR:valid.length?
    rnd(sum(x=>x.modelPlanBExpectedR)/valid.length,4):null,
  avgActualBrokerNetR:valid.length?
    rnd(sum(x=>x.brokerNetR)/valid.length,4):null,
  avgExpectedMinusObservedR:valid.length?
    rnd(sum(x=>x.modelPlanBExpectedR-x.brokerNetR)/valid.length,4):null,
  avgRecordedExecutionCostR:costValid.length?
    rnd(costValid.reduce((s,x)=>s+x.modelExecutionCostR,0)/costValid.length,4):null,
  distinctUtcClosingDates:new Set(valid.map(x=>x.utcDay)).size,
  meetsDemoProfitFactorThreshold:
    valid.length>=30 && losses>0 && wins/losses>=1.15 && total>0,
  researchOnly:true,liveReady:false,
 };
}
function group(rows,fn){
 const buckets={};
 for(const r of rows){const key=String(fn(r)||'UNKNOWN');(buckets[key]??=[]).push(r);}
 return Object.fromEntries(Object.entries(buckets).map(([key,v])=>[key,metrics(v)]));
}
async function audit(db,{owner,since,through}){
 const start=tm(since),end=tm(through);
 if(!UUID.test(owner||'')||start==null||end==null||
  start>=end||end-start>7*86400000)throw Error('INVALID_OWNER_OR_WINDOW');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='30000ms'");
  const fetched=(await db.query(SQL,[owner,since,through])).rows;
  if(fetched.length>500)throw Error('OWNER_CALIBRATION_SAMPLE_TRUNCATED');
  await db.query('COMMIT');
  const records=fetched.map(normalize);
  return {
   artifact:ARTIFACT,generatedAt:new Date().toISOString(),
   since,through,broker:'pepperstone-ctrader',account:'USD DEMO',
   dataSource:'broker-settled trades + frozen intent expectedR + pre-entry capital allocation',
   researchOnly:true,brokerOrders:0,changesExecution:false,
   changesStartStop:false,changesPositionSizing:false,changesStops:false,
   autoPromote:false,
   all:metrics(records),
   byRoute:group(records,x=>x.route),
   byRouteAndUtcClosingDate:group(records,x=>x.utcDay+' '+x.route),
   byPairAndRoute:group(records,x=>x.instrument+' '+x.route),
   caveats:[
    'Model Plan-B expected R may target a different horizon and objective than realized after-cost broker trade R.',
    'A persistent positive expected-versus-negative realized return gap is evidence to investigate calibration and exits, not conclusive proof of a single model bug.',
    'Broker commissions are charged once. The separate model estimatedExecutionCostR is disclosed but never subtracted again from net broker PnL.',
    'Trades lack independent randomization and share time, instrument, broker and correlated USD exposure.',
    'A positive win rate alone cannot clear readiness; the profit factor target is 1.15 and actual settled net must be positive.',
    'No strategy pause, risk gate modification, lot cap or LIVE promotion is authorized.',
   ],
  };
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST,
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  statement_timeout:30000,connectionTimeoutMillis:8000,
  application_name:'irexpro-owner-demo-expected-vs-realized-audit'});
 try{
  await db.connect();
  const through=new Date().toISOString();
  const since=process.env.IREXPRO_MODEL_CALIBRATION_SINCE||
   '2026-11-16T00:00:00.000Z';
  const result=await audit(db,{
   owner:process.env.VPS_FOREX_SCANNER_USER_ID,since,through});
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
  fs.writeFileSync(OUTPUT,JSON.stringify(result,null,2),{mode:0o600});
  console.log('OWNER_MODEL_EXPECTANCY_CALIBRATION '+JSON.stringify({
   at:result.generatedAt,all:result.all,
   byRoute:result.byRoute,byDay:result.byRouteAndUtcClosingDate,
   account:result.account,liveReady:false,
  }));
 }finally{await db.end();}
}
module.exports={ARTIFACT,SQL,normalize,metrics,group,audit};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_MODEL_EXPECTANCY_AUDIT_FAILED',
  String(e?.message||e).slice(0,220));process.exitCode=1;
});
