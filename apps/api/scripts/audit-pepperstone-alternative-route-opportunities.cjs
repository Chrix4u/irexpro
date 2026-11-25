'use strict';
const fs=require('node:fs'),path=require('node:path');
const MS=60000,HORIZONS=[3,5,10,15];
const ROUTES=new Set(['CONFIRMED_REVERSAL','EARLY_TRANSITION']);
const PAIRS=new Set(['AUDUSD','EURUSD','GBPUSD','USDCHF','USDJPY','USDCAD']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const n=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const time=x=>new Date(x).getTime();
const round=(x,d=3)=>Number(x.toFixed(d));
const pip=pair=>pair.endsWith('JPY')?0.01:0.0001;
function validQuote(q){
 if(!q || typeof q!=='object')return false;
 const stamp=time(q.bucket_time),observed=time(q.last_quote_sample_at);
 const bid=n(q.bid_close),ask=n(q.ask_close);
 return Number.isFinite(stamp)&&Number.isFinite(observed)&&observed>=stamp &&
 observed<stamp+MS&&q.source==='ctrader-broker-native'&&
 n(q.positive_quote_sample_count)>0&&bid>0&&ask>bid;
}
function selectLeaders(rows,mode){
 const last=new Map(),chosen=[];
 for(const d of [...rows].sort((a,b)=>time(a.evaluated_at)-time(b.evaluated_at))){
  if(!PAIRS.has(d.instrument)||!ROUTES.has(d.planb_route)||
   !['BUY','SELL'].includes(d.direction)||
   d.planb_admitted!=='true'||d.governance_eligible!=='true')continue;
  const moment=time(d.evaluated_at),key=mode==='EXCLUSIVE_PAIR'?
   d.instrument:d.instrument+'|'+d.planb_route;
  if(!Number.isFinite(moment)||moment<(last.get(key)??-Infinity)+15*MS)continue;
  last.set(key,moment);chosen.push(d);
 }
 return chosen;
}
function mark(d,book,h){
 const enteredAt=Math.floor(time(d.evaluated_at)/MS)*MS+MS;
 const pair=book.get(d.instrument)||new Map();
 const first=pair.get(enteredAt),last=pair.get(enteredAt+h*MS);
 if(!validQuote(first)||!validQuote(last))return {state:'UNOBSERVABLE_QUOTE_GAP'};
 const buy=d.direction==='BUY';
 const entry=n(buy?first.ask_close:first.bid_close);
 const exit=n(buy?last.bid_close:last.ask_close);
 if(!(entry>0&&exit>0))return {state:'UNOBSERVABLE_BAD_PRICE'};
 const sign=buy?1:-1,step=pip(d.instrument);
 const conversion=d.instrument.endsWith('USD')?1:1/exit;
 const oneLotGrossUsd=sign*(exit-entry)*100000*conversion;
 const onePipUsd=100000*step*conversion;
 const commissionUsd=6,slippagePips=0.2;
 const afterCostsUsd=oneLotGrossUsd-commissionUsd-slippagePips*onePipUsd;
 return {state:'FIXED_HOLD_BROKER_QUOTE_PROXY',
  netPips:round(afterCostsUsd/onePipUsd),grossPips:round(sign*(exit-entry)/step),
  netUSDPerStandardLot:round(afterCostsUsd,2),
  quoteAt:new Date(enteredAt+h*MS).toISOString(),
  entryQuoteAt:new Date(first.last_quote_sample_at).toISOString(),
  exitQuoteAt:new Date(last.last_quote_sample_at).toISOString(),
  stopFirst:'NOT_VERIFIED',
 };
}
function summarize(leaders,book){
 const byRoute={},byHorizon={},cases=[];
 const accumulate=(slot,mark)=>{
  slot.selected++;
  if(mark.state!=='FIXED_HOLD_BROKER_QUOTE_PROXY'){slot.missing++;return;}
  slot.observed++;
  slot.positive+=mark.netPips>0?1:0;
  slot.negative+=mark.netPips<0?1:0;
  slot.netPips+=mark.netPips;
 };
 const slot=()=>({selected:0,observed:0,positive:0,negative:0,missing:0,netPips:0});
 for(const d of leaders){
  const s=byRoute[d.planb_route]??={episodes:0,horizons:{}};
  s.episodes++;const marks={};
  for(const h of HORIZONS){
   const k=String(h),m=mark(d,book,h);
   marks[k]=m;
   accumulate(s.horizons[k]??=slot(),m);
   accumulate(byHorizon[k]??=slot(),m);
  }
  cases.push({
   instrument:d.instrument,direction:d.direction,route:d.planb_route,
   evaluatedAt:new Date(d.evaluated_at).toISOString(),
   m1Route:d.m1_route,blockers:d.blockers,
   stopDistance:n(d.stop_distance),targetDistance:n(d.target_distance),
   marks,
  });
 }
 for(const group of [byHorizon,...Object.values(byRoute).map(x=>x.horizons)])
  for(const s of Object.values(group)){
   s.netPips=round(s.netPips,2);
   s.avgNetPips=s.observed?round(s.netPips/s.observed):null;
  }
 return {selected:leaders.length,byRoute,byHorizon,cases};
}
const scopeSQL=[
 'SELECT s.broker_connection_id AS id FROM trading.trading_sessions s',
 'JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id',
 "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 'AND b.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 1',
].join(' ');
const decisionsSQL=[
 'SELECT d.instrument,d.direction,d.evaluated_at,d.route AS m1_route,d.blockers,',
 "d.governance #>> '{multimodelEnsemble,strategyRoute}' AS planb_route,",
 "d.governance #>> '{multimodelEnsemble,paperAdmitted}' AS planb_admitted,",
 "d.governance #>> '{multimodelGovernance,paperExecutionEligible}' AS governance_eligible,",
 "d.candidate->>'stopDistance' AS stop_distance,",
 "d.candidate->>'targetDistance' AS target_distance",
 'FROM trading.m1_tactical_decisions d',
 'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
 'AND d.evaluated_at >= $3::timestamptz AND d.evaluated_at < $4::timestamptz',
 "AND d.governance #>> '{multimodelEnsemble,strategyRoute}'",
 "IN ('CONFIRMED_REVERSAL','EARLY_TRANSITION')",
 'ORDER BY d.evaluated_at ASC LIMIT 3000',
].join(' ');
const quotesSQL=[
 'SELECT instrument,bucket_time,last_quote_sample_at,bid_close,ask_close,',
 'source,positive_quote_sample_count FROM market_data.provider_quote_candles',
 "WHERE connection_id=$1 AND timeframe='M1'",
 "AND source='ctrader-broker-native' AND positive_quote_sample_count>0",
 'AND bucket_time >= $2::timestamptz AND bucket_time < $3::timestamptz',
 'ORDER BY instrument,bucket_time'
].join(' ');
async function run(db,userId,now=new Date()){
 if(!UUID.test(userId||''))throw Error('OWNER_SCOPE_INVALID');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='25000ms'");
  const session=(await db.query(scopeSQL,[userId])).rows[0];
  if(!session)throw Error('OWNER_PEPPERSTONE_DEMO_UNVERIFIED');
  const start='2026-11-16T00:00:00.000Z';
  const through=new Date(now.getTime()-19*MS).toISOString();
  const decisions=(await db.query(decisionsSQL,[userId,session.id,start,through])).rows;
  if(decisions.length===3000)throw Error('DECISIONS_TRUNCATED');
  const quotes=(await db.query(quotesSQL,[session.id,start,now.toISOString()])).rows;
  await db.query('COMMIT');
  const book=new Map();
  for(const q of quotes){
   if(!validQuote(q))continue;
   if(!book.has(q.instrument))book.set(q.instrument,new Map());
   book.get(q.instrument).set(time(q.bucket_time),q);
  }
  return {
   artifact:'pepperstone-reversal-early-transition-broker-marks-v1',
   generatedAt:now.toISOString(),from:start,through,
   source:'OWNER_PEPPERSTONE_CTRADER_USD_DEMO_NATIVE_M1',
   executionAuthority:'NONE',modifiesTrading:false,
   rawAlternativeDecisionRows:decisions.length,quotedM1Rows:quotes.length,
   estimatedRoundTripCommissionUsdPerStandardLot:6,
   slippageAllowancePips:0.2,
   limitations:[
    'Virtual bid/ask fixed-hold marks only, NOT executable fills or realized P&L.',
    'Entry uses last sampled quote in next M1 candle, not signal-time executable price.',
    'No stop-loss or take-profit first-touch; a virtual trade could stop out sooner.',
    'Fixed 1-standard-lot normalized returns are not authorized sizing.',
    'Chronological non-overlapping first-signal selection, single trading day and correlated strategies.',
    'Actual broker commission/slippage and real order market impact can differ.',
    'Ensemble admission does not grant broker-native execution authority.'
   ],
   cohorts:{
    separateRoutes:summarize(selectLeaders(decisions,'ROUTE'),book),
    onePositionPerInstrument:summarize(selectLeaders(decisions,'EXCLUSIVE_PAIR'),book),
   }
  };
 }catch(e){try{await db.query('ROLLBACK')}catch{}throw e;}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
  password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-alternate-broker-mark-research-only',
  connectionTimeoutMillis:10000,query_timeout:30000});
 try{
  await db.connect();const report=await run(db,process.env.VPS_FOREX_SCANNER_USER_ID);
  const dir='/home/lightworld/webapps/irexpro-research/alternative-route-opportunities';
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const target=path.join(dir,'latest-report.json'),tmp=target+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(report,null,2),{mode:0o600});
  fs.renameSync(tmp,target);
  console.log('ALTERNATIVE_BROKER_MARK_AUDIT',JSON.stringify({
   at:report.generatedAt,through:report.through,
   raw:report.rawAlternativeDecisionRows,quoteRows:report.quotedM1Rows,
   perRoute:report.cohorts.separateRoutes.byRoute,
   oneInstrument:report.cohorts.onePositionPerInstrument.byHorizon,
  }));
 }finally{await db.end();}
}
module.exports={ARTIFACT:'pepperstone-reversal-early-transition-broker-marks-v1',
 validQuote,selectLeaders,mark,summarize,run};
if(require.main===module)main().catch(e=>{
 console.error('ALTERNATIVE_BROKER_MARK_AUDIT_FAILED',String(e.message).slice(0,220));
 process.exitCode=1;
});
