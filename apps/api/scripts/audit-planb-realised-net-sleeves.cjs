'use strict';

/**
 * Broker-realized net profitability by primary Plan B pair/side/route.
 * Manual, read-only research; NEVER consulted by entry or exit authorization.
 */
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

const ARTIFACT = 'planb-realised-net-by-sleeve-readonly-v1';
const MAX_TRADES = 3000;
const DAYS = 30;
const PRIVATE_REPORT =
  '/home/lightworld/webapps/irexpro-research/planb-realised-sleeves/latest-report.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_SQL = [
  'SELECT current_timestamp AS "snapshotAt" FROM broker.broker_connections',
  "WHERE id=$1 AND user_id=$2 AND broker_id='ctrader'",
  "AND account_type='DEMO' AND deleted_at IS NULL",
].join(' ');
const REALIZED_SQL = [
  'SELECT t.id, t.instrument, t.direction, t.closed_at AS "closedAt",',
  't.realised_pnl AS gross,t.commission,t.swap,',
  'i.model_version AS "modelVersion",',
  "i.metadata->>'multimodel_plan_b_route' AS route",
  'FROM trading.trades t',
  'JOIN trading.trade_intents i ON i.id=t.trade_intent_id',
  'WHERE t.user_id=$1 AND t.broker_connection_id=$2',
  "AND t.status='CLOSED' AND t.account_currency='EUR'",
  "AND i.metadata->>'multimodel_execution_authority_path'='PRIMARY_PLAN_B'",
  'AND t.closed_at >= $3::timestamptz AND t.closed_at <= $4::timestamptz',
  "AND t.instrument IN ('AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY')",
  'ORDER BY t.closed_at,t.id LIMIT $5::int',
].join('\n');

function toAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}
function rounded(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
function dayOf(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}
function canonicalRows(rows) {
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const day = dayOf(row.closedAt);
    const gross = toAmount(row.gross);
    const commission = toAmount(row.commission);
    // Broker swap may be NULL for an ordinary non-overnight position.
    const swap = row.swap === null ? 0 : toAmount(row.swap);
    if (!day || !row.id || seen.has(row.id) || gross === null ||
        commission === null || swap === null ||
        !['BUY','SELL'].includes(row.direction) ||
        !['TREND_CONTINUATION','CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(row.route) ||
        !['AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY'].includes(row.instrument)) {
      throw Error('UNRELIABLE_BROKER_REALIZED_ROW');
    }
    seen.add(row.id);
    items.push({
      id:String(row.id), instrument:row.instrument,direction:row.direction,
      route:row.route, modelVersion:String(row.modelVersion || 'UNKNOWN'),
      day, time:new Date(row.closedAt).getTime(),
      gross, commission, swap, net:gross + commission + swap,
    });
  }
  return items.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
}
function summarizeRows(rows) {
  let gross=0,commission=0,swap=0,winValue=0,lossValue=0,wins=0,
    closedEquity=0,peak=0,peakToTrough=0,lossStreak=0,maxLossStreak=0;
  const dayTotals = new Map();
  for (const row of rows) {
    gross+=row.gross;commission+=row.commission;swap+=row.swap;
    if(row.net>0){wins++;winValue+=row.net;lossStreak=0}
    else if(row.net<0){lossValue+=row.net;lossStreak++;maxLossStreak=Math.max(maxLossStreak,lossStreak)}
    else lossStreak=0;
    closedEquity+=row.net;peak=Math.max(peak,closedEquity);
    peakToTrough=Math.max(peakToTrough,peak-closedEquity);
    dayTotals.set(row.day,(dayTotals.get(row.day)||0)+row.net);
  }
  const positiveDays=[...dayTotals.values()].filter(v=>v>0).length;
  const profitableDays=dayTotals.size?positiveDays/dayTotals.size:null;
  const factor=lossValue<0?winValue/Math.abs(lossValue):null;
  const net=rounded(gross+commission+swap);
  // This is NOT a model promotion; robust, prospective gates are not computable here.
  const screeningLabel=rows.length<30||dayTotals.size<12
    ? 'INSUFFICIENT_INDEPENDENT_DAYS'
    : net<=0 || factor===null || factor<1.15 || profitableDays<0.60
      ? 'NEGATIVE_OR_WEAK_AFTER_COST_EVIDENCE'
      : 'HOLDOUT_VALIDATION_REQUIRED';
  return {
    closedTrades:rows.length,tradingDays:dayTotals.size,positiveTradingDays:positiveDays,
    winRate:rows.length?Number((wins/rows.length).toFixed(4)):null,
    grossEUR:rounded(gross),commissionEUR:rounded(commission),swapEUR:rounded(swap),
    netEUR:net,netAveragePerTradeEUR:rows.length?rounded(net/rows.length):null,
    positiveNetEUR:rounded(winValue),negativeNetEUR:rounded(lossValue),
    profitFactor:factor===null?null:Number(factor.toFixed(4)),
    positiveDayFraction:profitableDays===null?null:Number(profitableDays.toFixed(4)),
    maxConsecutiveNetLosses:maxLossStreak,
    closedPnlPeakToTroughEUR:rounded(peakToTrough),screeningLabel,
  };
}
function groupBy(rows,getKey) {
  const map={};
  for(const row of rows)(map[getKey(row)]??=[]).push(row);
  return Object.fromEntries(Object.entries(map).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,list])=>[key,summarizeRows(list)]));
}
function analyze(realized,snapshotAt) {
  const rows=canonicalRows(realized);
  const bySleeve=groupBy(rows,x=>[x.instrument,x.direction,x.route].join('/'));
  const negativeSleeves=Object.entries(bySleeve).filter(([_,x])=>x.netEUR<0)
    .sort((a,b)=>a[1].netEUR-b[1].netEUR)
    .map(([sleeve,data])=>({sleeve,...data}));
  return {
    artifact:ARTIFACT,snapshotAt:new Date(snapshotAt).toISOString(),
    scope:'USER_OWNED_CTRADER_DEMO_EUR_CLOSED_PRIMARY_PLAN_B',
    historicalWindowDays:DAYS,
    mode:'READ_ONLY',changesTradingAuthority:false,changesBrokerOrders:false,
    total:summarizeRows(rows),
    byDay:groupBy(rows,x=>x.day),
    byStrategy:groupBy(rows,x=>x.route),
    byPair:groupBy(rows,x=>x.instrument),
    bySleeve,negativeSleeves,
    limitations:[
      'Realized closed-trade net after recorded commission and swap, NOT forward model evidence.',
      'Trading days with multiple trades are correlated; screening labels are not promotion gates.',
      'Closed-P&L peak-to-trough is not broker-account-equity max drawdown or Sharpe.',
      'No unexecuted entries, intraday open positions, slippage scenarios or strategy changes are modeled.',
      'No executable route is enabled, disabled, promoted or size-adjusted by this research.',
    ],
  };
}
async function runAudit({client,userId,connectionId}){
  if(!UUID.test(userId||'')||!UUID.test(connectionId||''))throw Error('INVALID_SCOPE');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='20000ms'");
    const scope=(await client.query(OWNER_SQL,[connectionId,userId])).rows[0];
    if(!scope)throw Error('OWNER_DEMO_CTRADER_NOT_FOUND');
    const snapshot=new Date(scope.snapshotAt);
    const start=new Date(snapshot.getTime()-DAYS*86400000);
    const result=(await client.query(REALIZED_SQL,
      [userId,connectionId,start.toISOString(),snapshot.toISOString(),MAX_TRADES+1])).rows;
    if(result.length>MAX_TRADES)throw Error('TRADE_HISTORY_TRUNCATED');
    const report=analyze(result,snapshot);
    await client.query('COMMIT');
    return report;
  } catch(e) {await client.query('ROLLBACK');throw e}
}
async function main(){
  require('dotenv').config({
    path:process.env.IREXPRO_API_ENV_PATH||resolve(__dirname,'../.env'),quiet:true,
  });
  const {Client}=require('pg');
  const {getDatabaseSslOptions}=require('../dist/config/database-tls');
  const client=new Client({
    host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
    password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    connectionTimeoutMillis:10000,
    application_name:'irexpro-planb-realised-sleeves-readonly',
  });
  try {
    await client.connect();
    const report=await runAudit({client,
      userId:process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId:process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID});
    mkdirSync(resolve(PRIVATE_REPORT,'..'),{recursive:true,mode:0o700});
    writeFileSync(PRIVATE_REPORT,JSON.stringify(report,null,2),{encoding:'utf8',mode:0o600});
    console.log('PLANB_REALIZED_SLEEVES '+JSON.stringify({
      artifact:report.artifact,snapshotAt:report.snapshotAt,
      total:report.total,byStrategy:report.byStrategy,
      byPair:report.byPair,negativeSleeves:report.negativeSleeves.slice(0,8),
    }));
  }finally{await client.end()}
}
module.exports={ARTIFACT,OWNER_SQL,REALIZED_SQL,toAmount,canonicalRows,summarizeRows,analyze,runAudit};
if(require.main===module)main().catch(e=>{
  console.error('PLANB_REALIZED_SLEEVES_FAILED '+String(e?.message||'unknown').slice(0,180));
  process.exitCode=1;
});
