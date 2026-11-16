'use strict';
// Read-only forensic first-shadow audit; NEVER dispatches trades.
const {resolve}=require('node:path');
const {mkdirSync,writeFileSync}=require('node:fs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUT='/home/lightworld/webapps/irexpro-research/profit-lock-first-signal/latest-report.json';
const TYPES=['LEGACY_FIRST_CROSSING','HIGH_PEAK_CONFIRMED','PEAK_TO_LOSS_RESCUE'];
function num(x) {
  if(x===null||x===undefined||x==='')return null;
  const y=Number(x);
  return Number.isFinite(y)?y:null;
}
function cohort(trades,type) {
  const out={firstSignals:0,laterWinners:0,laterLosers:0,laterFlat:0,
    unpricedActual:0,realizedNetOfSignaledTrades:0,
    positiveMarkSignals:0,costEvidenceSignals:0,
    positiveAfterExtraCostMarkSignals:0,missingMarkSignals:0,
    medianMinutesBeforeExit:null};
  const lead=[];
  for(const trade of trades) {
    const signal=trade[type];
    if(!signal)continue;
    const at=new Date(signal.created_at).getTime();
    const opened=new Date(trade.opened_at).getTime();
    const closed=new Date(trade.closed_at).getTime();
    if(!Number.isFinite(at)||!Number.isFinite(opened)||
       !Number.isFinite(closed)||at<opened||at>=closed)continue;
    out.firstSignals++;
    const gross=num(trade.realised_pnl);
    const fee=num(trade.commission);
    const swap=trade.swap===null?0:num(trade.swap);
    if(gross===null||fee===null||swap===null)out.unpricedActual++;
    else {
      const net=gross+fee+swap;
      out.realizedNetOfSignaledTrades+=net;
      if(net>0)out.laterWinners++;
      else if(net<0)out.laterLosers++;
      else out.laterFlat++;
    }
    const m=signal.metadata||{};
    // cTrader mark may ALREADY be net. Deduct another fee only as an
    // EXTRA conservative reserve, never as reconstructed broker fill P&L.
    const reservedNet=num(m.estimatedNetAfterExtraCost);
    const reserve=num(m.estimatedBrokerCosts??m.brokerExtraFeeReserve);
    const rawMark=num(m.currentGrossPnl);
    // A validated high-peak record can publish only net-after-extra-cost;
    // recover the mark solely for coverage counting, never as a broker fill.
    const mark=rawMark!==null?rawMark:
      reservedNet!==null&&reserve!==null?reservedNet+reserve:null;
    if(mark===null)out.missingMarkSignals++;
    else if(mark>0)out.positiveMarkSignals++;
    if(reserve!==null&&reserve>0){
      out.costEvidenceSignals++;
      const afterReserve=reservedNet!==null?reservedNet:
        mark!==null?mark-reserve:null;
      if(afterReserve!==null&&afterReserve>0)out.positiveAfterExtraCostMarkSignals++;
    }
    lead.push((closed-at)/60000);
  }
  out.realizedNetOfSignaledTrades=Number(out.realizedNetOfSignaledTrades.toFixed(2));
  lead.sort((a,b)=>a-b);
  if(lead.length)out.medianMinutesBeforeExit=Number(lead[Math.floor((lead.length-1)/2)].toFixed(2));
  return out;
}
function analyze(rows,window) {
  return {artifact:'pepperstone-demo-first-shadow-outcome-audit-v1',
    generatedAt:new Date().toISOString(),windowUTC:window,
    scope:'OWNER_PEPPERSTONE_DEMO_USD_CLOSED',closedTrades:rows.length,
    authority:'RESEARCH_ONLY',modifiesExecution:false,
    byFirstShadowType:Object.fromEntries(TYPES.map(type=>[type,cohort(rows,type)])),
    limitations:[
      'Only first recommendations recorded before broker closure are counted.',
      'Observed mark is a snapshot, NOT a tradable close fill or verified counterfactual profit.',
      'Actual net comes from booked gross, commission and swap; hypothetical improvement is not asserted.',
      'Cost-evidence mark is conservatively reduced by an extra closing reserve when available.',
      'Shadow candidate may be followed by eventual take-profit winner; do not promote without prospective holdout.',
      'Nothing changes trade routing, broker orders, strategy, session, size or stop.' ]};
}
const sqlParts=[
  'SELECT t.id,t.opened_at,t.closed_at,t.realised_pnl,t.commission,t.swap,',
  "CASE WHEN legacy.created_at IS NULL THEN NULL ELSE jsonb_build_object('created_at',legacy.created_at,'metadata',legacy.metadata) END AS \"LEGACY_FIRST_CROSSING\",",
  "CASE WHEN high.created_at IS NULL THEN NULL ELSE jsonb_build_object('created_at',high.created_at,'metadata',high.metadata) END AS \"HIGH_PEAK_CONFIRMED\",",
  "CASE WHEN rescue.created_at IS NULL THEN NULL ELSE jsonb_build_object('created_at',rescue.created_at,'metadata',rescue.metadata) END AS \"PEAK_TO_LOSS_RESCUE\"",
  'FROM trading.trades t JOIN broker.broker_connections b ON b.id=t.broker_connection_id',
  'LEFT JOIN LATERAL (SELECT a.created_at,a.metadata FROM audit.audit_logs a',
  "WHERE a.resource_id=t.id::text AND a.action='DEMO_ALTERNATIVE_PROFIT_LOCK_SHADOW'",
  "AND a.metadata->>'hypotheticalAction'='WOULD_CLOSE'",
  'AND a.created_at>=t.opened_at AND a.created_at<t.closed_at ORDER BY a.created_at,a.id LIMIT 1) legacy ON TRUE',
  'LEFT JOIN LATERAL (SELECT a.created_at,a.metadata FROM audit.audit_logs a',
  "WHERE a.resource_id=t.id::text AND a.action='DEMO_ALTERNATIVE_PROFIT_LOCK_SHADOW'",
  "AND a.metadata->>'hypotheticalAction'='WOULD_CLOSE_HIGH_PEAK_REVERSAL_AFTER_COSTS'",
  'AND a.created_at>=t.opened_at AND a.created_at<t.closed_at ORDER BY a.created_at,a.id LIMIT 1) high ON TRUE',
  'LEFT JOIN LATERAL (SELECT a.created_at,a.metadata FROM audit.audit_logs a',
  "WHERE a.resource_id=t.id::text AND a.action='DEMO_ALTERNATIVE_PROFIT_LOCK_SHADOW'",
  "AND a.metadata->>'hypotheticalAction'='WOULD_CLOSE_PEAK_TO_LOSS_RESCUE'",
  'AND a.created_at>=t.opened_at AND a.created_at<t.closed_at ORDER BY a.created_at,a.id LIMIT 1) rescue ON TRUE',
  "WHERE t.user_id=$1 AND b.user_id=$1 AND b.broker_id='pepperstone-ctrader'",
  "AND b.account_type='DEMO' AND b.deleted_at IS NULL",
  "AND t.account_currency='USD' AND t.status='CLOSED'",
  'AND t.closed_at>=$2::timestamptz AND t.closed_at<$3::timestamptz',
  'ORDER BY t.closed_at,t.id LIMIT 2001'
];
const SQL=sqlParts.join(' ');
async function audit(client,userId,from,to) {
  if(!UUID.test(userId||''))throw Error('INVALID_OWNER_SCOPE');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='40000ms'");
    const rows=(await client.query(SQL,[userId,from,to])).rows;
    if(rows.length>2000)throw Error('CLOSED_TRADES_TRUNCATED');
    await client.query('COMMIT');
    return analyze(rows,{from,to});
  }catch(e){await client.query('ROLLBACK');throw e;}
}
async function main() {
  require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||resolve(__dirname,'../.env'),quiet:true});
  const {Client}=require('pg');
  const {getDatabaseSslOptions}=require('../dist/config/database-tls');
  const to=new Date(),from=new Date(to.getTime()-10*86400000);
  const c=new Client({host:process.env.DB_HOST||'localhost',
    port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME||'irexpro_dev',
    user:process.env.DB_USER||'irexpro',password:process.env.DB_PASSWORD,
    ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    application_name:'irexpro-first-shadow-outcome-readonly'});
  try{
    await c.connect();
    const report=await audit(c,process.env.VPS_FOREX_SCANNER_USER_ID,from.toISOString(),to.toISOString());
    mkdirSync(resolve(OUT,'..'),{recursive:true,mode:0o700});
    writeFileSync(OUT,JSON.stringify(report,null,2),{mode:0o600});
    console.log('FIRST_SHADOW_OUTCOMES',JSON.stringify(report));
  }finally{await c.end();}
}
module.exports={num,cohort,analyze,SQL};
if(require.main===module)main().catch(e=>{
  console.error('FIRST_SHADOW_AUDIT_FAILED',e.message);
  process.exitCode=1;
});
