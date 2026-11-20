#!/usr/bin/env node
'use strict';
/**
 * Research-only, exact owner Pepperstone USD DEMO.
 *
 * Compare truly pre-order 60s broker-native quote movement and pre-order
 * sampled M1 forming-candle body pressure with actual closed broker net,
 * by route and trading day. No hindsight in input flags, no order authority.
 *
 * NOTE thresholds are historically EXPLORATORY, not an eligible live veto.
 */
const fs=require('node:fs'),path=require('node:path');
const formation=require('./audit-owner-demo-win-loss-formation.cjs');
const candle=require('./owner-demo-asof-candle-win-loss.cjs');
const quote=require('./audit-pepperstone-asof-entry-context-net.cjs');
const FROM='2026-11-17T00:00:00Z';
// All results through Friday Nov 20 have already informed the hypothesis.
// Exclude the ENTIRE current day from any claim of untouched validation.
const FORWARD_AFTER='2026-11-21T00:00:00.000Z';
const OUT='/home/lightworld/webapps/irexpro-research/entry-formation/latest-preentry-contradiction-cohorts.json';
const ROUTES=['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rnd=(n,k=3)=>Number(n.toFixed(k));
function summarize(rows){
 const wins=rows.filter(x=>x.netUsd>0),loss=rows.filter(x=>x.netUsd<0);
 const net=rows.reduce((a,x)=>a+x.netUsd,0);
 const winNet=wins.reduce((a,x)=>a+x.netUsd,0);
 const lossNet=loss.reduce((a,x)=>a+x.netUsd,0);
 const r=rows.map(x=>x.netR).filter(x=>x!==null);
 const perLot=rows.map(x=>x.netPerLot).filter(Number.isFinite);
 return {trades:rows.length,wins:wins.length,losses:loss.length,
  netUsd:rnd(net,2),winNetUsd:rnd(winNet,2),lossNetUsd:rnd(lossNet,2),
  profitFactor:lossNet<0?rnd(winNet/-lossNet,3):null,
  meanNetR:r.length?rnd(r.reduce((s,x)=>s+x,0)/r.length,3):null,
  medianNetR:r.length?rnd([...r].sort((a,b)=>a-b)[Math.floor((r.length-1)/2)],3):null,
  meanNetPerLot:perLot.length?rnd(perLot.reduce((s,x)=>s+x,0)/perLot.length,2):null,
  days:new Set(rows.map(x=>x.day)).size,
 };
}
function classify(original,context,candles){
 if(!original.matchedDecision||!original.entry||
    !ROUTES.includes(original.entryRoute))
  return {status:'UNMATCHED_PRE_ENTRY_DECISION',flags:{}};
 const q=context?.asOf,c=candles??null;
 const qVerified=context?.status==='VALID' &&
  context.route===original.entryRoute &&
  context.instrument===original.instrument &&
  context.direction===original.direction &&
  context.day===original.tradeDate &&
  q?.status==='FRESH_ASOF_BROKER_QUOTE' &&
  typeof q.aligned60sPips==='number'&&Number.isFinite(q.aligned60sPips) &&
  typeof q.quoteAgeSeconds==='number'&&q.quoteAgeSeconds>=0&&q.quoteAgeSeconds<=15 &&
  context.intentAt<=context.openedAt &&
  (new Date(original.decisionAt).getTime() <= context.intentAt);
 const candleVerified=c?.M1?.source==='SAMPLED_BROKER_NATIVE_ASOF_QUOTES' &&
  c.M1.fullTickOhlc===false &&
  new Date(c.M1.at).getTime()<=new Date(original.decisionAt).getTime()&&
  Number.isFinite(c.M1.bodyAlignedRatio);
 const qContra=qVerified&&q.aligned60sPips<=-.30;
 const cContra=candleVerified&&c.M1.bodyAlignedRatio<=-.30;
 // The separately persisted pre-intent Plan-B M5 direction is not a future
 // candle nor the independent expert. It is useful only for a ROUTE-specific
 // research disagreement with the actual last-minute broker price path.
 const modelM5=original.entry.alignedM5;
 const modelM5Verified=typeof modelM5==='number'&&Number.isFinite(modelM5);
 const labels={
  LAST_60S_QUOTE_OPPOSES:qVerified?qContra:null,
  LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE:qVerified&&modelM5Verified?
    qContra&&modelM5<0:null,
  M1_FORMING_BODY_OPPOSES:candleVerified?cContra:null,
  BOTH_PREENTRY_MEASUREMENTS_OPPOSE:qVerified&&candleVerified?qContra&&cContra:null,
  EITHER_PREENTRY_MEASUREMENT_OPPOSE:qVerified&&candleVerified?qContra||cContra:null,
 };
 return {
  status:'VERIFIED_MATCHED_PREENTRY_DECISION',
  flags:labels,hasQuoteEvidence:qVerified,hasM1CandleEvidence:candleVerified,
  quoteAgeSeconds:qVerified?q.quoteAgeSeconds:null,
  quoteAligned60sPips:qVerified?q.aligned60sPips:null,
  submittedModelM5Alignment:modelM5Verified?modelM5:null,
  submittedForecastNetR:original.entry.forecastNetR,
  candleAlignedM1BodyRatio:candleVerified?c.M1.bodyAlignedRatio:null,
  expertState:original.entry.expertState,
  m1Route:original.entry.m1Route,
 };
}
function row(original,context,candles){
 const c=classify(original,context,candles);
 const validRisk=context?.status==='VALID' &&
  context.instrument===original.instrument &&
  context.route===original.entryRoute &&
  context.day===original.tradeDate;
 return {
  day:original.tradeDate,route:original.entryRoute,
  tradeId:original.tradeKey,instrument:original.instrument,
  direction:original.direction,entryAt:original.decisionAt,
  openedAt:original.openedAt,
  netUsd:original.netUsd,
  netPerLot:original.netUsdPerLot,
  netR:validRisk?context.netRealizedR:null,
  outcome:original.label,
  lot:original.lot,
  ...c,
 };
}
function group(items,fn){
 const d=new Map();
 for(const x of items){const k=String(fn(x));
  if(!d.has(k))d.set(k,[]);d.get(k).push(x);}
 return Object.fromEntries([...d].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,summarize(v)]));
}
function compare(trades,flag,route,cutoff){
 const scoped=trades.filter(x=>route==='ALL'||x.route===route);
 const known=scoped.filter(x=>typeof x.flags?.[flag]==='boolean');
 const flagged=known.filter(x=>x.flags[flag]);
 const kept=known.filter(x=>!x.flags[flag]);
 const before=flagged.filter(x=>x.day<cutoff),
  after=flagged.filter(x=>x.day>=cutoff);
 return {
  flag,route,
  knownEvidence:summarize(known),
  missingEvidence:scoped.length-known.length,
  hypotheticalSkipped:summarize(flagged),
  hypotheticalKept:summarize(kept),
  historicalRetrospectiveImprovementUsd:rnd(-flagged.reduce((s,x)=>s+x.netUsd,0),2),
  sacrificedWinningTrades:flagged.filter(x=>x.netUsd>0).length,
  avoidedLosingTrades:flagged.filter(x=>x.netUsd<0).length,
  dayByDay:group(flagged,x=>x.day),
  earlierNov17To18:summarize(before),
  laterNov19And20AlreadyReviewed:summarize(after),
  wouldSetExecutionBlocker:false,
  meaning:'Retrospective correlation only: both winners and losers vanish under a proposed veto.',
 };
}
function analyze(rows,contextById,candlesById,asOf,fromUtc=FROM){
 const verified=rows.filter(x=>x.matchedDecision);
 const trades=verified.map(x=>row(x,contextById.get(x.tradeKey),candlesById.get(x.tradeKey)));
 const flags=['LAST_60S_QUOTE_OPPOSES','LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE',
  'M1_FORMING_BODY_OPPOSES',
  'BOTH_PREENTRY_MEASUREMENTS_OPPOSE','EITHER_PREENTRY_MEASUREMENT_OPPOSE'];
 const contrasts=flags.flatMap(f=>['ALL',...ROUTES]
  .map(route=>compare(trades,f,route,'2026-11-19')));
 const main=contrasts.filter(x=>x.route==='CONFIRMED_REVERSAL');
 const future=trades.filter(x=>x.openedAt>=FORWARD_AFTER);
 const prospectiveRoute=compare(future,
  'LAST_60S_QUOTE_AND_MODEL_M5_OPPOSE','CONFIRMED_REVERSAL',FORWARD_AFTER.slice(0,10));
 const independentFutureDays=new Set(future.filter(x=>x.route==='CONFIRMED_REVERSAL')
  .map(x=>x.day)).size;
 const prospectiveReviewReady=independentFutureDays>=5&&
  prospectiveRoute.knownEvidence.trades>=30&&
  prospectiveRoute.hypotheticalSkipped.trades>=10&&
  prospectiveRoute.hypotheticalKept.trades>=15;
 const eventCoverage={
  matchedDecisions:trades.length,
  quote60sMatched:trades.filter(x=>x.hasQuoteEvidence).length,
  m1BodyMatched:trades.filter(x=>x.hasM1CandleEvidence).length,
  bothMatched:trades.filter(x=>x.hasQuoteEvidence&&x.hasM1CandleEvidence).length,
  expertStateCounts:trades.reduce((s,x)=>(s[x.expertState||'UNKNOWN']=(s[x.expertState||'UNKNOWN']||0)+1,s),{}),
 };
 return {
  artifact:'irexpro-owner-demo-preentry-contradiction-abstain-shadow-v1',
  asOf:asOf.toISOString(),
  fromUtc,throughUtc:asOf.toISOString(),
  scope:'EXACT_OWNER_PEPPERSTONE_CTRADER_USD_DEMO',
  allSettled:summarize(trades),eventCoverage,byDay:group(trades,x=>x.day),
  byRoute:group(trades,x=>x.route),
  comparison:contrasts,
  leadingCandidateComparison:main,
  prospectiveUnseenAfterUtc:FORWARD_AFTER,
  prospectiveUnseenAfterReviewedDays:{
   distinctEntryDays:independentFutureDays,
   comparisons:prospectiveRoute,
   enoughDataToReviewProspectiveEffect:prospectiveReviewReady,
   executableVetoEligible:false,
   excludesAllHistoricallyReviewedDates:true,
  },
  prospectiveRuleDefinition:{
   route:'CONFIRMED_REVERSAL',quote:'prior60s aligned mid-price movement <= -0.30 pips, with both source and capture observed before trade intent and fresh quote <=15 sec',
   modelM5:'original frozen pre-intent tactical candidate alignedM5 < 0, combined with the raw quote contradiction for the narrower candidate',
   formingCandle:'latest sampled broker-native in-progress M1 body signed against direction <= -0.30 of sampled range, observed before entry decision',
   otherRoutes:'negative controls; same threshold cannot be assumed meaningful for an Early Transition or Trend Continuation',
   modelIndependent:false,reason:'Both source channels derive from Pepperstone broker-native prices; not independent model agreement.',
   candidateSelectionStatus:'POST_HOC_HYPOTHESIS_SELECTED_AFTER_NOV17_TO_NOV20_RESULTS_VIEWED',
   canVeto:false,changesExecution:false,
  },
  validatedOnFutureUntouchedTradingDays:false,
  realBrokerVetoEnabled:false,
  noSqlWrites:true,noModelTraining:true,
  noNewOrders:true,noLotChanges:true,noProfitLockChanges:true,
  limitations:[
   'The quote and candle flags both use samples observed before the original decision or trade intent; no exit prices, realized P&L or subsequent candles enter features.',
   'Same-source quote movement and sampled candle body are correlated and are not independent confirmations or proof of a trained candlestick expert forecast.',
   'Both historical thresholds have been explored using past outcome labels. This is NOT an unbiased model score or forward edge estimate.',
   'Current strategy, instrument and market-regime changes make historical conditional win rates unstable. Do not apply a broad veto or assert profitable avoidance.',
   'Missing raw quote, candle or fresh timing evidence is UNKNOWN; never mislabeled safe or adverse.',
   'Winners that would have been excluded are counted and shown. Excluding historical losses is not equivalent to achievable broker P&L.',
   'There is no shadow fill for trades that did not actually execute, so silent omission can damage market coverage.',
   'Independent future market days and broker-native cost/SL/TP parity are required before any production or LIVE setting is altered.',
  ],
  ownerNoonLotTrialModified:false,
 };
}
async function run(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('OWNER_ID_NOT_VERIFIED');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  statement_timeout:24000,connectionTimeoutMillis:8000,
  application_name:'irexpro-owner-preentry-contradictions-READONLY'});
 const now=new Date();
 // The broker quote audit accepts at most fourteen UTC days. Keep this
 // continuously usable after the initial discovery dates age out.
 const utcDay=Math.floor(now.getTime()/86400000)*86400000;
 const fromUtc=new Date(Math.max(Date.parse(FROM),utcDay-13*86400000)).toISOString();
 let formationRows;
 await db.connect();
 try{
  await db.query('BEGIN READ ONLY');
  formationRows=(await db.query(formation.SQL,[owner,'pepperstone-ctrader',fromUtc,
   new Date(utcDay+86400000).toISOString()])).rows;
  await db.query('ROLLBACK');
  if(formationRows.length>800)throw Error('FORMATION_TRADE_LIMIT');
  const context=await quote.audit(db,owner,fromUtc,now);
  const contextById=new Map(context.details.filter(x=>x.status==='VALID')
   .map(x=>[x.tradeKey,x]));
  const normalized=formationRows.map(formation.normalize);
  const candles=await candle.annotate(normalized);
  const report=analyze(normalized,contextById,candles.annotated,now,fromUtc);
  const payload=JSON.stringify(report,null,2);
  fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
  fs.writeFileSync(OUT,payload,{mode:0o600});
  const archive=path.join(path.dirname(OUT),'daily',report.asOf.slice(0,10)+'-preentry-contradictions.json');
  fs.mkdirSync(path.dirname(archive),{recursive:true,mode:0o700});
  fs.writeFileSync(archive,payload,{mode:0o600});
  console.log('OWNER_PREENTRY_CONTRADICTION_RESEARCH '+JSON.stringify({
   asOf:report.asOf,trades:report.allSettled.trades,
   quoteEvidence:report.eventCoverage.quote60sMatched,
   candleEvidence:report.eventCoverage.m1BodyMatched,
   bothEvidence:report.eventCoverage.bothMatched,
   leading:report.leadingCandidateComparison.map(x=>({
    flag:x.flag,flagged:x.hypotheticalSkipped.trades,
    wins:x.hypotheticalSkipped.wins,losses:x.hypotheticalSkipped.losses,
    netUsd:x.hypotheticalSkipped.netUsd,
    missing:x.missingEvidence})),
   researchOnly:true,noOrders:true,
  }));
  return report;
 }finally{await db.end().catch(()=>{})}
}
module.exports={FROM,summarize,classify,row,group,compare,analyze,run};
if(require.main===module)run().catch(e=>{
 console.error('OWNER_PREENTRY_CONTRADICTION_FAILED',String(e.message).slice(0,220));
 process.exitCode=1;
});
