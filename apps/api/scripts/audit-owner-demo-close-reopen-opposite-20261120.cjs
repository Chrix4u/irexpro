#!/usr/bin/env node
'use strict';
/* Read-only owner Pepperstone cTrader USD DEMO close/reopen and opposite exposure diagnosis. */
const path=require('node:path');
const {Client}=require('pg');
const n=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?null:new Date(x).getTime();
function inspect(rows){
 const sorted=[...rows].sort((a,b)=>ms(a.opened_at)-ms(b.opened_at));
 const sequences=[],overlaps=[];
 for(let i=0;i<sorted.length;i++){
  const t=sorted[i],prior=sorted.slice(0,i).filter(x=>x.instrument===t.instrument);
  for(const p of prior){
   const diff=ms(t.opened_at)-ms(p.closed_at);
   const overlap=p.status==='OPEN'||(ms(p.closed_at)!=null&&ms(p.closed_at)>ms(t.opened_at));
   if(diff!=null&&diff>=0&&diff<=3*60000&&p.direction===t.direction)
    sequences.push({instrument:t.instrument,priorDirection:p.direction,gapSeconds:+(diff/1000).toFixed(2),
     priorOpen:p.opened_at,priorClose:p.closed_at,priorReason:p.close_reason,
     priorSource:p.close_metadata?.source??null,priorStrategy:p.strategy_code,
     priorRoute:p.plan_b_route,priorNet:n(p.realised_pnl)+n(p.commission)+n(p.swap),
     reopenedAt:t.opened_at,reopenedStrategy:t.strategy_code,reopenedRoute:t.plan_b_route,
     reopenedM1Route:t.m1_route,reopenedExpectedR:t.expected_r});
   if(overlap&&p.direction!==t.direction)
    overlaps.push({instrument:t.instrument,firstDirection:p.direction,firstOpened:p.opened_at,
     firstStatus:p.status,firstClosed:p.closed_at,firstRoute:p.plan_b_route,
     newDirection:t.direction,newOpened:t.opened_at,newRoute:t.plan_b_route,
     firstStrategy:p.strategy_code,newStrategy:t.strategy_code,
     firstReason:p.close_reason,firstSource:p.close_metadata?.source??null});
  }
 }
 return {sequences,overlaps};
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!/^[0-9a-f-]{36}$/i.test(owner||''))throw Error('MISSING_OWNER_SCOPE');
 const c=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
 database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
 ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
 application_name:'irexpro-demo-close-reopen-audit-READONLY',statement_timeout:15000});
 await c.connect();
 try{
  await c.query('BEGIN READ ONLY');
  const sql=[
   'SELECT t.id::text trade_key,t.instrument,t.direction,t.status,t.opened_at,t.closed_at,',
   't.close_reason,t.realised_pnl,t.commission,t.swap,t.fill_price,t.stop_loss,t.take_profit,',
   't.lot_size,t.updated_at,ti.strategy_code,ti.created_at intent_at,',
   "ti.metadata->>'multimodel_plan_b_route' plan_b_route,",
   "ti.metadata->>'m1_tactical_route' m1_route,",
   "ti.metadata->>'multimodel_execution_authority_path' authority_path,",
   "ti.metadata->>'multimodel_governance_net_expected_r' expected_r,",
   "ti.metadata->>'m1_decision_id' decision_id,",
   'ti.metadata intent_metadata,ti.timeframe intent_timeframe,',
   "ti.metadata->>'external_provider_paper_only' paper_only,",
   "ti.metadata->>'m1_policy_version' m1_policy_version,",
   "ti.metadata->>'m1_net_expected_r' m1_net_expected_r,",
   "ti.metadata->>'m1_decision_id' linked_m1_decision_id,",
   "ti.metadata->>'m1_tactical_route' linked_m1_route",
   'FROM trading.trades t JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
   'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
   'WHERE t.user_id=$1 AND b.user_id=$1 AND b.broker_id=\'pepperstone-ctrader\'',
   'AND b.account_type=\'DEMO\' AND b.account_currency=\'USD\' AND b.deleted_at IS NULL',
   'AND t.account_currency=\'USD\' AND t.instrument IN (\'USDCAD\',\'EURUSD\')',
   'AND t.opened_at >= now()- interval \'20 hours\'',
   'ORDER BY t.opened_at DESC LIMIT 300'
  ].join(' ');
  const rows=(await c.query(sql,[owner])).rows;
  const audit=(await c.query(`SELECT a.resource_id,a.action,a.created_at,a.metadata
    FROM audit.audit_logs a WHERE a.actor_user_id=$1
    AND a.resource_type='Trade' AND a.resource_id=ANY($2::text[])
    AND a.action IN ('TRADE_CLOSE_REQUESTED','TRADE_CLOSED')
    ORDER BY a.created_at DESC LIMIT 200`,
    [owner,rows.map(r=>r.trade_key)])).rows;
  await c.query('ROLLBACK');
  const detail=rows.slice(0,55).map(x=>({
   instrument:x.instrument,direction:x.direction,status:x.status,open:x.opened_at,
   closed:x.closed_at,closeReason:x.close_reason,net:n(x.realised_pnl)==null?null:
     +(n(x.realised_pnl)+n(x.commission)+n(x.swap)).toFixed(2),lots:x.lot_size,
   price:x.fill_price,sl:x.stop_loss,tp:x.take_profit,
   strategy:x.strategy_code,route:x.plan_b_route,m1:x.m1_route,
   authority:x.authority_path,expectedR:x.expected_r,
   openPositionGuardSelection:{timeframe:x.intent_timeframe,paperOnly:x.paper_only,
    policy:x.m1_policy_version,originalM1ExpectedR:x.m1_net_expected_r,
    linkedM1Decision:!!x.linked_m1_decision_id,linkedM1Route:x.linked_m1_route},
   closeAudit:audit.filter(a=>a.resource_id===x.trade_key).map(a=>({
    at:a.created_at,action:a.action,source:a.metadata?.aiCloseTrigger?.source??null,
    reasonCode:a.metadata?.aiCloseTrigger?.reasonCode??null,
    reason:a.metadata?.closeReason??null})),
   metaKeys:Object.keys(x.intent_metadata??{}).filter(k=>/exit|strategy|signal|direction|reversal|flip/i.test(k)).slice(0,12)}));
  const {sequences,overlaps}=inspect(rows);
  console.log(JSON.stringify({asOf:new Date().toISOString(),scanned:rows.length,
    recent:detail,closeAndReopenWithin3m:sequences,
    oppositeConcurrentOpenings:overlaps,
    researchOnly:true,sqlWrites:0},null,2));
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{await c.end()}
}
module.exports={inspect};
if(require.main===module)main().catch(e=>{console.error('AUDIT_ERROR',String(e.message).slice(0,170));process.exitCode=1});
