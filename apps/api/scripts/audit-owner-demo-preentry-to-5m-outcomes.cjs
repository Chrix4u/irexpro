#!/usr/bin/env node
'use strict';
/**
 * Owner Pepperstone USD DEMO. Join immutable pre-intent entry snapshots to
 * subsequent broker-settled net P&L and independently recorded 5m checkpoints.
 * Pre-entry flag tests are descriptive, never executable. No model tuning,
 * no training on same-day outcomes, no new broker orders, no SQL writes.
 */
const fs=require('node:fs'),path=require('node:path');
const formation=require('./audit-owner-demo-win-loss-formation.cjs');
const BASE='/home/lightworld/webapps/irexpro-research';
const OUT=BASE+'/entry-formation/latest-entry-to-five-minute-outcomes.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[89ab0-9a-f]{12}$/i;
const MAX_ROWS=800;
const FROM='2026-11-17T00:00:00.000Z';
const FEATURE_NAMES=['planBScore','forecastNetR','metaProbability','m1Confidence',
 'alignedM1Momentum3','alignedM5','alignedM5Momentum3','m5Body','m5Body3',
 'alignedH1','alignedH4','alignedM15','alignedHigherAgreement','expertProbability',
 'extension','consensus'];
const CHECKPOINT_SQL=[
 'SELECT o.trade_id::text trade_key,o.action,o.state,o.checkpoint_at,',
 'o.evaluated_at,o.created_at,o.current_r,o.probability,o.response,',
 't.opened_at,t.closed_at,t.status,t.close_reason,t.realised_pnl,t.commission,t.swap',
 'FROM trading.post_entry_shadow_observations o',
 'JOIN trading.trades t ON t.id=o.trade_id AND t.user_id=o.user_id',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'WHERE o.user_id=$1 AND t.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD' AND b.deleted_at IS NULL",
 "AND o.artifact='plan-b-v89-demo-5m-drawdown-guard-v1'",
 'AND o.checkpoint_minutes=5',
 'AND t.opened_at >= $2::timestamptz AND t.opened_at < $3::timestamptz',
 'ORDER BY t.opened_at,t.id LIMIT 801'
].join(' ');
const n=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const rnd=(x,k=4)=>Number(x.toFixed(k));
function startDay(now=Date.now()){
 const utcDay=Math.floor(now/86400000)*86400000;
 return new Date(Math.max(Date.parse(FROM),utcDay-6*86400000)).toISOString();
}
function tomorrow(now=Date.now()){
 return new Date((Math.floor(now/86400000)+1)*86400000).toISOString();
}
function normalizeFiveMinuteCheckpoint(row){
 const at=ms(row.checkpoint_at),opened=ms(row.opened_at),
   evaluated=ms(row.evaluated_at),created=ms(row.created_at),closed=ms(row.closed_at);
 const r=n(row.current_r),prob=n(row.probability);
 if(row.action!=='OBSERVE'||row.state!=='NO_ACTION'||
   !Number.isFinite(at)||!Number.isFinite(opened)||
   Math.abs(at-opened-300000)>1500||!Number.isFinite(evaluated)||
   !Number.isFinite(created)||!Number.isFinite(closed)||
   evaluated<opened||created<opened||evaluated>closed||created>closed||
   r===null||r<=-.4000001||prob===null||prob<0||prob>1||
   row.response?.source_state!=='READY')return null;
 return {tradeKey:String(row.trade_key),checkpointR:r,
  checkpointAt:new Date(at).toISOString(),
  range:r<0?'ADVERSE':r<.15?'SMALL_OR_FLAT':'STRONG_POSITIVE',
  weakOrFlat:r<.15,
  recordedBeforeExit:true,usedAsEntryFeature:false};
}
function withCheckpoint(trades,observations){
 const five=new Map();
 for(const raw of observations){
  const o=normalizeFiveMinuteCheckpoint(raw);if(!o)continue;
  if(five.has(o.tradeKey))throw Error('DUPLICATE_VERIFIED_FIVE_MINUTE_CHECKPOINT');
  five.set(o.tradeKey,o);
 }
 return trades.map(t=>({...t,fiveMinute:five.get(t.tradeKey)||null}));
}
function summary(rows){
 const outcomes=rows.filter(r=>['WIN','LOSS'].includes(r.label));
 const win=outcomes.filter(x=>x.label==='WIN'),lose=outcomes.filter(x=>x.label==='LOSS');
 const grossWin=win.reduce((s,r)=>s+r.netUsd,0),
  grossLoss=lose.reduce((s,r)=>s+r.netUsd,0);
 return {trades:rows.length,wins:win.length,losses:lose.length,
  winRate:outcomes.length?rnd(win.length/outcomes.length):null,
  netUsd:rnd(rows.reduce((s,r)=>s+r.netUsd,0),2),
  meanWinnerUsd:win.length?rnd(grossWin/win.length,2):null,
  meanLoserUsd:lose.length?rnd(grossLoss/lose.length,2):null,
  profitFactor:grossLoss<0?rnd(grossWin/(-grossLoss)):null,
  netUsdPerLotMean:rows.length?rnd(rows.reduce((s,r)=>s+r.netUsdPerLot,0)/rows.length,2):null,
  distinctEntryDays:new Set(rows.map(x=>x.tradeDate)).size};
}
function group(rows,keyFn){
 const d=new Map();
 for(const r of rows){
  const key=String(keyFn(r));
  if(!d.has(key))d.set(key,[]);
  d.get(key).push(r);
 }
 return Object.fromEntries([...d].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,summary(v)]));
}
function compareFlag(rows,fn){
 const withEntry=rows.filter(x=>x.matchedDecision&&x.entry);
 const yes=withEntry.filter(x=>fn(x.entry,x)===true),
   no=withEntry.filter(x=>fn(x.entry,x)!==true);
 const a=summary(yes),b=summary(no);
 return {flagged:a,notFlagged:b,
  lossRateDifference:a.winRate===null||b.winRate===null?null:
   rnd((1-a.winRate)-(1-b.winRate)),
  retrospectiveAvoidedLosses:a.losses,
  retrospectiveLostWinners:a.wins,
  historicalNetRemovedIfVetoed: a.trades?rnd(a.netUsd,2):null,
  warningOnly:true,canBlock:false};
}
function featuresWinLoss(rows){
 const result={};
 for(const k of FEATURE_NAMES){
  const valid=rows.filter(x=>x.matchedDecision&&x.entry&&n(x.entry[k])!==null);
  const winners=valid.filter(x=>x.label==='WIN'),losers=valid.filter(x=>x.label==='LOSS');
  const mean=xs=>xs.length?rnd(xs.reduce((s,r)=>s+n(r.entry[k]),0)/xs.length):null;
  result[k]={verifiedRows:valid.length,winRows:winners.length,lossRows:losers.length,
   meanForWinners:mean(winners),meanForLosers:mean(losers),
   contrastNotModel:true};
 }
 return result;
}
function compareFive(rows){
 const eligible=rows.filter(x=>x.matchedDecision&&x.fiveMinute),
   weak=eligible.filter(x=>x.fiveMinute.weakOrFlat),
   strong=eligible.filter(x=>!x.fiveMinute.weakOrFlat);
 const byFlags=Object.fromEntries(formation.FLAGS.map(([name,fn])=>[name,{
  observedAmongWeak:compareFlag(weak,fn).flagged,
  observedAmongStrong:compareFlag(strong,fn).flagged,
  flaggedWeakRate:eligible.filter(x=>fn(x.entry,x)===true).length?
   rnd(eligible.filter(x=>fn(x.entry,x)===true&&x.fiveMinute.weakOrFlat).length/
    eligible.filter(x=>fn(x.entry,x)===true).length):null,
  descriptiveNotPrediction:true,
 }]));
 return {available:eligible.length,
  missingCheckpointAmongMatched:rows.filter(x=>x.matchedDecision&&!x.fiveMinute).length,
  weakOrFlatDefinition:'Recorded five-minute current_r below +0.15R, AFTER original entry',
  weakOrFlat:summary(weak),strongPositive:summary(strong),
  byRoute:group(eligible,r=>r.entryRoute+'|'+r.fiveMinute.range),
  preEntryFeatureMeansWeak:featuresWinLoss(weak),
  preEntryFeatureMeansStrong:featuresWinLoss(strong),
  byOriginalEntryWarning:byFlags,
  warningComparisonDoesNotCausallyPredictRecovery:true};
}
function compareTrades(trades,checkpointRows,now=Date.now()){
 const rows=withCheckpoint(trades,checkpointRows);
 const matched=rows.filter(x=>x.matchedDecision);
 const routes=['ALL','EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION'];
 const days=[...new Set(rows.map(x=>x.tradeDate))].sort();
 const byFlag={};
 for(const [flag,fn] of formation.FLAGS){
  byFlag[flag]={};
  for(const route of routes){
   const scoped=route==='ALL'?matched:matched.filter(r=>r.entryRoute===route);
   const discovery=scoped.filter(r=>r.tradeDate<'2026-11-19');
   const later19=scoped.filter(r=>r.tradeDate==='2026-11-19');
   const later20=scoped.filter(r=>r.tradeDate==='2026-11-20');
   const full=compareFlag(scoped,fn);
   const first=compareFlag(discovery,fn),
    second=compareFlag(later19,fn),
    third=compareFlag(later20,fn);
   const exploratoryReplicated=
    first.flagged.trades>=5&&first.notFlagged.trades>=5&&
    second.flagged.trades>=5&&second.notFlagged.trades>=5&&
    first.lossRateDifference>=.10&&second.lossRateDifference>=.10;
   byFlag[flag][route]={all:full,nov17And18Exploratory:first,
    nov19LaterAlreadyReviewed:second,nov20LaterAlreadyReviewed:third,
    exploratoryRepeatNotValidated:exploratoryReplicated,executableVeto:false};
  }
 }
 const signals=[];
 for(const [name,perRoute] of Object.entries(byFlag))
  for(const [route,g] of Object.entries(perRoute))
   if(g.exploratoryRepeatNotValidated)signals.push({name,route,
    discovery:g.nov17And18Exploratory,
    later:g.nov19LaterAlreadyReviewed,
    nov20:g.nov20LaterAlreadyReviewed,
    note:'NOT an independent holdout, hypothesis only, no action'});
 const report={
  artifact:'irexpro-owner-demo-preentry-vs-five-minute-asof-contrast-v1',
  asOf:new Date(now).toISOString(),fromUtc:startDay(now),throughExclusiveUtc:tomorrow(now),
  scopes:{owner:'EXACT_OWNER_ID',broker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
   entryVerifiedBeforeIntent:true,checkpointPostEntryExplicit:true},
  closedTradeCohort:summary(rows),
  originalPreEntryDecisionMatched:matched.length,unmatchedEntry:rows.length-matched.length,
  byDay:group(rows,x=>x.tradeDate),
  byRoute:group(rows,x=>x.entryRoute||'UNKNOWN'),
  byRouteAndDay:group(rows,x=>x.tradeDate+'|'+x.entryRoute),
  byRouteAndInstrument:group(rows,x=>x.entryRoute+'|'+x.instrument),
  byCloseReason:group(rows,x=>x.outcomeOnly?.closeReason||'UNVERIFIED'),
  preEntryWinLossMeansByRoute:Object.fromEntries(routes.map(route=>[route,
   featuresWinLoss(route==='ALL'?matched:matched.filter(x=>x.entryRoute===route))])),
  preEntryFlagsByRoute:byFlag,
  exploratoryRepeatedWarnings:signals,
  joinedPostEntryFiveMinute:compareFive(rows),
  fullPreEntryLineageCoverage:matched.length===rows.length,
  repeatedWarningAuthorizesTrades:false,noModelTraining:true,
  noSqlWrites:true,executionAuthority:'NONE',modifiesTradeSizing:false,
  warnings:[
   'All features used in the pre-entry comparison were saved in original matched tactical decisions BEFORE trade intent and opening.',
   'Five-minute risk is available only AFTER entry. It is a retrospective outcome grouping, not an original entry feature.',
   'Historical flag thresholds were explored previously. Nov19 and Nov20 are NOT sealed independent holdout days.',
   'NO_ACTION checkpoints select survivors; guarded closures do not have comparable score-as-of records and are not treated as the same experimental group.',
   'Unmatched checkpoint and absent observations are censored, never classified as winners.',
   'Many flags tested and correlated trades create large false discovery risk; do not add a veto based on this report.',
   'A potential veto loses winning trades as well as avoiding losing trades; counts and dollars are both published.',
   'Trading-day separation, after-commission net and genuine future prospective validation are mandatory before any deployment to execution.'
  ]};
 return report;
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;if(!UUID.test(owner||''))throw Error('OWNER_ID_REQUIRED');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  statement_timeout:19000,application_name:'irexpro-owner-preentry-vs-five-minute-READONLY'});
 const fromUtc=startDay(),toUtc=tomorrow();
 let a,b;
 await db.connect();
 try{
  await db.query('BEGIN READ ONLY');
  a=(await db.query(formation.SQL,[owner,'pepperstone-ctrader',fromUtc,toUtc])).rows;
  b=(await db.query(CHECKPOINT_SQL,[owner,fromUtc,toUtc])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 if(a.length>MAX_ROWS||b.length>MAX_ROWS)throw Error('COHORT_LIMIT_EXCEEDED');
 const report=compareTrades(a.map(formation.normalize),b);
 const payload=JSON.stringify(report,null,2);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,payload,{mode:0o600});
 const archive=BASE+'/entry-formation/daily/'+report.asOf.slice(0,10)+'-entry-to-5m.json';
 fs.mkdirSync(path.dirname(archive),{recursive:true,mode:0o700});
 fs.writeFileSync(archive,payload,{mode:0o600});
 console.log('PREENTRY_5M_RESEARCH '+JSON.stringify({
  asOf:report.asOf,closed:report.closedTradeCohort.trades,
  preEntryVerified:report.originalPreEntryDecisionMatched,
  checkpointCovered:report.joinedPostEntryFiveMinute.available,
  warnings:report.exploratoryRepeatedWarnings.map(x=>({flag:x.name,route:x.route})),
  researchOnly:true,modifiesExecution:false
 }));
 return report;
}
module.exports={CHECKPOINT_SQL,startDay,tomorrow,normalizeFiveMinuteCheckpoint,
 withCheckpoint,summary,group,compareFlag,featuresWinLoss,compareFive,compareTrades,main};
if(require.main===module)main().catch(e=>{
 console.error('PREENTRY_FIVE_MINUTE_RESEARCH_FAILED',String(e.message).slice(0,220));process.exitCode=1;
});
