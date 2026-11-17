#!/usr/bin/env node
'use strict';
/**
 * Owner-scoped Pepperstone USD DEMO broker-native completed OHLC corpus.
 * READ-ONLY. Contains no account identifier and cannot submit trades.
 *
 * cd apps/api
 * node scripts/export-owner-demo-candle-training-corpus.cjs \
 *   --out=/tmp/irexpro-owner-candle-corpus.csv
 */
const fs=require('node:fs');
const path=require('node:path');
const FOCUS=['EURUSD','AUDUSD','USDJPY','USDCAD'];
const MINUTES={M1:1,M5:5,M15:15,H1:60,H4:240};
const MAX_ROWS=95000;
async function main(){
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  const {Client}=require('pg');
  const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!owner)throw Error('OWNER_DEMO_SCOPE_REQUIRED');
  const out=process.argv.find(v=>v.startsWith('--out='));
  if(!out||!out.slice(6).trim())throw Error('PRIVATE_OUTPUT_PATH_REQUIRED');
  const destination=path.resolve(out.slice(6));
  if(!destination.startsWith('/tmp/'))throw Error('OUTPUT_MUST_BE_UNDER_TMP');
  const db=new Client({host:process.env.DB_HOST,
    port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    statement_timeout:30000});
  let rows;
  const asOf=new Date(),since=new Date(asOf.getTime()-21*24*3600_000);
  try{
    await db.connect();await db.query('BEGIN READ ONLY');
    const broker=await db.query(
      "SELECT id FROM broker.broker_connections WHERE user_id=$1 "+
      "AND broker_id='pepperstone-ctrader' AND account_type='DEMO' "+
      "AND account_currency='USD' AND deleted_at IS NULL "+
      "ORDER BY created_at DESC LIMIT 1",[owner]);
    if(broker.rows.length!==1)throw Error('OWNER_PEPPERSTONE_USD_DEMO_REQUIRED');
    const q=[
      'SELECT instrument,timeframe,bucket_time,open,high,low,close,',
      'bid_close,ask_close,spread_close,sample_count,positive_quote_sample_count,',
      'last_positive_sample_at,source',
      'FROM market_data.provider_quote_candles',
      'WHERE connection_id=$1 AND source=$2 AND instrument=ANY($3::text[])',
      'AND timeframe=ANY($4::text[])',
      'AND bucket_time >= $5::timestamptz',
      "AND bucket_time + CASE timeframe",
      "WHEN 'M1' THEN interval '1 minute' WHEN 'M5' THEN interval '5 minutes'",
      "WHEN 'M15' THEN interval '15 minutes' WHEN 'H1' THEN interval '1 hour'",
      "WHEN 'H4' THEN interval '4 hours' ELSE interval '99 days' END <= $6::timestamptz",
      'AND positive_quote_sample_count >=2 AND sample_count>=2',
      'AND last_positive_sample_at >= bucket_time',
      "AND last_positive_sample_at < bucket_time + CASE timeframe",
      "WHEN 'M1' THEN interval '1 minute' WHEN 'M5' THEN interval '5 minutes'",
      "WHEN 'M15' THEN interval '15 minutes' WHEN 'H1' THEN interval '1 hour'",
      "WHEN 'H4' THEN interval '4 hours' ELSE interval '99 days' END",
      'AND open>0 AND high>=greatest(open,close) AND low<=least(open,close)',
      'AND low>0 AND close>0 AND bid_close>0 AND ask_close>=bid_close',
      'ORDER BY instrument,timeframe,bucket_time',
      'LIMIT '+MAX_ROWS,
    ].join(' ');
    rows=(await db.query(q,[broker.rows[0].id,'ctrader-broker-native',FOCUS,
      Object.keys(MINUTES),since,asOf])).rows;
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{await db.end()}
  if(!rows.length)throw Error('NO_COMPLETE_OWNER_NATIVE_CANDLES');
  const header=['instrument','timeframe','bucket_time','open','high','low','close',
    'bid_close','ask_close','spread_close','sample_count','positive_quote_sample_count'];
  const text=header.join(',')+'\n'+rows.map(r=>header.map(k=>{
    const v=k==='bucket_time'?new Date(r[k]).toISOString():String(r[k]??'');
    if(/[",\n\r]/.test(v))throw Error('UNEXPECTED_CSV_VALUE');
    return v;
  }).join(',')).join('\n')+'\n';
  fs.writeFileSync(destination,text,{mode:0o600});
  const coverage={};for(const r of rows)coverage[r.instrument+':'+r.timeframe]=(coverage[r.instrument+':'+r.timeframe]||0)+1;
  console.log(JSON.stringify({
    artifact:'irexpro-owner-demo-native-candle-corpus-v1',
    asOf:asOf.toISOString(),completedOnly:true,brokerNative:true,
    readOnly:true,accountIdsExported:false,source:'ctrader-broker-native',
    rows:rows.length,instruments:FOCUS,coverage,output:destination,
    warning:'Candle OHLC are aggregated final bars. Cannot train forming-candle states without archived intrabar as-of snapshots.',
  },null,2));
}
if(require.main===module)main().catch(e=>{
 console.error('CANDLE_EXPORT_FAILED',e.message);process.exitCode=1;
});
module.exports={main,FOCUS,MINUTES};
