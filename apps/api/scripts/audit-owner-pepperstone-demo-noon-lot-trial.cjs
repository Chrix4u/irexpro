#!/usr/bin/env node
'use strict';
/**
 * Exact owner/connection Pepperstone USD DEMO — strictly READ ONLY snapshot
 * of the explicit short-lived 4+ lot request trial. This is never a trade
 * control, a forecast or an estimate of unrealized broker equity.
 */
const path=require('node:path'),fs=require('node:fs');
const ARTIFACT='owner-pepperstone-demo-four-plus-until-20261120t1200z-v1';
const BEGIN='2026-11-20T03:57:00.000Z';
const END='2026-11-20T12:00:00.000Z';
const OUT='/home/lightworld/webapps/irexpro-research/owner-noon-lot-trial/latest-report.json';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const QUERY=[
 'SELECT ti.id::text AS intent_id,ti.created_at,ti.instrument,ti.direction,',
 'ti.requested_lot_size,',
 "ti.metadata->>'m1_pepperstone_demo_pre_screen_lot_cap' requested_screen_cap,",
 "ti.metadata->>'m1_owner_demo_noon_lot_trial_expires_at' trial_expires_at,",
 "ti.metadata->>'m1_pepperstone_demo_max_risk_percent' pre_screen_risk_percent,",
 "ti.metadata->>'multimodel_plan_b_route' strategy_route,",
 't.id::text AS trade_id,t.opened_at,t.closed_at,t.status AS trade_status,',
 't.lot_size AS filled_lots,t.realised_pnl,t.commission,t.swap,t.close_reason,',
 "ca.sizing_inputs->>'finalRiskAtStop' AS risk_at_stop,",
 "ca.sizing_inputs->>'riskPercent' AS actual_risk_percent",
 'FROM trading.trade_intents ti',
 'JOIN broker.broker_connections b ON b.id=ti.broker_connection_id AND b.user_id=ti.user_id',
 'LEFT JOIN trading.trades t ON t.trade_intent_id=ti.id AND t.user_id=ti.user_id',
 'LEFT JOIN LATERAL(SELECT a.sizing_inputs FROM trading.capital_allocations a',
 ' WHERE a.trade_intent_id=ti.id AND a.user_id=ti.user_id AND a.created_at<=now()',
 ' ORDER BY a.created_at DESC LIMIT 1) ca ON TRUE',
 'WHERE ti.user_id=$1 AND b.user_id=$1 AND ti.broker_connection_id=$2',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND ti.metadata->>'m1_owner_demo_noon_lot_trial_artifact'=$3",
 'AND ti.created_at>=$4::timestamptz AND ti.created_at<$5::timestamptz',
 'ORDER BY ti.created_at,ti.id LIMIT 201',
].join(' ');
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const rnd=x=>Number(x.toFixed(2));
function summarize(rows,now=new Date()){
 const current=now.getTime(),start=Date.parse(BEGIN),end=Date.parse(END);
 if(!Number.isFinite(current))throw Error('INVALID_CLOCK');
 const report={
  artifact:'irexpro-owner-pepperstone-demo-noon-lot-actual-fill-report-v1',
  asOf:now.toISOString(),from:BEGIN,untilExclusive:END,
  phase:current<start?'NOT_STARTED':current<end?'ACTIVE':'EXPIRED_AUTOMATICALLY',
  broker:'pepperstone-ctrader',account:'USD DEMO',ownerOnly:true,
  trialRequestCapLots:6,trialPreScreenStopRiskPercent:.75,
  noLiveTradingAuthority:true,modifiesOrders:false,readOnly:true,
  observations:rows.length,signals:0,filled:0,
  filledFourLotsOrMore:0,filledBelowFourLots:0,
  requestedFourLotsOrMore:0,requestedBelowFourLots:0,
  unfilled:0,unreconciled:0,stillOpen:0,
  settled:0,settledWins:0,settledLosses:0,settledFlat:0,
  brokerNetUsdSettled:0,commissionUsdSettled:0,actualLotTotal:0,
  highestFilledLots:null,highestRequestedLots:null,
  byStrategy:{},byInstrument:{},
  latest:[],
  notes:[
   'Only independently matched broker trades are considered filled; requested lots are not executions.',
   'Gross, commission and swap are joined only after full CLOSED broker settlement; open P&L is not guessed.',
   'Lot changes do not prove improved strategy expectancy; bigger size amplifies both winning and losing trades.',
   'The trial is time-scoped in real API sizing + final dispatch, and this read-only monitor does not switch or close any positions.',
   'Open positions created during the trial can remain open after the request-window ends; expiration controls NEW high-lot requests.',
  ]
 };
 for(const r of rows){
  const opened=new Date(r.created_at).getTime();
  if(!Number.isFinite(opened)||opened<start||opened>=end)throw Error('OUTSIDE_TRIAL_WINDOW');
  const ask=num(r.requested_lot_size),lot=num(r.filled_lots),state=r.trade_status;
  const hasFilled=!!r.trade_id&&lot!==null&&lot>0&&r.opened_at!=null;
  const netParts=[num(r.realised_pnl),num(r.commission),num(r.swap)];
  const settled=hasFilled&&state==='CLOSED'&&r.closed_at!=null&&netParts.every(x=>x!==null);
  const net=settled?rnd(netParts.reduce((s,v)=>s+v,0)):null;
  const record={
   at:new Date(opened).toISOString(),symbol:r.instrument,direction:r.direction,
   route:r.strategy_route||'UNKNOWN',requestedLots:ask,filledLots:hasFilled?lot:null,
   closedNetUsd:net,status:hasFilled?(state||'UNKNOWN'):'NOT_FILLED',
   stopRiskAtEntryUsd:hasFilled?num(r.risk_at_stop):null,
   prescreenRiskPct:num(r.pre_screen_risk_percent),
  };
  report.signals++;
  if(ask!==null){
   report.highestRequestedLots=Math.max(report.highestRequestedLots||0,ask);
   if(ask>=4)report.requestedFourLotsOrMore++;else report.requestedBelowFourLots++;
  }
  if(hasFilled){
   report.filled++;report.actualLotTotal+=lot;
   report.highestFilledLots=Math.max(report.highestFilledLots||0,lot);
   if(lot>=4)report.filledFourLotsOrMore++;else report.filledBelowFourLots++;
   if(state==='OPEN')report.stillOpen++;
   if(state==='RECONCILIATION_PENDING')report.unreconciled++;
  }else report.unfilled++;
  if(settled){
   report.settled++;
   report.brokerNetUsdSettled+=net;
   report.commissionUsdSettled+=netParts[1];
   if(net>0)report.settledWins++;
   else if(net<0)report.settledLosses++;
   else report.settledFlat++;
  }
  const add=(target,key)=>{
   const group=target[key]??={signals:0,filled:0,fourPlusActual:0,settled:0,netUsd:0};
   group.signals++;group.filled+=hasFilled;group.fourPlusActual+=hasFilled&&lot>=4;
   group.settled+=settled;if(settled)group.netUsd+=net;
  };
  add(report.byStrategy,String(r.strategy_route||'UNKNOWN'));
  add(report.byInstrument,String(r.instrument||'UNKNOWN'));
  report.latest.push(record);
 }
 report.actualLotTotal=rnd(report.actualLotTotal);
 report.brokerNetUsdSettled=rnd(report.brokerNetUsdSettled);
 report.commissionUsdSettled=rnd(report.commissionUsdSettled);
 report.averageActualFilledLots=report.filled?rnd(report.actualLotTotal/report.filled):null;
 for(const group of [...Object.values(report.byStrategy),...Object.values(report.byInstrument)]){
  group.netUsd=rnd(group.netUsd);
 }
 report.latest=report.latest.slice(-20).reverse();
 return report;
}
async function run(){
 require('dotenv').config({path:path.join(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID,
   conn=process.env.IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID;
 if(!UUID.test(owner||'')||!UUID.test(conn||''))throw Error('OWNER_OR_CONNECTION_SCOPE_UNAVAILABLE');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  connectionTimeoutMillis:8000,statement_timeout:15000,
  application_name:'irexpro-owner-noon-lot-demo-READONLY'});
 let rows;
 await db.connect();
 try{
  await db.query('BEGIN READ ONLY');
  rows=(await db.query(QUERY,[owner,conn,ARTIFACT,BEGIN,END])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 if(rows.length>200)throw Error('UNEXPECTED_TRIAL_INTENT_LIMIT');
 const report=summarize(rows);
 const payload=JSON.stringify(report,null,2);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,payload,{mode:0o600});
 console.log('OWNER_NOON_LOT_TRIAL_AUDIT '+JSON.stringify({
  asOf:report.asOf,phase:report.phase,signals:report.signals,
  requestedFourPlus:report.requestedFourLotsOrMore,
  brokerFilledFourPlus:report.filledFourLotsOrMore,
  actualFilled:report.filled,settled:report.settled,settledNetUsd:report.brokerNetUsdSettled,
  noOrders:true,noLiveAuthority:true,
 }));
 return report;
}
module.exports={ARTIFACT,BEGIN,END,QUERY,summarize,run};
if(require.main===module)run().catch(e=>{
 console.error('OWNER_NOON_LOT_AUDIT_FAILED',String(e.message).slice(0,200));process.exitCode=1;
});
