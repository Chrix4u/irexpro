#!/usr/bin/env node
'use strict';
/**
 * Real-time, account-isolated counterfactual for primary Plan B decisions
 * denied AFTER original primary approval by an M1 / portfolio loss brake.
 * Independent 30m episode leaders; subsequent completed M1 broker candle
 * OHLC; as-of broker commission + original estimated spread/slippage.
 * NOT executable, NOT tick-accurate SL/TP, no changes to brake governance.
 */
const fs=require('node:fs'),path=require('node:path');
const {brokerMarkNetUSD}=require('./audit-short-horizon-broker-marks.cjs');
const {evaluateM1CausalOutcome15m}=require('../dist/modules/ai/m1-causal-outcome');
const ARTIFACT='irexpro-primary-planb-downstream-brake-firsttouch-shadow-v1';
const BRAKES=Object.freeze([
 'M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE',
 'M1_MULTIMODEL_LOSS_STREAK_BRAKE',
 'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK',
 'M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED',
]);
const QUERY={
 scope:`SELECT s.user_id,s.broker_connection_id AS id,b.broker_id AS broker,
 b.account_type AS account,b.account_currency AS currency,
 b.status AS connection_status,b.authorization_status AS authorization
 FROM trading.trading_sessions s JOIN broker.broker_connections b
 ON b.id=s.broker_connection_id AND b.user_id=s.user_id
 WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
 AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
 AND b.account_currency='USD' AND b.status='CONNECTED'
 AND b.authorization_status='ACTIVE' AND b.deleted_at IS NULL
 ORDER BY s.started_at DESC LIMIT 1`,
 decisions:`SELECT d.id,d.evaluated_at AS "evaluatedAt",d.instrument,d.direction,d.route,
 d.execution_authority AS "executionAuthority",d.blockers,
 d.candidate->>'stopDistance' AS "stopDistance",
 d.candidate->>'targetDistance' AS "targetDistance",
 d.governance#>>'{multimodelEnsemble,strategyRoute}' AS "strategyRoute",
 d.governance#>>'{multimodelAuthority,authorityPath}' AS "authorityPath",
 d.governance#>>'{multimodelAuthority,executable}' AS "primaryExecutable",
 d.governance#>>'{multimodelGovernance,estimatedExecutionCostR}' AS "spreadCostR",
 d.governance#>>'{multimodelGovernance,executionSpreadEvidenceValid}' AS "spreadValid",
 d.governance#>>'{multimodelGovernance,eventRisk}' AS "eventRisk"
 FROM trading.m1_tactical_decisions d
 WHERE d.user_id=$1 AND d.broker_connection_id=$2
 AND d.evaluated_at >=$3::timestamptz AND d.evaluated_at <$4::timestamptz
 AND d.governance#>>'{multimodelAuthority,authorityPath}'='PRIMARY_PLAN_B'
 AND d.execution_authority<>'BROKER_NATIVE'
 ORDER BY d.evaluated_at,d.id LIMIT 3001`,
 quotes:`SELECT instrument,bucket_time AS timestamp,source,open,high,low,close,
 last_quote_sample_at,positive_quote_sample_count,bid_close,ask_close
 FROM market_data.provider_quote_candles
 WHERE connection_id=$1 AND timeframe='M1' AND source='ctrader-broker-native'
 AND bucket_time >=$2::timestamptz AND bucket_time <$3::timestamptz
 ORDER BY instrument,bucket_time`,
 fees:`SELECT t.closed_at AS "closedAt",t.instrument,t.lot_size AS lots,
 t.commission,t.swap
 FROM trading.trades t
 WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.status='CLOSED'
 AND t.account_currency='USD' AND t.closed_at >=$3::timestamptz
 AND t.closed_at <$4::timestamptz
 ORDER BY t.closed_at LIMIT 2001`,
};
const finite=x=>x===null||x===undefined||x===''?null:
 (Number.isFinite(Number(x))?Number(x):null);
const ms=x=>{const t=new Date(x).getTime();return Number.isFinite(t)?t:null};
const round=x=>Number(x.toFixed(4));
function hasSafeInputs(r){
 return !!r.id&&['BUY','SELL'].includes(r.direction)&&
  ['AUDUSD','EURUSD','USDCAD','USDJPY'].includes(r.instrument)&&
  ['TREND_CONTINUATION','CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(r.strategyRoute)&&
  r.authorityPath==='PRIMARY_PLAN_B'&&r.primaryExecutable==='true'&&
  r.executionAuthority!=='BROKER_NATIVE'&&Array.isArray(r.blockers)&&
  ms(r.evaluatedAt)!==null;
}
function leaders(rows){
 // First eligible decision of each contiguous 30m pair-side-strategy brake
 // cohort. Same apparent strategy with different blocker set is independent
 // only after a >=30m separation, avoiding one-minute pseudo-trade inflation.
 const prior=new Map(),out=[];
 for(const row of [...rows].sort((a,b)=>ms(a.evaluatedAt)-ms(b.evaluatedAt))){
  if(!hasSafeInputs(row))continue;
  const present=BRAKES.filter(b=>row.blockers.includes(b));
  if(!present.length)continue;
  const key=[row.instrument,row.direction,row.strategyRoute].join('/');
  const at=ms(row.evaluatedAt);
  const last=prior.get(key);
  if(last!==undefined&&at-last<30*60000)continue;
  prior.set(key,at);
  out.push({...row,brakes:present,
   // Attribution is overlap, not an assertion that lifting ONE brake
   // would make this decision executable.
   otherBlockers:row.blockers.filter(b=>!BRAKES.includes(b))});
 }
 return out;
}
function quoteEligible(q){
 const t=ms(q.timestamp),sample=ms(q.last_quote_sample_at),
  open=finite(q.open),high=finite(q.high),low=finite(q.low),
  close=finite(q.close),bid=finite(q.bid_close),ask=finite(q.ask_close);
 return q.source==='ctrader-broker-native'&&
  t!==null&&sample!==null&&sample>=t&&sample<t+60000&&
  Number(q.positive_quote_sample_count)>0&&
  open>0&&low>0&&high>=low&&open>=low&&open<=high&&
  close>=low&&close<=high&&bid>0&&ask>=bid;
}
function feeP90AsOf(fills,instrument,at){
 const a=fills.filter(f=>f.instrument===instrument&&
    ms(f.closedAt)!==null&&ms(f.closedAt)<at &&
    ms(f.closedAt)>=at-21*86400000&&
    finite(f.lots)>0&&finite(f.commission)!==null&&finite(f.swap)!==null&&
    finite(f.commission)<=0)
  .slice(-40)
  .map(f=>(-Number(f.commission)+Math.max(0,-Number(f.swap)))/Number(f.lots))
  .filter(x=>Number.isFinite(x)&&x>=0);
 if(a.length<3)return null;
 const sorted=a.sort((a,b)=>a-b);const position=.9*(sorted.length-1);
 const lo=Math.floor(position),hi=Math.ceil(position);
 return sorted[lo]+(sorted[hi]-sorted[lo])*(position-lo);
}
function score(row,quotes,fees,now){
 const t=ms(row.evaluatedAt),stop=finite(row.stopDistance),
  target=finite(row.targetDistance),spread=finite(row.spreadCostR);
 if(t===null||t+17*60000>now)return {state:'HORIZON_NOT_MATURE'};
 if(!(stop>0&&target>0&&spread>=0&&spread<=3)||
    row.spreadValid!=='true'||row.eventRisk!=='CLEAR')
  return {state:'UNSAFE_OR_MISSING_ORIGINAL_EXECUTION_GEOMETRY'};
 const fee=feeP90AsOf(fees,row.instrument,t);
 if(fee===null)return {state:'INSUFFICIENT_PRIOR_SAME_PAIR_BROKER_FEES'};
 const candidate=quotes.filter(q=>ms(q.timestamp)>=t+60000&&
  ms(q.timestamp)<t+16*60000);
 if(candidate.length!==15||candidate.some(q=>!quoteEligible(q)))
  return {state:'MISSING_15_CONSECUTIVE_VERIFIED_BROKER_CANDLES',
   verifiedCount:candidate.filter(quoteEligible).length};
 const entry=Number(candidate[0].open),
  opposite=row.direction==='BUY'?entry-stop:entry+stop;
 const risk=brokerMarkNetUSD({instrument:row.instrument,
  direction:row.direction,fill_price:entry,lot_size:1,
  commission:0,swap:0},opposite);
 if(!risk||risk.grossUSD>=0)return {state:'INVALID_ONE_LOT_RISK_GEOMETRY'};
 const commissionR=fee/(-risk.grossUSD),
  costR=spread+commissionR;
 if(!Number.isFinite(costR)||costR<0||costR>3)return {state:'UNSAFE_EFFECTIVE_AFTER_FEE_COST_R'};
 const result=evaluateM1CausalOutcome15m({
  direction:row.direction,evaluatedAt:new Date(t),
  stopDistance:stop,targetDistance:target,executionCostR:costR,
  bars:candidate,
 });
 if(!result)return {state:'INCOMPLETE_BAR_PATH'};
 if(result.outcome==='AMBIGUOUS')return {state:'SAME_MINUTE_STOP_TARGET_AMBIGUOUS'};
 return {state:'OBSERVED_M1_MIDPOINT_PROXY',
  outcome:result.outcome,netR:result.netRMultiple,
  totalCostR:round(costR),commissionR:round(commissionR)};
}
function summarize(rows){
 const a={episodes:rows.length,observable:0,wins:0,losers:0,
  sumNetR:0,firstStop:0,firstTarget:0,markToMarket:0,missingData:0,
  unobservableByReason:{},overlappingIndependentBlockers:0,distinctUtcDays:0};
 const days=new Set();
 for(const r of rows){
  if(r.otherBlockers.length)a.overlappingIndependentBlockers++;
  const o=r.observation;
  if(o.state!=='OBSERVED_M1_MIDPOINT_PROXY'){
   a.missingData++;a.unobservableByReason[o.state]=(a.unobservableByReason[o.state]||0)+1;continue;
  }
  a.observable++;days.add(new Date(r.evaluatedAt).toISOString().slice(0,10));
  a.sumNetR+=o.netR;
  if(o.netR>0)a.wins++;else if(o.netR<0)a.losers++;
  if(o.outcome==='SL')a.firstStop++;
  if(o.outcome==='TP')a.firstTarget++;
  if(o.outcome==='MTM')a.markToMarket++;
 }
 a.sumNetR=round(a.sumNetR);a.distinctUtcDays=days.size;
 a.meanNetR=a.observable?round(a.sumNetR/a.observable):null;
 a.evidenceQualified=a.observable>=12&&days.size>=3;
 a.suggestBrakeRelaxation=false;
 return a;
}
async function audit(db,userId,from,through){
 if(!/^[0-9a-f-]{36}$/i.test(userId||'')||
  !(ms(from)<ms(through))||ms(through)-ms(from)>72*3600000||
  ms(through)>Date.now()+60000)throw Error('INVALID_OWNER_OR_BOUNDED_HISTORY');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='22000ms'");
  const scope=(await db.query(QUERY.scope,[userId])).rows[0];
  if(!scope||scope.currency!=='USD'||scope.broker!=='pepperstone-ctrader')
   throw Error('NO_ACTIVE_OWNER_VERIFIED_PEPPERSTONE_DEMO');
  const rows=(await db.query(QUERY.decisions,[userId,scope.id,from,through])).rows;
  if(rows.length>3000)throw Error('DECISION_HISTORY_TRUNCATED');
  const quoteThrough=new Date(ms(through)+17*60000).toISOString();
  const quotes=(await db.query(QUERY.quotes,[scope.id,from,quoteThrough])).rows;
  const fees=(await db.query(QUERY.fees,[userId,scope.id,
   new Date(ms(from)-21*86400000).toISOString(),through])).rows;
  if(fees.length>2000)throw Error('BROKER_FEE_HISTORY_TRUNCATED');
  await db.query('COMMIT');
  const byPair=new Map();
  for(const q of quotes){if(!byPair.has(q.instrument))byPair.set(q.instrument,[]);byPair.get(q.instrument).push(q)}
  const independent=leaders(rows);
  const cases=independent.map(r=>({...r,
   observation:score(r,byPair.get(r.instrument)||[],fees,ms(through))}));
  const grouped=(fn)=>{
   const keys=new Set(cases.map(fn));
   return Object.fromEntries([...keys].sort().map(k=>[k,summarize(cases.filter(r=>fn(r)===k))]));
  };
  return {
   artifact:ARTIFACT,mode:'READ_ONLY',executionAuthority:'NONE',
   eligibleToRelaxBrake:false,changesBrokerOrders:false,
   broker:scope.broker,currency:scope.currency,from,through,
   candidateDecisions:rows.length,independentEpisodeLeaders:cases.length,
   overall:summarize(cases),
   byPairSideStrategy:grouped(r=>[r.instrument,r.direction,r.strategyRoute].join('/')),
   byBrake:grouped(r=>r.brakes.sort().join('+')),
   byUTCDate:grouped(r=>new Date(r.evaluatedAt).toISOString().slice(0,10)),
   limitations:[
    'Counterfactual first future completed M1 candle open, not actual first executable bid/ask at decision time.',
    'Stops/targets from broker MIDPOINT M1 OHLC; same-minute ambiguities excluded, spread-dependent stop triggers may occur earlier.',
    'Requires 15 consecutive broker M1 minutes with positive quote evidence: missing minutes NEVER count as a win or loss.',
    'Deduplicated 30-minute episodes remain correlated; some broker-native samples reflect wider-than-typical spreads.',
    'Only past same-pair closed USD account fees inform commission; P90 as-of USD per lot.',
    'Execution spread/slippage cost from original decision; commissions added separately. Actual fills, swaps, execution latency and volume-dependent slippage may differ.',
    'Co-occurring brakes overlap; observing a hypothetical price gain does not imply removing one brake would have authorized an actual trade.',
    'No LIVE authority, no strategy promotion, no changes to broker orders, stops, cooldowns or position sizing.',
   ],
  };
 }catch(e){await db.query('ROLLBACK');throw e}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  statement_timeout:22000,connectionTimeoutMillis:6000,
  application_name:'irexpro-firsttouch-brake-counterfactual-readonly'});
 try{
  await db.connect();
  const through=process.env.IREXPRO_BRAKE_AUDIT_END||new Date().toISOString();
  const from=process.env.IREXPRO_BRAKE_AUDIT_START||
   new Date(ms(through)-72*3600000).toISOString();
  const r=await audit(db,process.env.VPS_FOREX_SCANNER_USER_ID,from,through);
  const file='/home/lightworld/webapps/irexpro-research/planb-downstream-brake/latest.json';
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file,JSON.stringify(r,null,2),{mode:0o600});
  console.log('PRIMARY_DOWNSTREAM_BRAKE_FIRSTTOUCH '+JSON.stringify(r));
 }finally{await db.end()}
}
module.exports={ARTIFACT,QUERY,BRAKES,hasSafeInputs,leaders,quoteEligible,
 feeP90AsOf,score,summarize,audit};
if(require.main===module)main().catch(e=>{
 console.error('PRIMARY_DOWNSTREAM_BRAKE_FIRSTTOUCH_FAILED',
  e.code||'',String(e.message||'UNKNOWN').slice(0,240));process.exitCode=1;
});
