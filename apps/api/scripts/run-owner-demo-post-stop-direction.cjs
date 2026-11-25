#!/usr/bin/env node
'use strict';

/**
 * Read-only owner Pepperstone cTrader USD DEMO follow-up study.
 *
 * Classifies broker-confirmed stops and uses subsequent complete M1 bid/ask
 * closes at +1/+3/+5/+10 minutes after exit to distinguish later price
 * reclamation from no observed recovery. NEVER an order or stop-change rule.
 *
 * cd apps/api
 * node scripts/run-owner-demo-post-stop-direction.cjs --out=/tmp/stop-audit.json
 */
const path=require('node:path');
const fs=require('node:fs');
const {selectCausalM1Mark,FOCUS}=require('./research-owner-demo-direction-horizons.cjs');
const {HORIZONS,classifyClosedStopTrade,summarizeStopFollowups}=
  require('./research-owner-demo-post-stop-direction.cjs');

const HOURS=24;
const MATURE_MINUTES=12; // All 10-minute broker M1 closes mature.
const MAX_TRADES=250;

async function study() {
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  const {Client}=require('pg');
  const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!owner)throw Error('EXACT_OWNER_SCOPE_REQUIRED');
  const now=new Date();
  const from=new Date(now.getTime()-HOURS*3600_000);
  const mature=new Date(now.getTime()-MATURE_MINUTES*60_000);
  const c=new Client({
    host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    statement_timeout:25000,
  });
  let trades, candles;
  try{
    await c.connect();
    await c.query('BEGIN READ ONLY');
    const broker=await c.query(
      `SELECT id FROM broker.broker_connections
        WHERE user_id=$1 AND broker_id='pepperstone-ctrader'
          AND account_type='DEMO' AND account_currency='USD'
          AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [owner],
    );
    if(broker.rows.length!==1)throw Error('OWNER_USD_DEMO_BROKER_NOT_FOUND');
    const connection=broker.rows[0].id;
    trades=(await c.query(
      `SELECT t.id,t.status,t.instrument,t.direction,t.account_currency,
         t.opened_at,t.closed_at,t.close_reason,t.fill_price,t.stop_loss,
         t.take_profit,t.exit_price,t.lot_size,t.realised_pnl,t.commission,
         t.swap,t.max_favorable_pnl,t.max_adverse_pnl,t.profit_giveback,
         t.path_observation_count,
         ti.metadata->>'multimodel_plan_b_route' AS strategy_route,
         ca.sizing_inputs->>'finalRiskAtStop' AS initial_risk
       FROM trading.trades t
       JOIN broker.broker_connections b
         ON b.id=t.broker_connection_id AND b.user_id=t.user_id
       LEFT JOIN trading.trade_intents ti
         ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id
       LEFT JOIN LATERAL(
         SELECT z.sizing_inputs FROM trading.capital_allocations z
         WHERE z.trade_intent_id=t.trade_intent_id
         ORDER BY z.created_at DESC LIMIT 1
       ) ca ON TRUE
       WHERE t.user_id=$1 AND t.broker_connection_id=$2
         AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
         AND b.account_currency='USD'
         AND t.account_currency='USD'
         AND t.status='CLOSED'
         AND t.instrument=ANY($3::text[])
         AND t.closed_at >= $4::timestamptz
         AND t.closed_at <= $5::timestamptz
       ORDER BY t.closed_at DESC LIMIT `+MAX_TRADES,
      [owner,connection,[...FOCUS],from,mature],
    )).rows;
    candles=(await c.query(
      `SELECT instrument,bucket_time,bid_close,ask_close,source,
         sample_count,last_quote_sample_at
       FROM market_data.provider_quote_candles
       WHERE connection_id=$1 AND timeframe='M1'
         AND instrument=ANY($2::text[])
         AND bucket_time >= $3::timestamptz - interval '1 minute'
         AND bucket_time <= $4::timestamptz
       ORDER BY instrument,bucket_time`,
      [connection,[...FOCUS],from,now],
    )).rows;
    await c.query('COMMIT');
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{await c.end();}
  const candlesByInstrument={};
  for(const row of candles)(candlesByInstrument[row.instrument]||=[]).push(row);
  const rows=trades.map(trade=>{
    const marks={};
    for(const minutes of HORIZONS)
      marks[minutes]=selectCausalM1Mark(
        candlesByInstrument[trade.instrument]||[],trade.closed_at,minutes,now);
    return {
      // Redact identifiers and account linkage from portable research output.
      ...classifyClosedStopTrade(trade,marks),
      pathObservationCount:trade.path_observation_count,
      profitGiveback:trade.profit_giveback,
    };
  });
  return {
    ...summarizeStopFollowups(rows),
    asOf:now.toISOString(),
    lookbackHours:HOURS,
    minimumCompletedExitAgeMinutes:MATURE_MINUTES,
    instruments:[...FOCUS],
    source:'ctrader-broker-native',
    caution:'An M1 close after an SL is not evidence that widening the SL would have survived intraminute adverse prices. Price reclamation is not a profitable alternative fill.',
    examples:rows,
  };
}

if(require.main===module)study().then(report=>{
  const output=process.argv.find(a=>a.startsWith('--out='));
  if(output){
    const target=path.resolve(output.slice(6));
    fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log('OWNER_DEMO_RESEARCH_WRITTEN '+target);
  }
  console.log(JSON.stringify(report,null,2));
}).catch(error=>{
  console.error('READ_ONLY_STOP_AUDIT_FAILED',error.message);
  process.exitCode=1;
});
module.exports={study};
