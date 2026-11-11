#!/usr/bin/env node
'use strict';
/* Broker-native, read-only, 5m de-duplicated M1 clock-rescue economics.
 * Costs are as-of P90 commission; future bid/ask marks are NOT broker fills,
 * tradable strategy backtests, or model-promotion evidence.
 */
const {asOfInput,frozenRoutePlanBAdmission}=require('./audit-planb-clock-factor-funnel.cjs');
const {validQuote,studyEpisode}=require('./audit-short-horizon-m1-episodes.cjs');
const {timestamp}=require('./audit-short-horizon-broker-marks.cjs');
const {stopPath}=require('./planb-hypothetical-stop-path.cjs');
const MODEL_ONLY=new Set(['ENSEMBLE_NOT_PAPER_ADMITTED','ENSEMBLE_NOT_PROMOTABLE_ADMISSION']);
const SQL={
 scope:"SELECT ts.broker_connection_id id,bc.broker_id broker,bc.account_currency currency FROM trading.trading_sessions ts JOIN broker.broker_connections bc ON bc.id=ts.broker_connection_id AND bc.user_id=ts.user_id WHERE ts.user_id=$1 AND ts.status='ACTIVE' AND ts.execution_mode='FULL_AUTO' AND bc.account_type='DEMO' AND bc.deleted_at IS NULL ORDER BY ts.started_at DESC LIMIT 1",
 decisions:[
 "WITH ranked AS (SELECT d.*,ROW_NUMBER() OVER(PARTITION BY d.instrument,d.direction,date_bin('5 minutes',d.created_at,'2000-01-01'::timestamptz) ORDER BY d.created_at,d.id) rn",
 "FROM trading.m1_tactical_decisions d WHERE d.user_id=$1 AND d.broker_connection_id=$2",
 "AND d.bar_time>=$3::timestamptz AND d.bar_time<$4::timestamptz-interval '63 minutes'",
 "AND d.route<>'ABSTAIN' AND d.direction IN ('BUY','SELL'))",
 "SELECT instrument,direction,route,created_at,evaluated_at,candidate,governance,execution_authority",
 "FROM ranked WHERE rn=1 ORDER BY created_at LIMIT $5::int"].join('\n'),
 quotes:"SELECT instrument,bucket_time,high,low,close,sample_count,last_quote_sample_at,bid_close,ask_close,source,positive_quote_sample_count FROM market_data.provider_quote_candles WHERE connection_id=$1 AND timeframe='M1' AND bucket_time >= $2::timestamptz-interval '2 minutes' AND bucket_time < $3::timestamptz AND source='ctrader-broker-native' ORDER BY instrument,last_quote_sample_at",
 fills:"SELECT closed_at,lot_size,commission,swap FROM trading.trades WHERE user_id=$1 AND broker_connection_id=$2 AND status='CLOSED' AND account_currency='USD' AND lot_size>0 AND commission IS NOT NULL AND closed_at<$3::timestamptz AND closed_at>=$4::timestamptz-interval '21 days' ORDER BY closed_at"
};
function asOfRow(r){
 const c=r.candidate||{},g=r.governance||{},m=g.multimodelEnsemble||{};
 const f=g.oodResearchFeatures||{},gov=g.multimodelGovernance||{};
 return {
 instrument:r.instrument,direction:r.direction,evaluatedAt:r.evaluated_at,
 m1Route:r.route,confidence:c.confidence,alignedEma:c.alignedEmaSeparationAtr,
 alignedM15:c.alignedM15,extension:f.extensionAtr,volatility:f.volatilityScore,
 rsi:f.rsi14,momentum:f.shortHorizonMomentumAtr,
 originalProbability:m.metaProbability,paperAdmitted:String(m.paperAdmitted),
 strategyRoute:m.strategyRoute,directionQuality:m.directionQuality,
 tradeQuality:m.tradeQuality,exitQuality:m.exitQuality,
 sessionQuality:m.sessionQuality,portfolioQuality:m.portfolioQuality,
 consensusPassed:m.consensusPassed,regime:m.regime,
 regimeAllowed:String(m.regimeAllowed),eventRisk:gov.eventRisk,
 driftState:gov.driftState,governanceBlockers:gov.paperExecutionBlockers,
 persistedNeutral:g.planBClockNeutralResearch?.hourNeutralProbability,
 };
}
function period(t){
 const d=new Date(t),h=d.getUTCHours(),m=d.getUTCMinutes();
 return h===0||h>=14||(h===13&&m>=30)?'AFTER_1330':'BEFORE_1330';
}
function day(t){
 const d=new Date(t);
 if(d.getUTCHours()===0)d.setUTCDate(d.getUTCDate()-1);
 return d.toISOString().slice(0,10);
}
function independentClear(r){
 return r.regimeAllowed==='true'&&r.regime!=='ROLLOVER_RISK'&&
 r.eventRisk==='CLEAR'&&r.driftState==='NORMAL'&&
 Array.isArray(r.governanceBlockers)&&
 r.governanceBlockers.every(x=>MODEL_ONLY.has(x));
}
function sameStrategy(r){
 return (r.m1Route==='M1_TREND_CONTINUATION'&&r.strategyRoute==='TREND_CONTINUATION')||
 (r.m1Route==='M1_CONFIRMED_REVERSAL'&&r.strategyRoute==='CONFIRMED_REVERSAL');
}
function replay(r,scorer){
 const row=asOfRow(r);
 const {originalProbability,modelInput}=asOfInput(row);
 const active=scorer.active(modelInput);
 if(Math.abs(active.probability-originalProbability)>1e-8)
  throw new Error('ACTIVE_REPLAY_MISMATCH');
 const neutral=scorer.neutral(modelInput);
 if(neutral.modifiesExecution!==false||neutral.calibrationQualified!==false)
  throw new Error('NEUTRAL_NOT_SHADOW');
 if(row.persistedNeutral!=null&&
 Math.abs(Number(row.persistedNeutral)-neutral.hourNeutralProbability)>1e-8)
  throw new Error('PERSISTED_NEUTRAL_MISMATCH');
 const hypothP=neutral.hourNeutralProbability;
 const hypoth={probability:hypothP,
   expectedR:hypothP*(2.5/1.5)-(1-hypothP),
   admitted:neutral.crossesLegacyThresholdForComparisonOnly};
 const coreActive=frozenRoutePlanBAdmission(row,active,modelInput.confidence);
 if(coreActive.voteCount!==coreActive.votesPersisted||
 coreActive.admitted!==(row.paperAdmitted==='true'))
  throw new Error('PLAN_B_CONSENSUS_REPLAY_MISMATCH');
 const coreNeutral=frozenRoutePlanBAdmission(row,hypoth,modelInput.confidence);
 const crosses=!active.admitted&&hypoth.admitted;
 const newlyCore=!coreActive.admitted&&coreNeutral.admitted;
 return {activeCore:coreActive.admitted,crosses,newlyCore,
   strictlyScreened:newlyCore&&independentClear(row)&&sameStrategy(row)};
}
function stats(cases){
 const out={episodes:cases.length,causalMarks:cases.filter(x=>x.study?.reason==='MARKED').length};
 const paths=cases.map(x=>x.path).filter(Boolean);
 const full=paths.filter(x=>x.state==='COMPLETE_60M_SAMPLED_QUOTES');
 out.stopPath={
  evaluated:paths.length,full60m:full.length,
  dataGap:paths.filter(x=>x.state==='DATA_GAP').length,
  invalidOrUnavailable:paths.filter(x=>!['DATA_GAP','COMPLETE_60M_SAMPLED_QUOTES'].includes(x.state)).length,
  stopWitnessedFirst:full.filter(x=>x.firstBarrier==='STOP_WITNESSED_FIRST').length,
  targetCloseWitnessedFirst:full.filter(x=>x.firstBarrier==='TARGET_CLOSE_WITNESSED_FIRST').length,
  simultaneousAmbiguous:full.filter(x=>x.firstBarrier==='SAME_MINUTE_AMBIGUOUS').length,
  neitherWitnessed:full.filter(x=>x.firstBarrier==='NEITHER_WITNESSED').length,
  stopWitnessedThenPositiveAt60m:full.filter(x=>x.stopThenPositiveAtHorizon).length,
 };
 out.stopSensitivity={};
 for(const multiple of [1.25,1.5,2]){
  const eligible=cases.filter(x=>x.path?.state==='COMPLETE_60M_SAMPLED_QUOTES'&&
    x.alternativePaths?.[String(multiple)]?.state==='COMPLETE_60M_SAMPLED_QUOTES');
  const originalStops=eligible.filter(x=>x.path.firstBarrier==='STOP_WITNESSED_FIRST');
  const avoided=originalStops.filter(x=>
    x.alternativePaths[String(multiple)].firstBarrier!=='STOP_WITNESSED_FIRST');
  out.stopSensitivity[String(multiple)]={
    comparableCompletePaths:eligible.length,
    originalStopFirst:originalStops.length,
    observedStopAvoided:avoided.length,
    amongAvoidedPositiveAt60m:avoided.filter(x=>x.study?.outcomes?.[60]?.netUsd1Lot>0).length,
    amongAvoidedNonPositiveAt60m:avoided.filter(x=>x.study?.outcomes?.[60]?.netUsd1Lot<=0).length,
    remainingStopFirst:eligible.filter(x=>
      x.alternativePaths[String(multiple)].firstBarrier==='STOP_WITNESSED_FIRST').length,
  };
 }
 for(const horizon of [5,10,20,30,60]){
  const valid=cases.map(x=>x.study?.outcomes?.[horizon]).filter(Boolean);
  const won=valid.filter(x=>x.netUsd1Lot>0).length;
  out[horizon]={n:valid.length,wins:won,
    positiveShare:valid.length?Number((won/valid.length).toFixed(3)):null,
    meanNetUSDPerLot:valid.length?
      Number((valid.reduce((a,x)=>a+x.netUsd1Lot,0)/valid.length).toFixed(2)):null,
    meanSignedPips:valid.length?Number((valid.reduce((a,x)=>a+x.signedPips,0)/valid.length).toFixed(2)):null};
 }
 return out;
}
function summarize(cases){
 const after=cases.filter(x=>x.period==='AFTER_1330');
 const groups={BEFORE_1330:cases.filter(x=>x.period==='BEFORE_1330'),
 AFTER_1330:after,AFTER_META_CROSSED:after.filter(x=>x.flags.crosses),
 AFTER_NEWLY_PLAN_B_ADMITTED:after.filter(x=>x.flags.newlyCore),
 AFTER_OTHER_GATES_CLEAR:after.filter(x=>x.flags.strictlyScreened),
 AFTER_ORIGINAL_PLAN_B_ADMITTED:after.filter(x=>x.flags.activeCore)};
 const byDay={};
 const byInstrument={};
 const byHours={};
 for(const d of [...new Set(after.map(x=>x.day))].sort()){
  const entries=after.filter(x=>x.day===d);
  byDay[d]={all:stats(entries),
    metaCross:stats(entries.filter(x=>x.flags.crosses)),
    strictRescue:stats(entries.filter(x=>x.flags.strictlyScreened))};
 }
 for(const pair of [...new Set(after.map(x=>x.instrument))].sort()){
  const matched=after.filter(x=>x.instrument===pair);
  byInstrument[pair]={all:stats(matched),
   clockCross:stats(matched.filter(x=>x.flags.crosses)),
   strict:stats(matched.filter(x=>x.flags.strictlyScreened))};
 }
 for(const hour of [...new Set(after.map(x=>x.hourUtc))].sort((a,b)=>a-b)){
  const matched=after.filter(x=>x.hourUtc===hour);
  byHours[String(hour).padStart(2,'0')+'Z']={
   all:stats(matched),clockCross:stats(matched.filter(x=>x.flags.crosses))};
 }
 return {cohorts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,stats(v)])),
  byDay,byInstrument,byHours};
}
module.exports={SQL,asOfRow,period,day,independentClear,sameStrategy,replay,stats,summarize};
async function audit(client,{userId,from,through,scorer,limit=8000}){
 const start=new Date(from),end=new Date(through);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId||''))
  throw new Error('INVALID_USER_SCOPE');
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||
    end<=start||end-start>7*86400000)throw new Error('INVALID_AUDIT_WINDOW');
 if(!scorer||typeof scorer.active!=='function'||typeof scorer.neutral!=='function')
  throw new Error('MISSING_SCORER');
 if(!Number.isInteger(limit)||limit<1||limit>8000)throw new Error('INVALID_LIMIT');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 let rows,quotes,fills,owned;
 try {
  await client.query("SET LOCAL statement_timeout='40s'");
  owned=(await client.query(SQL.scope,[userId])).rows[0];
  if(!owned||owned.broker!=='pepperstone-ctrader'||owned.currency!=='USD')
   throw new Error('OWNED_USD_DEMO_UNAVAILABLE');
  rows=(await client.query(SQL.decisions,[userId,owned.id,from,through,limit+1])).rows;
  if(rows.length>limit)throw new Error('AUDIT_TRUNCATED_FAIL_CLOSED');
  quotes=(await client.query(SQL.quotes,[owned.id,from,through])).rows;
  fills=(await client.query(SQL.fills,[userId,owned.id,through,from])).rows;
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
 const closes=fills.map(f=>({closedAt:timestamp(f.closed_at),
  feePerLot:(Math.abs(Number(f.commission))+Math.max(0,-Number(f.swap||0)))/Number(f.lot_size)
 })).filter(f=>Number.isFinite(f.closedAt)&&Number.isFinite(f.feePerLot)&&f.feePerLot>0);
 const quoteByPair=new Map();
 for(const q of quotes){
  if(!validQuote(q))continue;
  if(!quoteByPair.has(q.instrument))quoteByPair.set(q.instrument,[]);
  quoteByPair.get(q.instrument).push(q);
 }
 const exclusions={},cases=[];
 for(const row of rows){
  let flags;
  try{flags=replay(row,scorer);}
  catch(e){const reason=String(e.message||'UNKNOWN').slice(0,80);
   exclusions[reason]=(exclusions[reason]||0)+1;continue;}
  const bars=quoteByPair.get(row.instrument)||[];
  const study=studyEpisode({instrument:row.instrument,
   direction:row.direction,created_at:row.created_at},bars,closes,[5,10,20,30,60]);
  const pathInput={...row.candidate,direction:row.direction};
  const path=stopPath(pathInput,study,bars);
  const alternativePaths={};
  for(const multiple of [1.25,1.5,2])
   alternativePaths[String(multiple)]=stopPath(pathInput,study,bars,60,multiple);
  cases.push({period:period(row.created_at),day:day(row.created_at),
    flags,study,path,alternativePaths,instrument:row.instrument,direction:row.direction,
    hourUtc:new Date(row.created_at).getUTCHours()});
 }
 return {artifact:'planb-hour-neutral-rescue-broker-outcome-audit-v1',
  researchOnly:true,modifiesExecution:false,
  promotionEligible:false,executionAuthority:'NONE',from,through,
  broker:owned.broker,accountCurrency:owned.currency,
  sampledRoutedEpisodes:rows.length,verifiedReplays:cases.length,
  rejectedReplayEpisodes:rows.length-cases.length,exclusionReasons:exclusions,
  brokerNativeQuotes:quotes.length,causalFeeHistory:closes.length,
  ...summarize(cases),
  cautions:[
    'Frozen-route and clock-neutral threshold are research counterfactuals, not calibrated executable strategy.',
    'Repeated 5-minute candidates are temporally correlated, not independent randomized trades.',
    'Quote marks use first future observed broker BID/ASK and prior P90 fees, not actual order fills.',
    'Twenty-to-sixty minute marks are measured only on records with enough follow-up time. No first-touch SL/TP, intraminute stops, latency, slippage, full portfolio concurrency or path-dependent PnL.',
    'Sampled M1 high/low are broker midpoint extrema, not tick-level bid/ask extrema; stop/target ordering is uncertain within bars.',
    'Stop-distance multiples are hypothetical sensitivity only: no position-size/risk rebudgeting, slippage or SL execution fill.' ,
    'No strategy promotion, allocation changes or broker orders are performed.'],
 };
}
module.exports.audit=audit;
if(require.main===module){
 (async()=>{
  const path=require('node:path');
  require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
  const {Client}=require('pg');
  const {getDatabaseSslOptions}=require('../dist/config/database-tls');
  const {scorePlanBShadowMeta,scorePlanBClockNeutralResearch}=
   require('../dist/modules/ai/v8-shadow-meta-scorer');
  const through=process.env.IREXPRO_RESCUE_END||new Date().toISOString();
  const from=process.env.IREXPRO_RESCUE_START||
    new Date(new Date(through).getTime()-3*86400000).toISOString();
  const client=new Client({host:process.env.DB_HOST||'localhost',
    port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,
    ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
    connectionTimeoutMillis:9000,query_timeout:45000,
    application_name:'irexpro-clock-rescue-readonly'});
  try {
   await client.connect();
   const result=await audit(client,{
     userId:process.env.VPS_FOREX_SCANNER_USER_ID,from,through,
     scorer:{active:scorePlanBShadowMeta,neutral:scorePlanBClockNeutralResearch},
   });
   console.log('CLOCK_RESCUE_ECONOMICS '+JSON.stringify(result));
  }finally{await client.end();}
 })().catch(e=>{
  console.error('CLOCK_RESCUE_ECONOMICS_FAILED '+String(e.message||'UNKNOWN').slice(0,180));
  process.exitCode=1;
 });
}
