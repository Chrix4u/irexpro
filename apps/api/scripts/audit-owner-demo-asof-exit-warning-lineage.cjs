#!/usr/bin/env node
'use strict';
/**
 * Owner's Pepperstone cTrader USD DEMO: replay RESEARCH-ONLY position-exit
 * intelligence that was actually persisted BEFORE a broker-confirmed close.
 * Compare prospective flags with eventual settled results. This cannot replay
 * 5-second positions from once-per-minute audit logs or invent earlier exits.
 */
const fs=require('node:fs'),path=require('node:path');
const FROM='2026-11-17T00:00:00Z';
const OUT='/home/lightworld/webapps/irexpro-research/exit-payoff/latest-asof-exit-warning-lineage.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUERY=[
 'SELECT t.id::text trade_id,t.instrument,t.direction,t.opened_at,t.closed_at,',
 't.status,t.close_reason,t.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,',
 "ti.metadata->>'multimodel_plan_b_route' route,",
 'a.id::text observation_id,a.created_at recorded_at,',
 "a.metadata->>'observedAt' observed_at,",
 "a.metadata->>'recommendation' recommendation,",
 "a.metadata->>'reason' reason,",
 "a.metadata->>'currentBrokerNetPnl' current_broker_reported_pnl,",
 "a.metadata->>'currentR' current_r,",
 "a.metadata->>'peakR' peak_r,",
 "a.metadata->>'peakBrokerNetPnl' peak_broker_reported_pnl,",
 'a.metadata->\'protectedRunnerReadinessShadow\' protected_runner_readiness,',
 'a.metadata->\'protectedRunnerNativeDistanceShadow\' protected_runner_distance',
 'FROM trading.trades t',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
 'AND ti.broker_connection_id=t.broker_connection_id',
 'LEFT JOIN audit.audit_logs a ON a.resource_type=\'Trade\'',
 'AND a.resource_id=t.id::text AND a.actor_user_id=t.user_id',
 "AND a.action='DEMO_POSITION_EXIT_INTELLIGENCE_SHADOW'",
 'WHERE t.user_id=$1 AND b.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD' AND b.deleted_at IS NULL",
 "AND t.status IN ('OPEN','CLOSED')",
 'AND t.opened_at>=$2::timestamptz',
 'ORDER BY t.opened_at,t.id,a.created_at,a.id LIMIT 5001'
].join(' ');
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const rnd=(x,d=2)=>Number(x.toFixed(d));
function verifiedEvent(raw,opened,cutoff){
 if(!raw.observation_id)return null;
 const recordAt=ms(raw.recorded_at),observedAt=ms(raw.observed_at);
 const pnl=num(raw.current_broker_reported_pnl),currentR=num(raw.current_r),peakR=num(raw.peak_r);
 if(!Number.isFinite(opened)||!Number.isFinite(cutoff)||
  !Number.isFinite(recordAt)||!Number.isFinite(observedAt)||
  recordAt<opened||recordAt>cutoff||observedAt<opened||observedAt>recordAt||
  recordAt-observedAt>30000||pnl===null||currentR===null||peakR===null)
   return null;
 return {
  observationId:raw.observation_id,
  recordedMs:recordAt,observedMs:observedAt,
  reportedUnrealizedPnlUsd:pnl,currentR,peakR,
  recommendation:String(raw.recommendation||'UNVERIFIED'),
  reason:String(raw.reason||'UNKNOWN'),
  runnerReadinessWasRecorded:raw.protected_runner_readiness!=null,
  runnerNativeDistanceWasRecorded:raw.protected_runner_distance!=null,
 };
}
function tradeOutcome(raw,now=Date.now()){
 const opened=ms(raw.opened_at),closed=ms(raw.closed_at);
 if(!Number.isFinite(opened))throw Error('INVALID_TRADE_OPEN_TIME');
 const finished=raw.status==='CLOSED'&&Number.isFinite(closed)&&closed>=opened&&closed<=now;
 const components=[num(raw.realised_pnl),num(raw.commission),num(raw.swap)];
 const settled=finished&&components.every(x=>x!==null);
 const netUsd=settled?rnd(components.reduce((a,b)=>a+b,0)):null;
 const favorableMark=num(raw.max_favorable_pnl);
 const aboveFinalFees=settled&&netUsd<0&&favorableMark!==null&&
  favorableMark>0&&favorableMark+components[1]+components[2]>0;
 return {id:raw.trade_id,route:String(raw.route||'UNKNOWN'),
  instrument:String(raw.instrument||'UNKNOWN'),
  direction:raw.direction,dayUtc:new Date(opened).toISOString().slice(0,10),
  openedMs:opened,cutoffMs:finished?closed:now,
  status:raw.status,closed:finished,settled,netUsd,
  winner:settled&&netUsd>0,loser:settled&&netUsd<0,
  closeReason:String(raw.close_reason||'UNAVAILABLE'),
  postHocPeakAboveFinalFeesBeforeLoss:aboveFinalFees,
 };
}
function evaluateTrade(rawRows,now=Date.now()){
 if(rawRows.length<1)throw Error('NO_TRADE');
 const o=tradeOutcome(rawRows[0],now);
 const valid=[],ignored=[];
 for(const r of rawRows){
  if(r.trade_id!==o.id)throw Error('MIXED_TRADE_IDENTIFIERS');
  const event=verifiedEvent(r,o.openedMs,o.cutoffMs);
  if(event)valid.push(event);
  else if(r.observation_id)ignored.push(r.observation_id);
 }
 valid.sort((a,b)=>a.recordedMs-b.recordedMs||a.observedMs-b.observedMs);
 let maxRecordedR=null,peakRecordedR=null,firstPositiveAt=null,
  firstDeteriorationAt=null,latestPositiveAt=null,lastWarning=null,
  twoRecentDeteriorationAfterPositiveAt=null,
  firstDeteriorationAfterPositiveAt=null,
  lastKnownRecommendation=null,healthyRecommendations=0,
  deterioratingRecommendations=0,
  positiveObservedCount=0,peakQuarterRObserved=false;
 const byReason={};
 for(const x of valid){
  maxRecordedR=maxRecordedR===null?x.currentR:Math.max(maxRecordedR,x.currentR);
  peakRecordedR=peakRecordedR===null?x.peakR:Math.max(peakRecordedR,x.peakR);
  peakQuarterRObserved||=x.peakR>=.25;
  if(x.reportedUnrealizedPnlUsd>0){
   positiveObservedCount++;
   if(firstPositiveAt===null)firstPositiveAt=x.recordedMs;
   latestPositiveAt=x.recordedMs;
  }
  const warn=x.recommendation==='DETERIORATION_REVIEW_NOW';
  if(warn){
   deterioratingRecommendations++;
   if(firstDeteriorationAt===null)firstDeteriorationAt=x.recordedMs;
   if(firstPositiveAt!==null && firstPositiveAt<=x.recordedMs &&
      firstDeteriorationAfterPositiveAt===null)
    firstDeteriorationAfterPositiveAt=x.recordedMs;
   if(lastWarning!==null &&
      x.recordedMs-lastWarning<=180000 &&
      firstPositiveAt!==null && firstPositiveAt<=lastWarning &&
      twoRecentDeteriorationAfterPositiveAt===null)
    twoRecentDeteriorationAfterPositiveAt=x.recordedMs;
   lastWarning=x.recordedMs;
  }else lastWarning=null;
  if(x.recommendation==='HEALTHY_CONTINUATION_RESEARCH')healthyRecommendations++;
  lastKnownRecommendation=x.recommendation;
  byReason[x.reason]=(byReason[x.reason]||0)+1;
 }
 const iso=t=>t===null?null:new Date(t).toISOString();
 return {...o,validObservations:valid.length,ignoredObservations:ignored.length,
  latestRecommendation:lastKnownRecommendation,
  observedPositiveBrokerReportedUnrealizedPnl:positiveObservedCount>0,
  positiveObservations:positiveObservedCount,observedPeakR:peakRecordedR,
  highestObservedCurrentR:maxRecordedR,
  observedPeakQuarterR:peakQuarterRObserved,
  firstPositiveRecordedAt:iso(firstPositiveAt),
  latestPositiveRecordedAt:iso(latestPositiveAt),
  firstDeteriorationRecordedAt:iso(firstDeteriorationAt),
  firstDeteriorationAfterPositiveAt:iso(firstDeteriorationAfterPositiveAt),
  twoRecentDeteriorationAfterPositiveAt:iso(twoRecentDeteriorationAfterPositiveAt),
  timeFromTwoWarningFlagToExitMin:twoRecentDeteriorationAfterPositiveAt===null||!o.closed?
   null:rnd((o.cutoffMs-twoRecentDeteriorationAfterPositiveAt)/60000),
  numberOfDeterioratingObservations:deterioratingRecommendations,
  numberOfHealthyRecommendations:healthyRecommendations,
  reasons:byReason,
  flaggedAsOf:{
   anyPositiveBrokerReported:positiveObservedCount>0,
   afterPositiveDeterioration:firstDeteriorationAfterPositiveAt!==null,
   afterPositiveTwoDeteriorationWithinThreeMinutes:twoRecentDeteriorationAfterPositiveAt!==null,
   anyQuarterRObserved:peakQuarterRObserved,
   anyDeterioration:deterioratingRecommendations>0,
  }};
}
function aggregate(trades){
 const settled=trades.filter(x=>x.settled);
 const w=settled.filter(x=>x.winner),l=settled.filter(x=>x.loser),
  g=settled.filter(x=>x.netUsd===0);
 const winGross=w.reduce((s,x)=>s+x.netUsd,0),
  lossGross=l.reduce((s,x)=>s+x.netUsd,0);
 const covered=settled.filter(x=>x.validObservations>0),
  low=settled.filter(x=>x.postHocPeakAboveFinalFeesBeforeLoss);
 return {
  trades:trades.length,settled:settled.length,
  winningSettlements:w.length,losingSettlements:l.length,flatSettlements:g.length,
  openOrUnsettled:trades.length-settled.length,
  netUsd:rnd(settled.reduce((s,x)=>s+x.netUsd,0)),
  winRate:settled.length?rnd(w.length/settled.length,4):null,
  profitFactor:lossGross<0?rnd(winGross/(-lossGross),4):null,
  coveredByAsOfMinuteAudit:covered.length,
  noVerifiedMinuteObservation:settled.length-covered.length,
  positiveBeforeClose:covered.filter(x=>x.flaggedAsOf.anyPositiveBrokerReported).length,
  deteriorationBeforeClose:covered.filter(x=>x.flaggedAsOf.anyDeterioration).length,
  deteriorationAfterPositive:covered.filter(x=>x.flaggedAsOf.afterPositiveDeterioration).length,
  twoRecentWarningsAfterPositive:covered.filter(
   x=>x.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes).length,
  postHocFavorableMarkAboveFinalFeesAndNetLoss:low.length,
  amongPostHocFavorableMarksWithVerifiedAudit:low.filter(x=>x.validObservations>0).length,
  amongPostHocFavorableMarksWithAsOfPositive:low.filter(
   x=>x.flaggedAsOf.anyPositiveBrokerReported).length,
 };
}
function grouped(rows,key){const m=new Map();
 for(const r of rows){const k=String(key(r));if(!m.has(k))m.set(k,[]);m.get(k).push(r)}
 return Object.fromEntries([...m].sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,aggregate(v)]));
}
function compareFlag(trades,name){
 const settled=trades.filter(x=>x.settled&&x.validObservations>0);
 const flagged=settled.filter(x=>x.flaggedAsOf[name]);
 const unflagged=settled.filter(x=>!x.flaggedAsOf[name]);
 return {
  allWithVerifiedAsOfMinuteEvidence:aggregate(settled),
  flagged:aggregate(flagged),notFlagged:aggregate(unflagged),
  flaggedWinnersThatHypotheticalVetoWouldAlsoRemove:flagged.filter(x=>x.winner).length,
  flaggedLosersThatHypotheticalVetoWouldTarget:flagged.filter(x=>x.loser).length,
  researchOnlyNoAction:true,notIndependentWalkForward:true,
 };
}
function report(rows,now=new Date()){
 const map=new Map();
 for(const r of rows){if(!map.has(r.trade_id))map.set(r.trade_id,[]);map.get(r.trade_id).push(r)}
 const trades=[...map.values()].map(group=>evaluateTrade(group,now.getTime()));
 const sealed=['anyPositiveBrokerReported','afterPositiveDeterioration',
   'afterPositiveTwoDeteriorationWithinThreeMinutes','anyQuarterRObserved','anyDeterioration'];
 return {
  artifact:'irexpro-owner-demo-asof-exit-intelligence-lineage-v1',
  asOf:now.toISOString(),fromUtc:FROM,
  scope:'EXACT_OWNER_PEPPERSTONE_CTRADER_USD_DEMO',readOnly:true,
  noSqlWrites:true,modifiesExecution:false,tradeAuthority:'NONE',
  observations:trades.reduce((s,x)=>s+x.validObservations,0),
  discardedUnsafeClockObservations:trades.reduce((s,x)=>s+x.ignoredObservations,0),
  all:aggregate(trades),
  byDay:grouped(trades,x=>x.dayUtc),
  byRoute:grouped(trades,x=>x.route),
  byRouteAndOutcome:grouped(trades,x=>x.route+'|'+(x.winner?'WIN':x.loser?'LOSS':x.settled?'FLAT':'OPEN')),
  byRouteAndCloseReason:grouped(trades,x=>x.route+'|'+x.closeReason),
  flags:Object.fromEntries(sealed.map(name=>[name,compareFlag(trades,name)])),
  perRouteFlags:Object.fromEntries(['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION']
   .map(route=>[route,Object.fromEntries(sealed.map(name=>[name,compareFlag(
    trades.filter(x=>x.route===route),name)]))])),
  daySeparatedFlags:grouped(trades.filter(x=>x.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes),
   x=>x.dayUtc+'|'+x.route),
  latestCoveredDetails:trades.filter(x=>x.validObservations>0)
   .sort((a,b)=>b.openedMs-a.openedMs).slice(0,12).map(x=>({
    openedAt:new Date(x.openedMs).toISOString(),route:x.route,instrument:x.instrument,
    direction:x.direction,settled:x.settled,netUsd:x.netUsd,
    observations:x.validObservations,positivePrior:x.flaggedAsOf.anyPositiveBrokerReported,
    deteriorationPrior:x.flaggedAsOf.anyDeterioration,
    twoWarningAfterPositive:x.flaggedAsOf.afterPositiveTwoDeteriorationWithinThreeMinutes,
    latestRecommendation:x.latestRecommendation,
   })),
  limitations:[
   'The audit log is written approximately once per minute. The real broker P&L and protection logic run more frequently: no logged positive observation is NOT proof of no positive market move.',
   'An event only qualifies if its native observation clock precedes its durable audit clock by 0–30 seconds; BOTH must precede broker close. Late-persisted and out-of-order events are censored.',
   'Audit metadata currentBrokerNetPnl is broker-reported unrealized P&L as of the quote; exact future broker exit fees and slippage are not guaranteed by an earlier positive mark.',
   'The historical max_favorable_pnl above later final commission is a retrospective cross-check, NOT an as-of position decision feature.',
   'Deterioration review is not a broker order, and audit recommendations alone do not authorize a new exit; exact bid/ask, original broker stop, fee reserve and more are necessary.',
   'Any retrospective warning could also flag eventual winners. The flags explicitly compare winners discarded as well as eventual losers.',
   'These same historical days have been reviewed and are not an unbiased sealed holdout. New future sessions are necessary before introducing any executable close.',
   'No change to temporary owner DEMO higher lot window, risk profile, stop, profit-lock behavior, orders, side reversal or LIVE eligibility.',
  ],
 };
}
async function run(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;if(!UUID.test(owner||''))throw Error('OWNER_SCOPE_MISSING');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  database:process.env.DB_NAME,ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  statement_timeout:18000,connectionTimeoutMillis:6000,
  application_name:'irexpro-owner-asof-exit-warning-READONLY'});
 let rows;
 await db.connect();try{await db.query('BEGIN READ ONLY');
  rows=(await db.query(QUERY,[owner,FROM])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{await db.end()}
 if(rows.length>5000)throw Error('ASOF_OBSERVATION_QUERY_LIMIT');
 const result=report(rows);
 const data=JSON.stringify(result,null,2);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,data,{mode:0o600});
 const archive=path.join(path.dirname(OUT),'daily',result.asOf.slice(0,10)+'-asof-warnings.json');
 fs.mkdirSync(path.dirname(archive),{recursive:true,mode:0o700});
 fs.writeFileSync(archive,data,{mode:0o600});
 console.log('OWNER_ASOF_EXIT_INTELLIGENCE '+JSON.stringify({
  asOf:result.asOf,settled:result.all.settled,
  covered:result.all.coveredByAsOfMinuteAudit,
  positiveLoss:result.all.amongPostHocFavorableMarksWithAsOfPositive,
  twoWarningAfterPositive:result.all.twoRecentWarningsAfterPositive,
  zeroOrders:true,researchOnly:true}));
 return result;
}
module.exports={FROM,QUERY,verifiedEvent,tradeOutcome,evaluateTrade,aggregate,grouped,compareFlag,report,run};
if(require.main===module)run().catch(e=>{
 console.error('ASOF_EXIT_LINEAGE_AUDIT_FAILED',String(e.message).slice(0,220));process.exitCode=1;
});
