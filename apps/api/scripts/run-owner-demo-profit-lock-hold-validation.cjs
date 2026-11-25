#!/usr/bin/env node
'use strict';

/**
 * Read-only owner Pepperstone USD DEMO comparison of PRE-EXIT trend recheck
 * and AFTER-EXIT quote-verified horizon outcomes, already persisted by API.
 * No new candles, broker calls, position amendments, or order changes.
 *
 * cd apps/api
 * node scripts/run-owner-demo-profit-lock-hold-validation.cjs --out=/tmp/profit-lock-patience-audit.json
 */
const path=require('node:path'), fs=require('node:fs');
const {summarize}=require('./research-owner-demo-profit-lock-hold-validation.cjs');
const ARTIFACT='exit-alternatives-verified-m1-v2';
const LOOKBACK_DAYS=21;
const LIMIT=500;

async function main() {
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  const {Client}=require('pg');
  const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!owner)throw Error('OWNER_SCOPE_REQUIRED');
  const asOf=new Date();
  const db=new Client({
    host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    statement_timeout:20000,
  });
  let rows;
  try{
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const bc=await db.query(
      "SELECT id FROM broker.broker_connections "+
      "WHERE user_id=$1 AND broker_id='pepperstone-ctrader' "+
      "AND account_type='DEMO' AND account_currency='USD' "+
      "AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [owner],
    );
    if(bc.rows.length!==1)throw Error('OWNER_PEPPERSTONE_USD_DEMO_NOT_FOUND');
    const query=[
      "SELECT t.status,t.close_reason,t.account_currency,t.closed_at,",
      "t.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,",
      "t.profit_giveback,t.instrument,t.direction,",
      "COALESCE(ti.metadata->>'multimodel_plan_b_route',",
      "ti.metadata->>'m1_tactical_route') AS strategy_route,",
      "o.response,a.metadata AS audit",
      "FROM trading.post_entry_shadow_observations o",
      "JOIN trading.trades t ON t.id=o.trade_id",
      "AND t.user_id=o.user_id",
      "AND t.broker_connection_id=o.execution_broker_connection_id",
      "AND t.trade_intent_id=o.trade_intent_id",
      "JOIN broker.broker_connections b ON b.id=t.broker_connection_id",
      "AND b.user_id=t.user_id",
      "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
      "AND ti.user_id=t.user_id",
      "AND ti.broker_connection_id=t.broker_connection_id",
      "LEFT JOIN LATERAL (",
      "SELECT audit0.metadata FROM audit.audit_logs audit0",
      "WHERE audit0.action='DEMO_PROFIT_LOCK_TREND_RECHECK'",
      "AND audit0.resource_type='Trade'",
      "AND audit0.resource_id=t.id::text",
      "AND audit0.actor_user_id=t.user_id",
      "AND audit0.metadata->>'mode'='SHADOW_ONLY'",
      "AND audit0.metadata->>'observedAt'=o.response->>'snapshotAt'",
      "AND audit0.created_at BETWEEN",
      "t.closed_at - interval '2 minutes'",
      "AND t.closed_at + interval '2 minutes'",
      "ORDER BY audit0.created_at DESC LIMIT 1",
      ") a ON true",
      "WHERE t.user_id=$1 AND t.broker_connection_id=$2",
      "AND b.broker_id='pepperstone-ctrader'",
      "AND b.account_type='DEMO' AND b.account_currency='USD'",
      "AND t.account_currency='USD' AND t.status='CLOSED'",
      "AND t.close_reason='PROFIT_PROTECTION'",
      "AND t.instrument=ANY($3::text[])",
      "AND o.artifact=$4 AND o.checkpoint_minutes=60",
      "AND o.modifies_execution=false",
      "AND o.execution_authority='NONE'",
      "AND t.closed_at >= $5::timestamptz - interval '21 days'",
      "AND t.closed_at <= $5::timestamptz - interval '65 minutes'",
      "ORDER BY t.closed_at DESC LIMIT "+LIMIT,
    ].join(' ');
    rows=(await db.query(query,
      [owner,bc.rows[0].id,['EURUSD','AUDUSD','USDCAD','USDJPY'],ARTIFACT,asOf],
    )).rows;
    await db.query('COMMIT');
  }catch(error){
    await db.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{await db.end()}
  const report={
    ...summarize(rows),
    asOf:asOf.toISOString(),lookbackDays:LOOKBACK_DAYS,
    source:'OWNER_PEPPERSTONE_USD_DEMO_PERSISTED_PROSPECTIVE_DECISION_AND_POST_EXIT_SHADOW',
    noProviderOrderAction:true,
    notActualCounterfactualFills:true,
  };
  const arg=process.argv.find(x=>x.startsWith('--out='));
  if(arg){
    const destination=path.resolve(arg.slice(6));
    fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log('READ_ONLY_PROFIT_LOCK_AUDIT_WRITTEN '+destination);
  }
  console.log(JSON.stringify(report,null,2));
}
module.exports={main};
if(require.main===module)main().catch(error=>{
  console.error('READ_ONLY_PROFIT_LOCK_AUDIT_ABORTED',error.message);
  process.exitCode=1;
});
