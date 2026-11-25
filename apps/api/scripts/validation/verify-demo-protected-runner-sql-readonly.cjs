'use strict';
/**
 * Read-only live-schema smoke test for owner Pepperstone DEMO protected-runner.
 * NEVER executes INSERT/UPDATE, never connects to broker and never prints
 * credentials, user/connection/position IDs, raw prices, or trade details.
 * Validates actual SQL extracted from source against production PostgreSQL.
 * No flag activation, no AI restart, no broker orders or ledger mutations.
 *
 * Usage (from apps/api on an authorized VPS only):
 *   node scripts/validation/verify-demo-protected-runner-sql-readonly.cjs
 */
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('pg');
const dotenv=require('dotenv');
const root=path.resolve(__dirname,'../..');
const env=dotenv.parse(fs.readFileSync(process.env.IREXPRO_SCHEMA_VERIFY_DOTENV_PATH || path.join(root,'.env')));
const c=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),
  database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,
  ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  connectionTimeoutMillis:5000,statement_timeout:9500,
  application_name:'irexpro_demo_runner_sql_explain_readonly'});
const source=(p)=>fs.readFileSync(path.join(root,'src/modules',p),'utf8');
const sources={
  o:source('execution/reconciliation/demo-protected-profit-runner-orchestrator.service.ts'),
  b:source('broker/broker.service.ts'),
  s:source('execution/reconciliation/demo-profit-stop-authority-sync.service.ts'),
  x:source('execution/reconciliation/live-demo-profit-protection.service.ts'),
};
const sqlBetween=(src,begin,end)=>{
  const i=src.indexOf('`'+begin);
  if(i===-1)throw Error('EXPECTED_SQL_MISSING');
  const j=src.indexOf(end+'`',i);
  if(j<=i)throw Error('EXPECTED_SQL_END_MISSING');
  return src.slice(i+1,j+end.length);
};
const zero='00000000-0000-4000-8000-000000000000';
(async()=>{
  await c.connect();
  await c.query('BEGIN READ ONLY');
  try {
    const q=await c.query(`SELECT t.id,t.user_id,t.broker_connection_id,t.external_order_id,
            t.instrument,t.direction,t.lot_size::text,t.fill_price::text,
            t.stop_loss::text,t.take_profit::text
       FROM trading.trades t JOIN broker.broker_connections b
        ON b.id=t.broker_connection_id
      WHERE b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
        AND t.status='CLOSED' AND t.external_order_id IS NOT NULL
      ORDER BY t.opened_at DESC LIMIT 1`);
    const t=q.rows[0];
    if(!t)throw Error('NO_HISTORICAL_PROVIDER_DEMO_TRADE');
    const now=new Date().toISOString();
    const checks=[
      {name:'LEDGER_INTENT_INSERT',src:sources.o,
        begin:'INSERT INTO trading.demo_profit_stop_amendment_intents',
        end:'ON CONFLICT DO NOTHING RETURNING id',
        args:[t.id,t.user_id,t.broker_connection_id,'CONFIRMED_REVERSAL',t.external_order_id,
          'explain-only-no-write','1.434','1.43','1.44',now,'10','2',
          t.instrument,t.direction,t.lot_size,t.fill_price,t.stop_loss,t.take_profit]},
      {name:'LEDGER_DISPATCH_CAS',src:sources.o,
        begin:'UPDATE trading.demo_profit_stop_amendment_intents',end:'RETURNING id',
        args:[zero,t.user_id,t.broker_connection_id]},
      {name:'BROKER_DISPATCH_FENCE',src:sources.b,
        begin:'UPDATE trading.demo_profit_stop_amendment_intents l',end:'RETURNING l.id',
        args:[zero,t.user_id,t.broker_connection_id]},
      {name:'BROKER_ACK_CAS',src:sources.b,
        begin:"UPDATE trading.demo_profit_stop_amendment_intents\n              SET state='ACKNOWLEDGED'",
        end:'RETURNING id',
        args:[zero,t.user_id,t.broker_connection_id,now,'1.434',now]},
      {name:'TRADE_AUTHORITY_STOP_CAS',src:sources.s,
        begin:'UPDATE trading.trades\n            SET stop_loss=$3',
        end:'RETURNING stop_loss::text AS stop_loss',
        args:[t.id,t.user_id,'1.434',t.broker_connection_id,t.external_order_id,
          t.stop_loss,t.take_profit]},
      {name:'ASOF_NATIVE_COMPLETED_CANDLES',src:sources.x,
        begin:'SELECT bucket_time, open, high, low, close, sample_count',
        end:'ORDER BY bucket_time DESC LIMIT $5',
        args:[t.broker_connection_id,t.instrument,'M5',now,1]},
    ];
    for (const check of checks){
      const sql=sqlBetween(check.src,check.begin,check.end);
      const plan=await c.query('EXPLAIN (COSTS OFF) '+sql,check.args);
      if(!plan.rows.length)throw Error('EMPTY_PLAN');
      console.log(check.name+': EXPLAIN_OK_READONLY');
    }
    console.log('VERIFIED_NO_DATABASE_WRITES_NO_BROKER_ACTIONS');
  } finally {
    await c.query('ROLLBACK').catch(()=>{});
    await c.end();
  }
})().catch(e=>{
  // Error code plus sanitized SQLSTATE-derived class only: never DB strings.
  console.error('READONLY_SQL_CHECK_FAILED',/^[A-Z0-9]{5}$/.test(e.code||'')?e.code:'CHECK_FAILED');
  process.exitCode=1;
});
