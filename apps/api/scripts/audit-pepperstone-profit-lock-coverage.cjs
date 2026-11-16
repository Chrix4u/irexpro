'use strict';
// Read-only, owner-scoped Pepperstone DEMO peak/exit coverage.
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUT = '/home/lightworld/webapps/irexpro-research/profit-lock-coverage/latest-report.json';
function amount(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function band(peak, risk) {
  if (peak === null || risk === null || risk <= 0) return 'UNVERIFIED_RISK';
  if (peak/risk < 0.2) return 'BELOW_0_20_R';
  if (peak/risk < 0.5) return 'EARLY_0_20_TO_0_50_R';
  return 'HIGH_0_50_R_PLUS';
}
function summarize(rows) {
  const bands = {};
  for (const row of rows) {
    const key = band(amount(row.max_favorable_pnl), amount(row.initial_risk_pnl));
    const b = bands[key] ??= {trades:0,wins:0,losses:0,unpriced:0,
      lossAfterPositivePeak:0,profitProtectionCloses:0,
      shadowRecommendedTrades:0,net:0};
    b.trades++;
    if (row.close_reason === 'PROFIT_PROTECTION') b.profitProtectionCloses++;
    if (Number(row.shadow_recommendations || 0)>0) b.shadowRecommendedTrades++;
    const gross=amount(row.realised_pnl);
    const fee=amount(row.commission);
    const swap=row.swap===null?0:amount(row.swap);
    if(gross===null||fee===null||swap===null){b.unpriced++;continue;}
    const net=gross+fee+swap;
    b.net+=net;
    if(net>0)b.wins++;
    if(net<0){b.losses++;if(amount(row.max_favorable_pnl)>0)b.lossAfterPositivePeak++;}
  }
  for(const v of Object.values(bands))v.net=Number(v.net.toFixed(2));
  return bands;
}
const QUERY = [
  'SELECT t.id,t.instrument,t.direction,t.status,t.close_reason,t.closed_at,',
  't.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,',
  "COALESCE(NULLIF(ca.sizing_inputs->>'finalRiskAtStop','')::numeric,",
  "NULLIF(ca.sizing_inputs->>'riskAmount','')::numeric) initial_risk_pnl,",
  'COALESCE(shadow.recommendations,0) shadow_recommendations',
  'FROM trading.trades t JOIN broker.broker_connections b ON b.id=t.broker_connection_id',
  'LEFT JOIN LATERAL (SELECT sizing_inputs FROM trading.capital_allocations x',
  'WHERE x.trade_intent_id=t.trade_intent_id AND x.created_at<=t.opened_at',
  'ORDER BY x.created_at DESC LIMIT 1) ca ON TRUE',
  'LEFT JOIN LATERAL (SELECT count(*)::int recommendations FROM audit.audit_logs a',
  "WHERE a.resource_id=t.id::text AND a.action='DEMO_ALTERNATIVE_PROFIT_LOCK_SHADOW'",
  "AND a.metadata->>'hypotheticalAction' LIKE 'WOULD_CLOSE%') shadow ON TRUE",
  "WHERE t.user_id=$1 AND b.user_id=$1 AND b.broker_id='pepperstone-ctrader'",
  "AND b.account_type='DEMO' AND b.deleted_at IS NULL AND t.account_currency='USD'",
  "AND t.status='CLOSED' AND t.closed_at >= $2::timestamptz",
  'AND t.closed_at < $3::timestamptz ORDER BY t.closed_at,t.id LIMIT $4::int'
].join(' ');
async function audit(client,userId,from,to){
  if(!UUID.test(userId||''))throw Error('INVALID_USER_SCOPE');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='30000ms'");
    const rows=(await client.query(QUERY,[userId,from,to,2001])).rows;
    if(rows.length>2000)throw Error('UNBOUNDED_AUDIT');
    await client.query('COMMIT');
    return {
      artifact:'pepperstone-demo-profit-lock-coverage-readonly-v1',
      generatedAt:new Date().toISOString(),windowUTC:{from,to},
      scope:'OWNER_PEPPERSTONE_DEMO_USD_CLOSED',closedTrades:rows.length,
      observedPeakBands:summarize(rows),
      authority:'RESEARCH_ONLY',modifiesExecution:false,
      limitations:[
        'Peak-to-risk bands use hindsight, not information available at trade entry.',
        'Shadow WOULD_CLOSE is not a broker fill, and cannot prove a hypothetical profit.',
        'Profit protection cannot guarantee profit and must account for fees and broker execution.',
        'This audit has no authority to change orders, strategies or account settings.'
      ]
    };
  }catch(e){await client.query('ROLLBACK');throw e;}
}
async function main(){
  require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||resolve(__dirname,'../.env'),quiet:true});
  const {Client}=require('pg');
  const {getDatabaseSslOptions}=require('../dist/config/database-tls');
  const to=new Date();const from=new Date(to.getTime()-10*86400000);
  const c=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
    password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    application_name:'irexpro-profit-lock-coverage-readonly'});
  try{
    await c.connect();
    const result=await audit(c,process.env.VPS_FOREX_SCANNER_USER_ID,from.toISOString(),to.toISOString());
    mkdirSync(resolve(OUT,'..'),{recursive:true,mode:0o700});
    writeFileSync(OUT,JSON.stringify(result,null,2),{mode:0o600});
    console.log('PROFIT_LOCK_COVERAGE',JSON.stringify(result));
  }finally{await c.end();}
}
module.exports={amount,band,summarize,audit,QUERY};
if(require.main===module)main().catch(e=>{console.error('PROFIT_LOCK_COVERAGE_ERROR',e.message);process.exitCode=1;});
