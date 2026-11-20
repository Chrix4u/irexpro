'use strict';
/**
 * Owner-only USD DEMO risk-normalized expectancy calibration.
 * Out-of-sample by entire ENTRY MARKET DAY; no same-day closed outcomes
 * enter features, even when a position closed before another one opened.
 * Fully read-only and no order/lot/strategy authority. Research only.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='irexpro-owner-demo-net-r-day-purged-walkforward-calibration-v1';
const OUT='/home/lightworld/webapps/irexpro-research/entry-calibration/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[89ab0-9a-f]{12}$/i;
const MAX_ROWS=800,MAX_LOOKBACK_DAYS=30;
const MIN_TRAIN=10,MIN_DAYS=3,SHRINK=20;
const MAX_ABS_ERROR_R=3;
const ROUTES=['EARLY_TRANSITION','CONFIRMED_REVERSAL'];
const SQL=[
 "SELECT t.id::text trade_key,t.instrument,t.direction,t.opened_at,t.closed_at,",
 "t.realised_pnl,t.commission,t.swap,t.close_reason,",
 "ti.metadata->>'multimodel_plan_b_route' AS route,",
 "ti.metadata->>'multimodel_governance_net_expected_r' AS expected_r,",
 "ti.metadata->>'m1_policy_version' AS policy_version,",
 "ti.metadata->>'multimodel_execution_authority_path' AS authority,",
 "ca.created_at AS allocated_at,",
 "ca.sizing_inputs->>'finalRiskAtStop' AS risk_at_stop",
 "FROM trading.trades t",
 "JOIN broker.broker_connections b ON b.id=t.broker_connection_id",
 "AND b.user_id=t.user_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
 "AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id",
 "LEFT JOIN LATERAL (SELECT a.created_at,a.sizing_inputs",
 "FROM trading.capital_allocations a",
 "WHERE a.trade_intent_id=t.trade_intent_id AND a.created_at<=t.opened_at",
 "ORDER BY a.created_at DESC LIMIT 1) ca ON true",
 "WHERE t.user_id=$1 AND b.user_id=$1",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.deleted_at IS NULL AND t.account_currency='USD'",
 "AND t.status='CLOSED' AND t.opened_at >= $2::timestamptz",
 "AND t.closed_at < $3::timestamptz",
 "AND ti.metadata->>'multimodel_plan_b_route'",
 "IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
 "ORDER BY t.opened_at,t.id LIMIT 801",
].join(' ');
const n=v=>v===undefined||v===null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const ms=v=>v==null?NaN:new Date(v).getTime();
const rnd=(v,d=4)=>Number(v.toFixed(d));
const day=v=>new Date(v).toISOString().slice(0,10);
function normalize(row){
 const opened=ms(row.opened_at),closed=ms(row.closed_at),allocated=ms(row.allocated_at),
  gross=n(row.realised_pnl),fee=n(row.commission),swap=n(row.swap),
  risk=n(row.risk_at_stop),forecast=n(row.expected_r);
 if(!ROUTES.includes(row.route)||!Number.isFinite(opened)||!Number.isFinite(closed)||
  closed<=opened||!Number.isFinite(allocated)||allocated>opened||
  [gross,fee,swap,risk,forecast].some(x=>x===null)||
  risk<=0||fee>0||!Number.isFinite(forecast))
  return {status:'SKIP_INCOMPLETE_OR_INCONSISTENT_BROKER_DATA'};
 const net=gross+fee+swap;
 const actualR=net/risk;
 return {
  status:'VALID',tradeKey:String(row.trade_key||''),
  route:row.route,instrument:row.instrument,
  day:day(opened),opened,closed,
  netUsd:rnd(net,2),grossUsd:rnd(gross,2),commissionUsd:rnd(fee,2),
  riskAtStop:risk,actualR,forecastR:forecast,
  errorR:actualR-forecast,
  policyVersion:String(row.policy_version||'UNKNOWN'),
  executionAuthority:String(row.authority||'UNKNOWN'),
 };
}
function priorCohort(rows,entry){
 const dayCutoff=Date.parse(entry.day+'T00:00:00Z');
 const lookback=dayCutoff-MAX_LOOKBACK_DAYS*86400000;
 return rows.filter(r=>r.status==='VALID'&&r.route===entry.route&&
  r.closed<dayCutoff&&r.closed>=lookback&&r.day<entry.day);
}
function calibrate(prior){
 const dates=new Set(prior.map(r=>r.day));
 if(prior.length<MIN_TRAIN||dates.size<MIN_DAYS)
  return {state:'INSUFFICIENT_CAUSAL_PRIOR_DAYS',
   priorTrades:prior.length,priorDays:dates.size,adjustmentR:null};
 const residuals=prior.map(r=>Math.max(-MAX_ABS_ERROR_R,
  Math.min(MAX_ABS_ERROR_R,r.errorR)));
 const raw=residuals.reduce((s,r)=>s+r,0)/residuals.length;
 const bias=raw*(prior.length/(prior.length+SHRINK));
 return {state:'HISTORICAL_BIAS_ESTIMATE_SHADOW',
  priorTrades:prior.length,priorDays:dates.size,
  rawBiasClippedR:rnd(raw),shrinkageSampleWeight:rnd(prior.length/(prior.length+SHRINK)),
  adjustmentR:rnd(bias),crossDayPurged:true,
  canTrade:false,changesLotSize:false};
}
function score(rows){
 const valid=rows.filter(r=>r.status==='VALID');
 const ordered=[...valid].sort((a,b)=>a.opened-b.opened||a.tradeKey.localeCompare(b.tradeKey));
 const observations=ordered.map(t=>{
  const prior=priorCohort(ordered,t),asof=calibrate(prior);
  const corrected=asof.adjustmentR===null?null:t.forecastR+asof.adjustmentR;
  return {
   day:t.day,route:t.route,instrument:t.instrument,
   expectedNetR:rnd(t.forecastR),actualNetR:rnd(t.actualR),
   actualNetUsd:t.netUsd,commissionUsd:t.commissionUsd,
   correctionState:asof.state,correctionR:asof.adjustmentR,
   priorHistoricalTrades:asof.priorTrades,priorDistinctDays:asof.priorDays,
   adjustedExpectedNetR:corrected===null?null:rnd(corrected),
   predictionAbsErrorRaw:rnd(Math.abs(t.forecastR-t.actualR)),
   predictionAbsErrorAdjusted:corrected===null?null:rnd(Math.abs(corrected-t.actualR)),
   rawSquaredError:rnd((t.forecastR-t.actualR)**2,6),
   adjustedSquaredError:corrected===null?null:rnd((corrected-t.actualR)**2,6),
   historicalForecastOnlyNoBrokerAuthority:true,
  };
 });
 return observations;
}
function summary(rows){
 const n=rows.length;
 const ready=rows.filter(x=>x.adjustedExpectedNetR!==null);
 const mean=(list)=>list.length?rnd(list.reduce((a,b)=>a+b,0)/list.length):null;
 const byDay={},byRoute={};
 for(const r of rows){
  for(const [dest,key] of [[byDay,r.day],[byRoute,r.route]]){
   const b=dest[key]??={count:0,adjustedCount:0,bookedNetUsd:0,
    originalAbsError:0,adjustedAbsError:0};
   b.count++;b.bookedNetUsd+=r.actualNetUsd;
   if(r.adjustedExpectedNetR!==null){
    b.adjustedCount++;
    b.originalAbsError+=r.predictionAbsErrorRaw;
    b.adjustedAbsError+=r.predictionAbsErrorAdjusted;
   }
  }
 }
 for(const container of [byDay,byRoute])for(const b of Object.values(container)){
  b.bookedNetUsd=rnd(b.bookedNetUsd,2);
  b.maeRawOnAdjustedCohort=b.adjustedCount?
   rnd(b.originalAbsError/b.adjustedCount):null;
  b.maeAdjustedOnAdjustedCohort=b.adjustedCount?
   rnd(b.adjustedAbsError/b.adjustedCount):null;
  delete b.originalAbsError;delete b.adjustedAbsError;
 }
 const before=ready.map(r=>r.predictionAbsErrorRaw),
  after=ready.map(r=>r.predictionAbsErrorAdjusted);
 const mseBefore=mean(ready.map(r=>r.rawSquaredError));
 const mseAfter=mean(ready.map(r=>r.adjustedSquaredError));
 return {
  evaluatedTrades:n,independentDays:new Set(rows.map(r=>r.day)).size,
  initialRawForecastMean:mean(rows.map(r=>r.expectedNetR)),
  finalActualNetRMean:mean(rows.map(r=>r.actualNetR)),
  settledNetUsd:rnd(rows.reduce((s,r)=>s+r.actualNetUsd,0),2),
  outOfSampleDayPurgedAdjustedCount:ready.length,
  insufficientCausalHistoryCount:n-ready.length,
  maeRawOnComparedCohort:mean(before),maeAdjustedOnComparedCohort:mean(after),
  mseRawOnComparedCohort:mseBefore,mseAdjustedOnComparedCohort:mseAfter,
  directionOfAccuracyChange:!ready.length?'NOT_EVALUABLE':
   mean(after)<mean(before)?'PRELIMINARY_IMPROVEMENT':
   mean(after)>mean(before)?'PRELIMINARY_WORSE':'NO_CHANGE',
  byDay,byRoute,
 };
}
// A current-day shadow forecast uses ONLY earlier complete UTC market days.
// The resulting adjustment can be displayed and monitored, never used to
// withhold, reverse, size or send an order.
function prospectiveCalibration(normalized,now=new Date()){
 const at=ms(now);
 if(!Number.isFinite(at))throw Error('INVALID_PROSPECTIVE_TIME');
 const cutoff=day(now)+'T00:00:00.000Z';
 const start=Date.parse(cutoff);
 const eligible=normalized.filter(t=>t.status==='VALID'&&
   t.closed<start&&t.closed>=start-MAX_LOOKBACK_DAYS*86400000&&
   t.day<day(now));
 const routes={};
 for(const route of ROUTES){
  const evidence=eligible.filter(t=>t.route===route);
  routes[route]=calibrate(evidence);
 }
 return {asOf:now.toISOString(),priorOnlyBefore:cutoff,
  routes,executionAuthority:'NONE',modifiesOrders:false,
  changesStops:false,changesLotSize:false};
}
// A thought experiment only: below-zero corrected estimates are NOT executable
// rejections. Count actual profitable trades they would wrongly reject.
function advisoryThresholdImpact(observations){
 const ready=observations.filter(t=>t.adjustedExpectedNetR!==null);
 const rejected=ready.filter(t=>t.adjustedExpectedNetR<=0);
 const retained=ready.filter(t=>t.adjustedExpectedNetR>0);
 const cash=list=>rnd(list.reduce((s,t)=>s+t.actualNetUsd,0),2);
 return {compared:ready.length,nonPositiveAdjustedForecast:rejected.length,
  positiveAdjustedForecast:retained.length,
  winningTradesThatWouldBeRejected:rejected.filter(t=>t.actualNetUsd>0).length,
  losingTradesThatWouldBeRetained:retained.filter(t=>t.actualNetUsd<0).length,
  rejectedCohortActualNetUsd:cash(rejected),
  retainedCohortActualNetUsd:cash(retained),
  causalSavingsProven:false,executionGateQualified:false};
}
function analyze(raw,now=new Date()){
 const t=raw.map(normalize),obs=score(t);
 return {
  artifact:ARTIFACT,generatedAt:now.toISOString(),
  ownerScope:'OWNER_PEPPERSTONE_CTRADER_USD_DEMO_TWO_ROUTES',
  mode:'RESEARCH_ONLY',changesModelWeights:false,changesOrderAuthority:false,
  modifiesProfitProtection:false,modifiesLotSize:false,
  liveEligible:false,brokerOrders:0,
  policy:{
   cutoff:'PRIOR_ENTIRE_CLOSED_UTC_TRADING_DAYS_ONLY',
   lookbackDays:MAX_LOOKBACK_DAYS,
   minimumPriorTrades:MIN_TRAIN,minimumPriorMarketDays:MIN_DAYS,
   cappedResidualR:MAX_ABS_ERROR_R,
   shrinkageEquivalentTrades:SHRINK,trainingOnlyRealBrokerSettlements:true,
   identicalForecastScaleRiskUnits:true,
  },
  invalidOrUnpricedRows:t.filter(r=>r.status!=='VALID').length,
  result:summary(obs),
  prospective:prospectiveCalibration(t,now),
  advisoryThresholdImpact:advisoryThresholdImpact(obs),
  tradeObservations:obs,
  limitations:[
   'No intra-day trade with a closure on the same UTC market day is ever used to adjust another trade that day; this deliberately removes tightly correlated same-day leakage.',
   'Only owner DEMO trades settled on an earlier full UTC trading day are eligible historical inputs.',
   'Risk normalization uses ex-ante capital allocation risk and booked broker commission, which can differ from actual broker stop-fill risk.',
   'The calibration coefficient is a frozen shrinkage hypothesis, not a trained model approved to place orders.',
   'Missing prior trading days produces INSUFFICIENT history and NO adjusted forecast, not a zero-fee or instant win.',
   'After-the-fact historical comparisons do not account for regime changes, overlap, rejected trades, drift, or changed execution strategy and do not prove an executable profitability advantage.',
   'Even lower forecast error does not mean trade entry payoff becomes positive; no trade authorization, lot sizing, stop or profit-protection logic is changed.',
  ],
 };
}
async function audit(client,owner,from,to=new Date()){
 if(!UUID.test(owner||''))throw Error('INVALID_OWNER_ID');
 const start=ms(from),end=ms(to);
 if(!Number.isFinite(start)||!Number.isFinite(end)||
  start>=end||end-start>MAX_LOOKBACK_DAYS*86400000+2*86400000)
  throw Error('INVALID_AUDIT_WINDOW');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 let rows;
 try{
  await client.query("SET LOCAL statement_timeout='25000ms'");
  rows=(await client.query(SQL,[owner,new Date(start).toISOString(),
   new Date(end).toISOString()])).rows;
  if(rows.length>MAX_ROWS)throw Error('AUDIT_COHORT_LIMIT');
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
 return analyze(rows,new Date(end));
}
async function main(){
 require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||
  path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const c=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-owner-demo-net-r-walkforward-readonly'});
 try{
  await c.connect();const to=new Date(),from=new Date(to.getTime()-30*86400000);
  const r=await audit(c,process.env.VPS_FOREX_SCANNER_USER_ID,from,to);
  fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
  const tmp=OUT+'.'+process.pid+'.tmp',fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(r,null,2))}
  finally{fs.closeSync(fd)}
  fs.renameSync(tmp,OUT);
  console.log('DAY_PURGED_OWNER_NET_R_CALIBRATION',JSON.stringify({
   generatedAt:r.generatedAt,policy:r.policy,invalid:r.invalidOrUnpricedRows,
   result:r.result,
   prospective:r.prospective,
   advisoryThresholdImpact:r.advisoryThresholdImpact,
  }));
 }finally{await c.end()}
}
module.exports={ARTIFACT,SQL,normalize,priorCohort,calibrate,score,summary,
 prospectiveCalibration,advisoryThresholdImpact,analyze,audit};
if(require.main===module)main().catch(e=>{
 console.error('DAY_PURGED_NET_R_AUDIT_FAILED',String(e.message).slice(0,200));
 process.exitCode=1;
});
