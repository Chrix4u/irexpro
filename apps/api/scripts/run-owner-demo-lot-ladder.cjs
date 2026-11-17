#!/usr/bin/env node
'use strict';
/**
 * Read-only owner DEMO settled-trade lot sensitivity.
 * node scripts/run-owner-demo-lot-ladder.cjs --equity=48064 --reference=50000 --out=/tmp/lot-ladder.json
 * No database mutations, execution calls, or broker account changes.
 */
const path=require('node:path');
const fs=require('node:fs');
const {reportLadder}=require('./research-owner-demo-lot-ladder.cjs');
const FOCUS=Object.freeze(['EURUSD','AUDUSD','USDCAD','USDJPY']);
const HOURS=7*24;
const MAX_TRADES=800;
function arg(name){const x=process.argv.find(y=>y.startsWith('--'+name+'='));return x?x.slice(name.length+3):null;}
function positive(name){const v=Number(arg(name));if(!Number.isFinite(v)||v<=0)throw Error('MISSING_OR_INVALID_'+name.toUpperCase());return v;}
async function run(){
  const equity=positive('equity');
  const ref=arg('reference')===null?null:positive('reference');
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  const {Client}=require('pg');
  const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!owner)throw Error('OWNER_ID_REQUIRED');
  const c=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,statement_timeout:25000});
  let rows;
  const asOf=new Date(),start=new Date(asOf.getTime()-HOURS*3600_000);
  try{
    await c.connect();await c.query('BEGIN READ ONLY');
    const brokers=await c.query(
      "SELECT id FROM broker.broker_connections WHERE user_id=$1 "+
      "AND broker_id='pepperstone-ctrader' AND account_type='DEMO' "+
      "AND account_currency='USD' AND deleted_at IS NULL "+
      "ORDER BY created_at DESC LIMIT 1",[owner]);
    if(brokers.rows.length!==1)throw Error('OWNER_PEPPERSTONE_USD_DEMO_NOT_FOUND');
    const conn=brokers.rows[0].id;
    rows=(await c.query(
      "SELECT t.status,t.instrument,t.direction,t.account_currency,t.lot_size, "+
      "t.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,t.profit_giveback, "+
      "ti.metadata->>'multimodel_plan_b_route' AS strategy_route, "+
      "ca.sizing_inputs->>'finalRiskAtStop' AS initial_risk "+
      "FROM trading.trades t "+
      "JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id "+
      "LEFT JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id "+
      "LEFT JOIN LATERAL(SELECT z.sizing_inputs FROM trading.capital_allocations z "+
      "WHERE z.trade_intent_id=t.trade_intent_id ORDER BY z.created_at DESC LIMIT 1) ca ON TRUE "+
      "WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.status='CLOSED' "+
      "AND t.instrument=ANY($3::text[]) AND t.account_currency='USD' "+
      "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO' "+
      "AND b.account_currency='USD' AND t.closed_at >= $4::timestamptz "+
      "AND t.closed_at <= $5::timestamptz ORDER BY t.closed_at DESC LIMIT "+MAX_TRADES,
      [owner,conn,[...FOCUS],start,asOf])).rows;
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally{await c.end();}
  const output={...reportLadder(rows,{equityUsd:equity,riskPercent:.25}),
    asOf:asOf.toISOString(),lookbackHours:HOURS,
    referenceInitialCapitalUsd:ref,
    ownerReportedDrawdownUsd:ref===null?null:Math.max(0,Number((ref-equity).toFixed(2))),
    ownerReportedDrawdownPct:ref===null?null:Math.max(0,Number((100*(ref-equity)/ref).toFixed(3))),
    source:'HISTORICAL_SETTLED_OWNER_PEPPERSTONE_CTRADER_USD_DEMO_ONLY',
    noBrokerEquityVerification:true,
  };
  const dest=arg('out');
  if(dest){const file=path.resolve(dest);fs.writeFileSync(file,JSON.stringify(output,null,2)+'\n',{mode:0o600});
    console.log('READ_ONLY_LOT_LADDER_WRITTEN '+file);}
  console.log(JSON.stringify(output,null,2));
}
if(require.main===module)run().catch(e=>{console.error('LOT_LADDER_FAILED',e.message);process.exitCode=1});
module.exports={run};
