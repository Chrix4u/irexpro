#!/usr/bin/env node
'use strict';
/**
 * iRexPro's 04/11/2026 "Wednesday champion" comparison.
 * This is NOT a strategy backtest and cannot grant execution.
 * All dates are UTC/Ghana explicit with Z; database session timezone
 * is not necessarily UTC. Never sum different account currencies.
 */
const path=require('node:path'),fs=require('node:fs');
const ARTIFACT='irexpro-20261104-vs-current-broker-net-v1';
const WINDOWS=Object.freeze([
 {key:'nov04',from:'2026-11-04T00:00:00Z',to:'2026-11-05T00:00:00Z',
  broker:'ctrader',currency:'EUR'},
 {key:'nov04_to_nov09',from:'2026-11-04T00:00:00Z',to:'2026-11-10T00:00:00Z',
  broker:'ctrader',currency:'EUR'},
 {key:'nov10_to_nov12',from:'2026-11-10T00:00:00Z',to:'2026-11-13T00:00:00Z',
  broker:'pepperstone-ctrader',currency:'USD'},
]);
const QUERY=`
SELECT t.id,t.instrument,t.direction,t.created_at,t.closed_at,t.lot_size,
 t.realised_pnl,t.commission,t.swap,t.account_currency,
 b.broker_id, b.account_type,
 ti.strategy_code,ti.model_version,
 ti.metadata->>'multimodel_execution_authority_path' AS authority,
 ti.metadata->>'multimodel_plan_b_route' AS planb_route
FROM trading.trades t
JOIN broker.broker_connections b ON b.id=t.broker_connection_id
 AND b.user_id=t.user_id
LEFT JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
 AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id
WHERE t.user_id=$1 AND t.created_at >= $2::timestamptz
 AND t.created_at < $3::timestamptz
 AND b.broker_id=$4 AND b.account_type='DEMO'
 AND t.account_currency=$5 AND t.status='CLOSED'
ORDER BY t.created_at,t.id LIMIT 501
`;
function decimal(x){
 if(x===null||x===undefined||x==='')return null;
 const n=Number(x);
 return Number.isFinite(n)?n:null;
}
const round=n=>Number(n.toFixed(2));
function normalize(rows,currency,broker){
 const ids=new Set(),priced=[],incomplete=[];
 for(const row of rows){
  if(!row.id||ids.has(row.id)||
    row.account_currency!==currency||row.broker_id!==broker||
    row.account_type!=='DEMO')throw Error('INVALID_OR_MIXED_BROKER_ACCOUNT');
  ids.add(row.id);
  const gross=decimal(row.realised_pnl),commission=decimal(row.commission),
   swap=decimal(row.swap),lots=decimal(row.lot_size);
  if(lots===null||lots<=0)throw Error('INVALID_LOT_SIZE');
  const entry={instrument:row.instrument,direction:row.direction,
   route:row.planb_route||'UNKNOWN_ROUTE',
   authority:row.authority||'UNKNOWN_AUTHORITY',strategy:row.strategy_code,
   modelVersion:row.model_version,lots,
   date:new Date(row.created_at).toISOString().slice(0,10)};
  if(gross===null||commission===null||swap===null){
   incomplete.push(entry);continue;
  }
  priced.push({...entry,gross,fees:commission+swap,net:gross+commission+swap});
 }
 return {priced,incomplete};
}
function summary(rows){
 let gross=0,fees=0,net=0,wins=0,winSum=0,lossSum=0,lotSum=0;
 const days=new Set(),models=new Set();
 for(const x of rows){
  gross+=x.gross;fees+=x.fees;net+=x.net;lotSum+=x.lots;
  days.add(x.date);
  if(x.modelVersion)models.add(x.modelVersion);
  if(x.net>0){wins++;winSum+=x.net}
  else if(x.net<0)lossSum-=x.net;
 }
 return {
  n:rows.length,distinctTradeDays:days.size,netWinners:wins,
  winRate:rows.length?Number((wins/rows.length).toFixed(4)):null,
  gross:round(gross),fees:round(fees),net:round(net),
  totalLots:round(lotSum),averageLot:rows.length?Number((lotSum/rows.length).toFixed(3)):null,
  netPerTradedLot:lotSum?round(net/lotSum):null,
  netProfitFactor:lossSum?Number((winSum/lossSum).toFixed(3)):null,
  modelVersions:[...models].sort(),
 };
}
function groups(rows,by){
 const m=new Map();
 for(const t of rows){
  const k=by(t);
  if(!m.has(k))m.set(k,[]);
  m.get(k).push(t);
 }
 return Object.fromEntries([...m].sort(([a],[b])=>a.localeCompare(b))
  .map(([k,v])=>[k,summary(v)]));
}
function reportWindows(data){
 const result={artifact:ARTIFACT,mode:'READ_ONLY_NO_BROKER_AUTHORITY',
  actualOrderChanges:false,modelPromotion:false,reportByPeriod:{},
  warning:'Different broker, currency, leverage/exposure and market days: do not compare EUR and USD dollar totals as matched strategy performance.'};
 for(const w of WINDOWS){
  const src=data[w.key]||[];
  const {priced,incomplete}=normalize(src,w.currency,w.broker);
  result.reportByPeriod[w.key]={
   from:w.from,to:w.to,currency:w.currency,broker:w.broker,
   dataQuality:{rows:src.length,fullyPriced:priced.length,unpriced:incomplete.length},
   total:summary(priced),
   byAuthority:groups(priced,x=>x.authority),
   byAuthorityAndRoute:groups(priced,x=>[x.authority,x.route].join('/')),
   byPairSide:groups(priced,x=>[x.instrument,x.direction].join('/')),
   byDay:groups(priced,x=>x.date),
  };
 }
 return result;
}
async function run(db,userId){
 if(!/^[0-9a-f-]{36}$/i.test(userId||''))throw Error('OWNER_ID_REQUIRED');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='12s'");
  const data={};
  for(const w of WINDOWS){
   const r=await db.query(QUERY,[userId,w.from,w.to,w.broker,w.currency]);
   if(r.rows.length>500)throw Error('TRUNCATED_HISTORICAL_WINDOW');
   data[w.key]=r.rows;
  }
  const report=reportWindows(data);
  if(report.reportByPeriod.nov04.total.n===0 ||
     report.reportByPeriod.nov04_to_nov09.total.n===0 ||
     report.reportByPeriod.nov10_to_nov12.total.n===0)
   throw Error('HISTORICAL_ACCOUNT_COVERAGE_INCOMPLETE');
  await db.query('COMMIT');
  return report;
 }catch(e){await db.query('ROLLBACK');throw e}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  statement_timeout:12000,connectionTimeoutMillis:6000,
  application_name:'irexpro-nov4-historical-parity-readonly'});
 try{
  await db.connect();
  const report=await run(db,process.env.VPS_FOREX_SCANNER_USER_ID);
  const file='/home/lightworld/webapps/irexpro-research/nov04-legacy-comparison/latest.json';
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file,JSON.stringify(report,null,2),{mode:0o600});
  console.log('NOV04_LEGACY_MODEL_COMPARISON '+JSON.stringify(report));
 }finally{await db.end()}
}
module.exports={ARTIFACT,WINDOWS,QUERY,decimal,normalize,summary,groups,reportWindows,run};
if(require.main===module)main().catch(e=>{
 console.error('NOV04_LEGACY_MODEL_COMPARISON_FAILED',e.code||'',String(e.message).slice(0,220));
 process.exitCode=1;
});
