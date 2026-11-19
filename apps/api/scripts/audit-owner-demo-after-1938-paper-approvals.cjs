#!/usr/bin/env node
'use strict';
/**
 * Owner-only USD DEMO missed-signal research. Paper-admitted but NOT executed
 * after the last trade, evaluated on strictly later native completed M1 bars.
 * This is NOT a broker-fill backtest. No database writes, model changes,
 * trade authority, stop changes, or LIVE permissions.
 */
const path=require('node:path'),fs=require('node:fs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SINCE='2026-11-19T19:38:00.000Z';
const OUT='/home/lightworld/webapps/irexpro-research/entry-formation/after-1938-paper-admitted-shadow.json';
const SOURCE='ctrader-broker-native';
const toMs=x=>x==null?null:Number.isFinite(new Date(x).getTime())?new Date(x).getTime():null;
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
function validOutcomeCandle(x,asOf){
 const time=toMs(x.timestamp),last=toMs(x.last_positive_sample_at);
 return x.source===SOURCE&&x.timeframe==='M1'&&time!==null&&last!==null&&
 time+60000<=toMs(asOf)&&
 last>=time&&last<time+60000&&
 num(x.sample_count)>=2&&num(x.positive_quote_sample_count)>=2&&
 num(x.bid_close)>0&&num(x.ask_close)>num(x.bid_close)&&
 [x.open,x.high,x.low,x.close].every(y=>num(y)>0)&&
 num(x.high)>=Math.max(num(x.open),num(x.close))&&
 num(x.low)<=Math.min(num(x.open),num(x.close));
}
function distinctEpisodes(rows){
 const sorted=[...rows].sort((a,b)=>toMs(a.evaluated_at)-toMs(b.evaluated_at));
 const last=new Map(),out=[];
 for(const row of sorted){
  const t=toMs(row.evaluated_at),key=[row.broker_connection_id,row.instrument,row.direction].join('/');
  if(t===null)continue;
  if(last.has(key)&&t-last.get(key)<16*60000)continue;
  last.set(key,t);out.push(row);
 }
 return out;
}
function summarize(rows){
 const eligible=rows.filter(x=>x.outcome==='TP'||x.outcome==='SL'||x.outcome==='MTM');
 const total=eligible.reduce((s,x)=>s+x.estimatedNetR,0);
 return {candidates:rows.length,completeQuoteOutcomes:eligible.length,
  quotesUnavailable:rows.filter(x=>x.outcome==='NO_COMPLETE_NATIVE_BARS').length,
  unknownCost:rows.filter(x=>x.outcome==='UNVERIFIED_COST_PROVENANCE').length,
  ambiguousBars:rows.filter(x=>x.outcome==='AMBIGUOUS').length,
  positiveNetQuoteLabels:eligible.filter(x=>x.estimatedNetR>0).length,
  negativeNetQuoteLabels:eligible.filter(x=>x.estimatedNetR<0).length,
  meanEstimatedNetR:eligible.length?Number((total/eligible.length).toFixed(4)):null,
  sumEstimatedNetR:eligible.length?Number(total.toFixed(4)):null,
  actualBrokerFills:0,grantsExecutionAuthority:false};
}
async function audit(db,owner,asOf=new Date()){
 if(!UUID.test(owner||''))throw Error('OWNER_SCOPE_REQUIRED');
 if(toMs(asOf)==null)throw Error('ASOF_REQUIRED');
 const {evaluateM1CausalOutcome15m}=require('../dist/modules/ai/m1-causal-outcome.js');
 await db.query('BEGIN READ ONLY');
 try {
  await db.query("SET LOCAL statement_timeout='18000ms'");
  const query=[
   'SELECT d.evaluated_at,d.broker_connection_id,d.instrument,d.direction,d.route,d.blockers,d.candidate,',
   "d.governance->'multimodelEnsemble' AS ensemble,",
   "d.governance->'multimodelGovernance' AS gov",
   'FROM trading.m1_tactical_decisions d',
   'JOIN broker.broker_connections bc ON bc.id=d.broker_connection_id',
   "AND bc.user_id=d.user_id AND bc.broker_id='pepperstone-ctrader'",
   "AND bc.account_type='DEMO' AND bc.account_currency='USD'",
   "WHERE d.user_id=$1 AND d.evaluated_at>=$2::timestamptz",
   'AND d.evaluated_at<$3::timestamptz',
   "AND d.execution_authority='NONE'",
   "AND d.governance->'multimodelEnsemble'->>'paperAdmitted'='true'",
   'ORDER BY d.evaluated_at ASC,d.id ASC LIMIT 201',
  ].join(' ');
  const matched=(await db.query(query,[owner,SINCE,asOf.toISOString()])).rows;
  if(matched.length>200)throw Error('CANDIDATE_SOURCE_TRUNCATED');
  const sampled=distinctEpisodes(matched);
  const barsByPair=new Map();
  if(sampled.length){
   const pairs=[...new Set(sampled.map(x=>x.instrument))];
   const connections=[...new Set(sampled.map(x=>x.broker_connection_id))];
   const start=new Date(Math.min(...sampled.map(x=>toMs(x.evaluated_at)))+60000);
   const bars=(await db.query([
    'SELECT p.connection_id,p.instrument,p.timeframe,p.bucket_time AS timestamp,',
    'p.open,p.high,p.low,p.close,p.source,p.sample_count,',
    'p.positive_quote_sample_count,p.last_positive_sample_at,p.bid_close,p.ask_close',
    'FROM market_data.provider_quote_candles p',
    'JOIN broker.broker_connections bc ON bc.id=p.connection_id',
    "AND bc.user_id=$1 AND bc.broker_id='pepperstone-ctrader'",
    "AND bc.account_type='DEMO' AND bc.account_currency='USD'",
    "WHERE p.source='ctrader-broker-native' AND p.timeframe='M1'",
    'AND p.connection_id=ANY($2::uuid[]) AND p.instrument=ANY($3::text[])',
    'AND p.bucket_time >= $4::timestamptz',
    'AND p.bucket_time < $5::timestamptz',
    'ORDER BY p.connection_id,p.instrument,p.bucket_time LIMIT 2501',
   ].join(' '),[owner,connections,pairs,start.toISOString(),asOf.toISOString()])).rows;
   if(bars.length>2500)throw Error('CANDLE_SOURCE_TRUNCATED');
   for(const b of bars) {
    const pairKey=[b.connection_id,b.instrument].join('/');
    if(!barsByPair.has(pairKey))barsByPair.set(pairKey,[]);
    barsByPair.get(pairKey).push(b);
   }
  }
  const events=sampled.map(r=>{
   const base={decisionAt:new Date(r.evaluated_at).toISOString(),instrument:r.instrument,
    direction:r.direction,m1Route:r.route,planBRoute:r.ensemble?.strategyRoute,
    originalBlockers:r.blockers,originalPlanBAdmitted:true,
    originalNetExpectedR:num(r.gov?.netExpectedR),
    quoteOutcomeIsNotBrokerFill:true};
   const cost=num(r.gov?.estimatedExecutionCostR),entry=num(r.candidate?.entry),
    stop=num(r.candidate?.stopLoss),target=num(r.candidate?.takeProfit);
   const s=r.direction==='BUY'?1:-1;
   const stopDistance=entry==null||stop==null?null:s*(entry-stop);
   const targetDistance=entry==null||target==null?null:s*(target-entry);
   if(r.gov?.executionCostSource!=='BROKER_OBSERVED_P90'||!r.gov?.executionSpreadEvidenceValid||
      cost===null||cost<0||stopDistance===null||targetDistance===null||
      stopDistance<=0||targetDistance<=0)
    return {...base,outcome:'UNVERIFIED_COST_PROVENANCE'};
   const rows=(barsByPair.get([r.broker_connection_id,r.instrument].join('/'))||[])
    .filter(b=>validOutcomeCandle(b,asOf));
   const outcome=evaluateM1CausalOutcome15m({
    direction:r.direction,evaluatedAt:new Date(r.evaluated_at),
    stopDistance,targetDistance,executionCostR:cost,bars:rows});
   if(!outcome)return {...base,outcome:'NO_COMPLETE_NATIVE_BARS'};
   return {...base,outcome:outcome.outcome,
    entryBarOpenTime:outcome.entryBarOpenTime,
    observedAt:outcome.observedAt,estimatedCostR:Number(cost.toFixed(4)),
    grossQuoteR:outcome.grossRMultiple,
    estimatedNetR:outcome.netRMultiple,
    hypotheticalBrokerFillVerified:false,
    assumption:'NEXT_COMPLETED_M1_OPEN_AS_HYPOTHETICAL_ENTRY_NO_SLIPPAGE',
   };
  });
  await db.query('ROLLBACK');
  return {
   artifact:'owner-demo-after-1938-unexecuted-admitted-15m-quote-research-v1',
   asOf:asOf.toISOString(),scope:'OWNER_PEPPERSTONE_USD_DEMO_ONLY',
   sourceWindowStart:SINCE,
   rawPaperAdmittedBlockedDecisions:matched.length,
   independent16mSymbolSideEpisodes:sampled.length,
   quoteOutcomes:summarize(events),examples:events,
   researchOnly:true,modifiesExecution:false,
   caveats:[
    'All event features and original blockers are from prior saved decisions; future bars are used exclusively as retrospective outcome labels.',
    'One earliest qualifying record per 16-minute instrument/side episode minimizes duplication but does not make events independent.',
    '15-minute completed OHLC TP and SL outcomes are hypothetical, and ambiguous same-bar barrier touches have no winner label.',
    'Estimated cost uses decision-time broker-observed P90 spread; actual fills, commissions, slippage, volume availability and live stops are NOT verified.',
    'A positive estimated quote outcome cannot establish the signal would have been executable or profitable as a real trade.',
   ],
  };
 } catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'..','.env'),quiet:true});
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:+(process.env.DB_PORT||5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  statement_timeout:19000,connectionTimeoutMillis:7000});
 await db.connect();
 try{
  const report=await audit(db,process.env.VPS_FOREX_SCANNER_USER_ID,new Date());
  fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
  fs.writeFileSync(OUT,JSON.stringify(report,null,2),{mode:0o600});
  console.log('OWNER_BLOCKED_ADMITTED_QUOTES',JSON.stringify(report));
 }finally{await db.end()}
}
module.exports={validOutcomeCandle,distinctEpisodes,summarize,audit};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_PAPER_SHADOW_AUDIT_FAILED',e.message);process.exitCode=1;
});
