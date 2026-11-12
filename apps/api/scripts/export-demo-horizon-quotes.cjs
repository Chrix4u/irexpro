// Read-only DEMO broker quote export for offline research. No order authority.
const fs = require('fs');
const path = require('path');
require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
const {Client} = require('pg');
(async()=>{
  const out=process.argv[2];
  if (!out || !/^\/tmp\/irexpro-[a-zA-Z0-9-]+\.csv$/.test(out) || fs.existsSync(out))
    throw Error('Require a fresh private /tmp/irexpro-*.csv destination');
  const db=new Client({
    host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    statement_timeout:30000
  });
  await db.connect();
  try {
    const active=await db.query(`
      SELECT s.broker_connection_id
      FROM trading.trading_sessions s
      JOIN broker.broker_connections b ON b.id=s.broker_connection_id
      WHERE s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
        AND b.account_type='DEMO' AND b.broker_id='pepperstone-ctrader'
      ORDER BY s.started_at DESC LIMIT 1
    `);
    if (active.rowCount!==1)throw Error('No active Pepperstone FULL_AUTO DEMO connection');
    const id=active.rows[0].broker_connection_id;
    const start=await db.query(`
      SELECT MIN(bucket_time) oldest FROM market_data.provider_quote_candles
      WHERE connection_id=$1 AND timeframe='M1' AND instrument=ANY($2::text[])
    `,[id,['EURUSD','AUDUSD']]);
    if (!start.rows[0].oldest) throw Error('No current broker M1 quotes');
    const res=await db.query(`
      SELECT q.instrument,to_char(q.bucket_time AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS"Z"') stamp,
             q.bid_close::text bid,q.ask_close::text ask,
             q.open::text open,q.high::text high,
             q.low::text low,q.close::text close
      FROM market_data.provider_quote_candles q
      JOIN broker.broker_connections b ON b.id=q.connection_id
      WHERE q.timeframe='M1' AND q.instrument=ANY($2::text[])
        AND q.bucket_time >= now()-interval '45 days'
        AND q.bucket_time < date_trunc('minute',now())-interval '2 minutes'
        AND q.bid_close>0 AND q.ask_close>=q.bid_close
        AND (q.connection_id=$1 OR
             (b.account_type='DEMO' AND b.broker_id='ctrader' AND q.bucket_time < $3))
      ORDER BY q.instrument,q.bucket_time
    `,[id,['EURUSD','AUDUSD'],start.rows[0].oldest]);
    const fd=fs.openSync(out,'wx',0o600);
    try {
      fs.writeSync(fd,'instrument,stamp,bid,ask,open,high,low,close\n');
      for(const r of res.rows)fs.writeSync(fd,
        [r.instrument,r.stamp,r.bid,r.ask,r.open,r.high,r.low,r.close].join(',')+'\n');
    } finally {fs.closeSync(fd)}
    console.log(JSON.stringify({artifact:'irexpro-horizon-broker-quote-export-v1',
      rows:res.rowCount,usesOlderCtraderAsPretraining:true,
      latestPepperstoneAsHoldout:true,executionAuthority:'NONE'}));
  } finally {await db.end()}
})().catch(e=>{console.error('EXPORT_FAILED',e.code||'',e.message);process.exitCode=1});
