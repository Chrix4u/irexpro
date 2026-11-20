#!/usr/bin/env node
'use strict';

/** Exact owner / Pepperstone / USD DEMO; read-only commission routing audit. */
const fs=require('node:fs'),path=require('node:path');
const {evaluate}=require('./research-owner-demo-commission-routing-shadow.cjs');
const OUT='/home/lightworld/webapps/irexpro-research/net-economics-shadow/latest.json';
const MAX=2000;
const DAY=86400000;
function route(x){
  const s=String(x||'').toUpperCase();
  if(s==='M1_EARLY_TRANSITION')return 'EARLY_TRANSITION';
  if(s==='M1_CONFIRMED_REVERSAL')return 'CONFIRMED_REVERSAL';
  if(s==='M1_TREND_CONTINUATION')return 'TREND_CONTINUATION';
  return s;
}
function tradeRows(rows,connectionId){
 return rows.map(x=>{
   const hasFinal=x.finalRiskAtStop!==null&&x.finalRiskAtStop!==undefined&&x.finalRiskAtStop!=='';
   const rawRisk=hasFinal?x.finalRiskAtStop:x.fallbackRiskAmount;
   return {
     instrument:x.instrument,route:route(x.route),accountCurrency:x.currency,
     brokerConnectionId:connectionId,
     openedAt:x.openedAt?.toISOString()||null,closedAt:x.closedAt?.toISOString()||null,
     allocationCreatedAt:x.allocationCreatedAt?.toISOString()||null,
     initialCashRisk:rawRisk,lots:x.lots,
     grossPnl:x.grossPnl,commission:x.commission,swap:x.swap,
     preExistingExpectedNetR:x.m1ExpectedNetR,
   };
 });
}
async function runAudit(opts={}){
 require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
 const {Client}=require('pg');
 const {getDatabaseSslOptions}=require('../dist/config/database-tls');
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!owner)throw Error('EXACT_OWNER_SCOPE_REQUIRED');
 const db=new Client({
   host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
   database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
   ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),statement_timeout:25000,
   application_name:'irexpro-owner-demo-commission-routing-research-readonly',
 });
 let rows=[],connectionId=null,asOf=null;
 try{
   await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const b=await db.query(
     "SELECT id FROM broker.broker_connections "+
     "WHERE user_id=$1 AND broker_id='pepperstone-ctrader' "+
     "AND account_type='DEMO' AND account_currency='USD' AND deleted_at IS NULL "+
     "ORDER BY created_at DESC LIMIT 1",[owner]);
   if(b.rows.length!==1)throw Error('NO_OWNER_PEPPERSTONE_USD_DEMO');
   connectionId=b.rows[0].id;
   asOf=(await db.query('SELECT current_timestamp AS asof')).rows[0].asof;
   const from=new Date(asOf.getTime()-7*DAY);
   const historyFrom=new Date(from.getTime()-7*DAY);
   const result=await db.query(`
     SELECT t.instrument,t.account_currency AS currency,
       t.lot_size AS lots,t.opened_at AS "openedAt",t.closed_at AS "closedAt",
       t.realised_pnl AS "grossPnl",t.commission,t.swap,
       COALESCE(NULLIF(ti.metadata->>'multimodel_plan_b_route',''),
         NULLIF(ti.metadata->>'m1_tactical_route','')) AS route,
       NULLIF(ti.metadata->>'m1_net_expected_r','') AS "m1ExpectedNetR",
       ca.created_at AS "allocationCreatedAt",
       ca.sizing_inputs->>'finalRiskAtStop' AS "finalRiskAtStop",
       ca.sizing_inputs->>'riskAmount' AS "fallbackRiskAmount"
     FROM trading.trades t
     LEFT JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
       AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id
     LEFT JOIN LATERAL (
       SELECT created_at,sizing_inputs
       FROM trading.capital_allocations ca0
       WHERE ca0.trade_intent_id=t.trade_intent_id AND ca0.created_at<=t.opened_at
       ORDER BY ca0.created_at DESC LIMIT 1
     ) ca ON TRUE
     WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.account_currency='USD'
       AND t.status='CLOSED' AND t.closed_at IS NOT NULL
       AND t.opened_at >= $3 AND t.opened_at < $4
     ORDER BY t.opened_at,t.id LIMIT $5
   `,[owner,connectionId,historyFrom,asOf,MAX+1]);
   if(result.rows.length>MAX)throw Error('TRUNCATED_TRADE_HISTORY_REJECTED');
   rows=tradeRows(result.rows,connectionId);
   await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 const report=evaluate(rows,{
    from:new Date(asOf.getTime()-7*DAY).toISOString(),
    asOf:asOf.toISOString(),brokerConnectionId:connectionId});
 return {
   ...report,
   scope:'VERIFIED_EXACT_OWNER_PEPPERSTONE_CTRADER_USD_DEMO',
   method:'READ_ONLY_CHRONOLOGICAL_PRIOR_CLOSED_TRADE_COMMISSION_P90',
   noAutomaticVeto:true,brokerAccountIdExported:false,
 };
}
async function main(){
 const report=await runAudit();
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 const tmp=OUT+'.tmp.'+process.pid;
 fs.writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 fs.renameSync(tmp,OUT);
 console.log('OWNER_DEMO_COMMISSION_ROUTING_SHADOW '+JSON.stringify({
   asOf:report.asOf,from:report.from,closedTrades:report.sampleClosedTrades,
   excluded:report.excludedIncompleteOrUnclassifiedRecentTrades,
   total:report.total,byRoute:report.byRoute,
   underforecastCommissionCases:report.underforecastCommissionCases,
   researchOnly:true,noAutomaticVeto:true,promotionAllowed:false,
 }));
}
module.exports={OUT,MAX,route,tradeRows,runAudit};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_DEMO_COMMISSION_ROUTING_ABORTED',String(e.message).slice(0,220));
 process.exitCode=1;
});
