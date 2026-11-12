#!/usr/bin/env node
'use strict';

/**
 * Operational source of truth for primary Plan B realised performance.
 * Uses ONLY the exact current owner-bound FULL_AUTO connected DEMO account,
 * irrespective of a stale older cTrader/EUR market-data connection.
 *
 * READ ONLY; no broker calls, order dispatch, permission updates,
 * model promotion, historical P&L writes or live execution effects.
 */
const {resolve}=require('node:path');
const {writeFileSync,mkdirSync}=require('node:fs');
const ARTIFACT='active-planb-broker-net-sleeve-audit-v1';
const REPORT='/home/lightworld/webapps/irexpro-research/active-planb-sleeves/latest.json';
const MAX_ROWS=3000;
const LOOKBACK_DAYS=21;
const SCOPE_SQL=`
SELECT ts.user_id AS "userId",ts.broker_connection_id AS "connectionId",
  bc.account_currency AS "currency",bc.broker_id AS "broker"
FROM trading.trading_sessions ts
JOIN broker.broker_connections bc ON bc.id=ts.broker_connection_id
 AND bc.user_id=ts.user_id
WHERE ts.user_id=$1 AND ts.status='ACTIVE'
 AND ts.execution_mode='FULL_AUTO'
 AND bc.status='CONNECTED' AND bc.authorization_status='ACTIVE'
 AND bc.account_type='DEMO' AND bc.deleted_at IS NULL
 AND bc.broker_id IN ('pepperstone-ctrader','ctrader','icmarkets-ctrader')
ORDER BY ts.started_at DESC LIMIT 1
`;
const TRADE_SQL=`
SELECT t.id,t.instrument,t.direction,t.closed_at AS "closedAt",
 t.realised_pnl AS gross,t.commission,t.swap,
 ti.metadata->>'multimodel_plan_b_route' AS route,
 t.account_currency AS currency
FROM trading.trades t
JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
 AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id
WHERE t.user_id=$1 AND t.broker_connection_id=$2
 AND t.status='CLOSED' AND t.closed_at IS NOT NULL
 AND t.closed_at>$3::timestamptz AND t.closed_at<=$4::timestamptz
 AND ti.metadata->>'multimodel_execution_authority_path'='PRIMARY_PLAN_B'
 ORDER BY t.closed_at,t.id LIMIT $5::int
`;
const STRATEGIES=new Set(['TREND_CONTINUATION','CONFIRMED_REVERSAL','EARLY_TRANSITION']);
const PAIRS=new Set(['EURUSD','AUDUSD','GBPUSD','USDJPY','USDCHF','USDCAD']);
function amount(v){if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null}
function rounded(n){return Number(n.toFixed(2))}
function normalized(rows,currency) {
  const priced=[],unpriced=[];const seen=new Set();
  for(const r of rows) {
    if(!r.id||seen.has(r.id)||r.currency!==currency||
      !PAIRS.has(r.instrument)||!['BUY','SELL'].includes(r.direction)||
      !STRATEGIES.has(r.route)||!Number.isFinite(new Date(r.closedAt).getTime()))
      throw Error('INVALID_REAL_BROKER_TRADE_OR_ACCOUNT_SCOPE');
    seen.add(r.id);
    const gross=amount(r.gross),commission=amount(r.commission),swap=amount(r.swap);
    const base={instrument:r.instrument,direction:r.direction,route:r.route,
      closedAt:new Date(r.closedAt),day:new Date(r.closedAt).toISOString().slice(0,10)};
    if(gross===null||commission===null||swap===null) {
      unpriced.push(base);continue;
    }
    priced.push({...base,gross,cost:commission+swap,net:gross+commission+swap});
  }
  return {priced,unpriced};
}
function stats(rows){
  let gross=0,cost=0,net=0,wins=0,grossWinners=0,netPositiveGrossNegative=0,
    lossSeries=0,maxLossSeries=0,winnerNet=0,loserNet=0;
  const days=new Set();
  for(const x of rows) {
    gross+=x.gross;cost+=x.cost;net+=x.net;
    days.add(x.day);
    if(x.gross>0)grossWinners++;
    if(x.gross>0&&x.net<=0)netPositiveGrossNegative++;
    if(x.net>0){wins++;winnerNet+=x.net;lossSeries=0}
    else if(x.net<0){loserNet+=x.net;lossSeries++;maxLossSeries=Math.max(maxLossSeries,lossSeries)}
    else lossSeries=0;
  }
  return {
    n:rows.length,days:days.size,netWins:wins,grossWins:grossWinners,
    grossWinsNonPositiveAfterCosts:netPositiveGrossNegative,
    gross:rounded(gross),brokerCosts:rounded(cost),net:rounded(net),
    avgNetPerFill:rows.length?rounded(net/rows.length):null,
    netProfitFactor:loserNet<0?rounded(winnerNet/(-loserNet)):null,
    maxConsecutiveNetLosses:maxLossSeries,
    screening:rows.length<7||days.size<3
      ?'INSUFFICIENT_DISTINCT_DAYS'
      : net<=0||winnerNet<=0||loserNet===0||winnerNet/(-loserNet)<1.15
        ?'AFTER_COST_EDGE_NOT_DEMONSTRATED'
        :'HOLDOUT_PROSPECTIVE_VALIDATION_REQUIRED',
  };
}
function grouped(rows,key){
  const groups=new Map();
  for(const r of rows){const k=key(r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r)}
  return Object.fromEntries([...groups].sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>[k,stats(v)]));
}
function reportFor(rows,scope,asOf){
  const currency=scope.currency;
  if(!currency||!/^[A-Z]{3}$/.test(currency))throw Error('INVALID_ACTIVE_ACCOUNT_CURRENCY');
  const {priced,unpriced}=normalized(rows,currency);
  const now=new Date(asOf);
  const recentCutoff=new Date(now.getTime()-7*86400000);
  return {
    artifact:ARTIFACT,generatedAt:now.toISOString(),
    broker:scope.broker,currency,
    mode:'READ_ONLY',executionAuthority:'NONE',
    changesBrokerOrders:false,changesExecution:false,
    dataQuality:{queried:rows.length,priced:priced.length,unpriced:unpriced.length,
      complete:unpriced.length===0},
    total:stats(priced),
    lastSevenDays:stats(priced.filter(x=>x.closedAt>=recentCutoff)),
    byStrategy:grouped(priced,x=>x.route),
    byPairSideStrategy:grouped(priced,x=>[x.instrument,x.direction,x.route].join('/')),
    byDay:grouped(priced,x=>x.day),
    missingCostsBySleeve:unpriced.reduce((counts,x)=>{
      const key=[x.instrument,x.direction,x.route].join('/');
      counts[key]=(counts[key]||0)+1;
      return counts;
    },{}),
    limitations:[
      'Closed actual broker P&L, with signed paid commission and swap; no open P&L or rejected candidates.',
      'Repeated fills and market days are correlated; historical winners are NOT forward validation.',
      'Do not use grouped short histories to enable, resize, reject or promote broker strategies.',
      'Distinct owner/account/current connected FULL_AUTO DEMO only; missing fees exclude a trade and flag incomplete coverage.',
      'Past trading costs and P&L do not predict future performance.',
    ],
  };
}
async function run({client,userId}){
  if(!/^[0-9a-f-]{36}$/i.test(userId||''))throw Error('INVALID_OWNER');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='12000ms'");
    const scope=(await client.query(SCOPE_SQL,[userId])).rows[0];
    if(!scope)throw Error('CONNECTED_ACTIVE_DEMO_NOT_AVAILABLE');
    if(!scope.currency||!/^[A-Z]{3}$/.test(scope.currency))throw Error('INVALID_ACTIVE_ACCOUNT_CURRENCY');
    const asOf=(await client.query('SELECT current_timestamp AS "asOf"')).rows[0].asOf;
    const time=new Date(asOf);
    if(!Number.isFinite(time.getTime()))throw Error('INVALID_CURRENT_DATABASE_TIME');
    const from=new Date(time.getTime()-LOOKBACK_DAYS*86400000);
    const rows=(await client.query(TRADE_SQL,
      [userId,scope.connectionId,from.toISOString(),time.toISOString(),MAX_ROWS+1])).rows;
    if(rows.length>MAX_ROWS)throw Error('TRUNCATED_HISTORY_REFUSE');
    const report=reportFor(rows,scope,time);
    await client.query('COMMIT');
    return report;
  }catch(e){await client.query('ROLLBACK');throw e}
}
async function main(){
  require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||resolve(__dirname,'../.env'),quiet:true});
  const{Client}=require('pg');const{getDatabaseSslOptions}=require('../dist/config/database-tls');
  const client=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    connectionTimeoutMillis:8000,application_name:'irexpro-active-planb-after-cost-readonly'});
  try{
    await client.connect();
    const report=await run({client,userId:process.env.VPS_FOREX_SCANNER_USER_ID});
    mkdirSync(resolve(REPORT,'..'),{recursive:true,mode:0o700});
    writeFileSync(REPORT,JSON.stringify(report,null,2),{encoding:'utf8',mode:0o600});
    console.log('PRIMARY_PLANB_ACTIVE_SLEEVE_AUDIT '+JSON.stringify(report));
  }finally{await client.end()}
}
module.exports={ARTIFACT,SCOPE_SQL,TRADE_SQL,amount,normalized,stats,reportFor,run};
if(require.main===module)main().catch(e=>{
  console.error('PRIMARY_PLANB_ACTIVE_SLEEVE_AUDIT_FAILED '+String(e?.message||'unknown').slice(0,160));
  process.exitCode=1;
});
