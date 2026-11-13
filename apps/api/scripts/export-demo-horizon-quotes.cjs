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
      SELECT s.broker_connection_id,s.user_id
      FROM trading.trading_sessions s
      JOIN broker.broker_connections b
        ON b.id=s.broker_connection_id AND b.user_id=s.user_id
      WHERE s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
        AND b.account_type='DEMO' AND b.broker_id='pepperstone-ctrader'
      ORDER BY s.started_at DESC LIMIT 1
    `);
    if (active.rowCount!==1)throw Error('No active Pepperstone FULL_AUTO DEMO connection');
    const id=active.rows[0].broker_connection_id;
    // Enforce OWNER-VERIFIED source and each pair's real Pepperstone start.
    // Historically archived cTrader quotes may only pretrain; they must
    // never intrude into later current-broker walk-forward holdout dates.
    // A zero-spread quote is not executable bid/ask evidence. Excluding it
    // will invalidate any uninterrupted M1 feature/label window crossing it.
    const res=await db.query(`
      WITH first_current AS (
        SELECT instrument, MIN(bucket_time) AS first_bar
        FROM market_data.provider_quote_candles
        WHERE connection_id=$1 AND timeframe='M1'
          AND instrument=ANY($2::text[])
        GROUP BY instrument
      )
      SELECT q.instrument,to_char(q.bucket_time AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS"Z"') stamp,
             CASE WHEN q.last_positive_bid>0
                 AND q.last_positive_ask>q.last_positive_bid
                 AND q.last_positive_sample_at>=q.bucket_time
                 AND q.last_positive_sample_at<q.bucket_time+interval '1 minute'
               THEN q.last_positive_bid::text ELSE q.bid_close::text END bid,
             CASE WHEN q.last_positive_bid>0
                 AND q.last_positive_ask>q.last_positive_bid
                 AND q.last_positive_sample_at>=q.bucket_time
                 AND q.last_positive_sample_at<q.bucket_time+interval '1 minute'
               THEN q.last_positive_ask::text ELSE q.ask_close::text END ask,
             q.open::text open,q.high::text high,
             q.low::text low,q.close::text close,
             b.broker_id source_broker,
             CASE WHEN q.last_positive_bid>0
                 AND q.last_positive_ask>q.last_positive_bid
                 AND q.last_positive_sample_at>=q.bucket_time
                 AND q.last_positive_sample_at<q.bucket_time+interval '1 minute'
               THEN 'last_observed_positive_intraminute_tick'
               ELSE 'positive_close_quote' END quote_mark_source
      FROM market_data.provider_quote_candles q
      JOIN broker.broker_connections b
        ON b.id=q.connection_id AND b.user_id=$3
      JOIN first_current f ON f.instrument=q.instrument
      WHERE q.timeframe='M1' AND q.instrument=ANY($2::text[])
        AND q.bucket_time >= now()-interval '45 days'
        AND q.bucket_time < date_trunc('minute',now())-interval '2 minutes'
        AND (
          (q.last_positive_bid>0 AND q.last_positive_ask>q.last_positive_bid
           AND q.last_positive_sample_at>=q.bucket_time
           AND q.last_positive_sample_at<q.bucket_time+interval '1 minute')
          OR (q.bid_close>0 AND q.ask_close>q.bid_close)
        )
        AND (q.connection_id=$1 OR
             (b.account_type='DEMO' AND b.broker_id='ctrader'
              AND q.bucket_time<f.first_bar))
      ORDER BY q.instrument,q.bucket_time
    `,[id,['EURUSD','AUDUSD'],active.rows[0].user_id]);
    if (res.rowCount<100)throw Error('Broker-native positive-spread research evidence insufficient');
    const fd=fs.openSync(out,'wx',0o600);
    try {
      fs.writeSync(fd,'instrument,stamp,bid,ask,open,high,low,close,source_broker,quote_mark_source\n');
      for(const r of res.rows)fs.writeSync(fd,
        [r.instrument,r.stamp,r.bid,r.ask,r.open,r.high,r.low,r.close,r.source_broker,r.quote_mark_source].join(',')+'\n');
    } finally {fs.closeSync(fd)}
    console.log(JSON.stringify({artifact:'irexpro-horizon-broker-quote-export-v2',
      rows:res.rowCount,usesOlderCtraderAsPretraining:true,
      positiveObservedBidAskRequired:true,ownerVerified:true,
      latestPepperstoneAsHoldout:true,positiveIntraminuteQuoteFallback:true,executionAuthority:'NONE'}));
  } finally {await db.end()}
})().catch(e=>{console.error('EXPORT_FAILED',e.code||'',e.message);process.exitCode=1});
