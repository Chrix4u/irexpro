#!/usr/bin/env node
'use strict';
/**
 * Owner-scoped read-only Pepperstone DEMO continuous entry monitoring.
 * Independent broker trades, not repeated per-minute scanner opinions,
 * are the statistical denominator. This script CANNOT submit orders.
 */
const {dirname, resolve}=require('node:path');
const {mkdirSync, writeFileSync, renameSync, chmodSync}=require('node:fs');
const ARTIFACT='pepperstone-demo-continuous-evidence-scorecard-v1';
const START='2026-11-16T23:36:00.000Z';
const CONTINUOUS_START='2026-11-17T02:07:53.000Z';
const REPORT='/home/lightworld/webapps/irexpro-research/continuous-evidence/latest-report.json';
const ALLOWED_ROUTES=new Set(['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION']);
const SCOPE=`
SELECT b.id FROM trading.trading_sessions s JOIN broker.broker_connections b
ON b.id=s.broker_connection_id AND b.user_id=s.user_id
WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
AND b.deleted_at IS NULL AND b.status='CONNECTED' AND b.authorization_status='ACTIVE'
ORDER BY s.authority_generation DESC,s.started_at DESC LIMIT 1
`;
const TRADES=`
SELECT t.instrument,t.direction,t.status,t.opened_at AS "openedAt",
 t.closed_at AS "closedAt",t.lot_size AS lots,
 t.realised_pnl AS "grossRealized",t.commission,t.swap,
 t.close_reason AS "closeReason",t.max_favorable_pnl AS "peakGross",
 t.profit_giveback AS "givebackGross",t.path_last_observed_at AS "pathObservedAt",
 t.path_observation_count AS "observations",
 i.metadata->>'multimodel_plan_b_route' AS route,
 i.metadata->>'m1_pepperstone_demo_advisory_alternates' AS advisory,
 i.metadata->>'m1_pepperstone_demo_continuous_evidence' AS continuous,
 i.metadata->>'m1_guarded_pullback_continuation' AS pullback
FROM trading.trades t
LEFT JOIN trading.trade_intents i ON i.id=t.trade_intent_id AND i.user_id=t.user_id
WHERE t.user_id=$1 AND t.broker_connection_id=$2
AND t.opened_at >= $3::timestamptz AND t.opened_at < $4::timestamptz
AND t.status IN ('OPEN','CLOSED')
AND (
 i.metadata->>'m1_pepperstone_demo_advisory_alternates'='true'
 OR i.metadata->>'m1_pepperstone_demo_continuous_evidence'='true'
 OR i.metadata->>'m1_guarded_pullback_continuation'='true'
 OR (
   i.metadata->>'multimodel_execution_authority_path'='PRIMARY_PLAN_B'
   AND i.metadata->>'multimodel_plan_b_route'
     IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION')
 )
)
ORDER BY t.opened_at ASC LIMIT 1501
`;
const DECISIONS=`
SELECT
 d.governance #>> '{multimodelEnsemble,strategyRoute}' route,
 d.governance #>> '{advisoryAlternateTrial,reason}' reason,
 d.governance #>> '{guardedPullback,reason}' pullback,
 COUNT(*)::int scans
FROM trading.m1_tactical_decisions d
WHERE d.user_id=$1 AND d.broker_connection_id=$2
AND d.evaluated_at >= $3::timestamptz AND d.evaluated_at < $4::timestamptz
GROUP BY 1,2,3
ORDER BY scans DESC LIMIT 200
`;
function val(v){
 if(v===null||v===undefined||v==='')return null;
 const n=Number(v);return Number.isFinite(n)?n:null;
}
function money(n){return n===null?null:Math.round((n+Number.EPSILON)*100)/100}
function pct(n){return money(n*100)}
function summarize(trades,decisionGroups,{from=START,until=new Date().toISOString(),now=new Date()}={}){
 const begin=Date.parse(from),end=Date.parse(until);
 if(!Number.isFinite(begin)||!Number.isFinite(end)||end<=begin)throw Error('INVALID_WINDOW');
 const buckets=new Map();
 const all=[];
 for(const x of trades){
  const opened=Date.parse(x.openedAt);
  if(!Number.isFinite(opened)||opened<begin||opened>=end)throw Error('OUT_OF_WINDOW_BROKER_TRADE');
  if(!ALLOWED_ROUTES.has(x.route)||!['BUY','SELL'].includes(x.direction)||!['OPEN','CLOSED'].includes(x.status))
    throw Error('OUT_OF_SCOPE_TRADE');
  const cohort=x.continuous==='true'
    ? 'CONTINUOUS'
    : x.advisory==='true'
      ? 'ORIGINAL_ADVISORY'
      : x.pullback==='true'
        ? 'GUARDED_PULLBACK'
        : 'PRIMARY_PLAN_B';
  const fee=val(x.commission),swap=val(x.swap),gross=val(x.grossRealized);
  const closed=x.status==='CLOSED';
  const net=closed&&gross!==null&&fee!==null&&swap!==null?money(gross+fee+swap):null;
  const peak=val(x.peakGross),giveback=val(x.givebackGross);
  const last=Date.parse(x.pathObservedAt??'');
  const observedGross=!closed && peak!==null&&giveback!==null?money(peak-giveback):null;
  const fresh=!closed && Number.isFinite(last) &&
    now.getTime()-last>=0 && now.getTime()-last<=90_000;
  const trade={
   cohort,route:x.route,instrument:x.instrument,direction:x.direction,
   status:x.status,openedAt:new Date(opened).toISOString(),
   closedAt:closed&&x.closedAt?new Date(x.closedAt).toISOString():null,
   lots:val(x.lots),
   closeReason:closed?(x.closeReason??'UNKNOWN'):null,
   realizedNet:net,
   realizedGross:closed?gross:null,
   recordedCommission:closed?fee:null,
   recordedSwap:closed?swap:null,
   feeComplete:closed&&net!==null,
   peakGross:peak,givebackGross:giveback,
   latestObservedGross:observedGross,
   lastObservedAt:Number.isFinite(last)?new Date(last).toISOString():null,
   latestObservationFresh: fresh,
   pathObservations:Number.isInteger(Number(x.observations))?Number(x.observations):0
  };
  all.push(trade);
  const bucket=buckets.get(cohort+':'+x.route)??{
   cohort,route:x.route,closed:0,open:0,netComplete:0,netIncomplete:0,
   wins:0,losses:0,flats:0,netTotal:0,positiveNet:0,negativeNet:0,
   protectedProfitCloses:0,brokerClose:0,totalCommission:0,totalSwap:0,
   maxClosedEquityDrawdown:0,netEquity:0,highWaterNet:0
  };
  buckets.set(cohort+':'+x.route,bucket);
  if(!closed)bucket.open++;
  else{
   bucket.closed++;
   if(x.closeReason==='PROFIT_PROTECTION')bucket.protectedProfitCloses++;
   if(x.closeReason==='BROKER_CLOSE')bucket.brokerClose++;
   if(net===null)bucket.netIncomplete++;
   else{
    bucket.netComplete++;
    bucket.netTotal+=net;
    if(net>0){bucket.wins++;bucket.positiveNet+=net}
    else if(net<0){bucket.losses++;bucket.negativeNet+=-net}
    else bucket.flats++;
    bucket.totalCommission+=fee;bucket.totalSwap+=swap;
   }
  }
 }
 // Drawdown uses broker close time, not opening chronology.
 const ordered=all.filter(x=>x.status==='CLOSED'&&x.realizedNet!==null)
   .sort((a,b)=>Date.parse(a.closedAt)-Date.parse(b.closedAt));
 let equity=0,high=0,maxDD=0;
 for(const x of ordered){
  equity+=x.realizedNet;high=Math.max(high,equity);
  maxDD=Math.max(maxDD,high-equity);
  const b=buckets.get(x.cohort+':'+x.route);
  b.netEquity+=x.realizedNet;
  b.highWaterNet=Math.max(b.highWaterNet,b.netEquity);
  b.maxClosedEquityDrawdown=Math.max(b.maxClosedEquityDrawdown,b.highWaterNet-b.netEquity);
 }
 const byRoute=[...buckets.values()].map(b=>({
  cohort:b.cohort,route:b.route,closed:b.closed,open:b.open,
  netComplete:b.netComplete,netIncomplete:b.netIncomplete,wins:b.wins,
  losses:b.losses,flats:b.flats,netTotal:money(b.netTotal),
  avgNetPerCompleteClose:b.netComplete?money(b.netTotal/b.netComplete):null,
  winRate:b.netComplete?pct(b.wins/b.netComplete):null,
  profitFactor:b.negativeNet>0?money(b.positiveNet/b.negativeNet):null,
  commission:money(b.totalCommission),swap:money(b.totalSwap),
  protectedProfitCloses:b.protectedProfitCloses,
  brokerCloses:b.brokerClose,maxClosedEquityDrawdown:money(b.maxClosedEquityDrawdown)
 }));
 const complete=ordered.length;
 const incomplete=all.filter(x=>x.status==='CLOSED'&&x.realizedNet===null).length;
 const total=money(ordered.reduce((n,x)=>n+x.realizedNet,0));
 const closedAfter=ordered.filter(x=>x.cohort==='CONTINUOUS');
 const groups={};
 for(const d of decisionGroups){
  const route=ALLOWED_ROUTES.has(d.route)?d.route:'OTHER';
  const reason=d.reason??'NONE';
  const key=route+' / '+reason;
  groups[key]=(groups[key]??0)+Number(d.scans||0);
 }
 return{
  artifact:ARTIFACT,authority:'READ_ONLY_EVIDENCE',modifiesExecution:false,
  generatedAt:now.toISOString(),window:{from,until},continuousStart:CONTINUOUS_START,
  summary:{
   independentOrders:all.length,closed:complete+incomplete,open:all.filter(x=>x.status==='OPEN').length,
   completeClosedAfterFees:complete,incompleteClosedFees:incomplete,
   realizedNet:total,continuousRealizedNet:money(closedAfter.reduce((n,x)=>n+x.realizedNet,0)),
   maxClosedEquityDrawdown:money(maxDD),
   openPositionsWithFreshRecordedMarks:all.filter(x=>x.status==='OPEN'&&x.latestObservationFresh).length
  },
  byRoute,positionLedger:all,scannerScanCountsNotIndependentTrades:groups,
  limitations:[
   'Closed net P&L requires broker-signed realised_pnl, commission and swap; missing fee data is excluded rather than treated as zero.',
   'Broker open-position observedGross = peak minus giveback is a stored observation, not a live executable exit quote, nor net after future commission.',
   'The scorecard includes original advisory, continuous, guarded pullback and independent PRIMARY_PLAN_B broker fills for the same strategy routes. These execution authorities are separate cohorts, not duplicate trades.',
   'Scanner scans are correlated per-minute pair-side evaluations, NOT trade outcomes.',
   'A completed profitable trial sample is not evidence of LIVE safety or future profit.',
   'This report places no order, changes no risk limit, modifies no stop/target, and never resets a trial.'
  ]
 };
}
async function run(){
 require('dotenv').config({path:resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const env=process.env;
 if(!env.VPS_FOREX_SCANNER_USER_ID||!env.DB_HOST||!env.DB_NAME||!env.DB_USER)
  throw Error('OWNER_DB_SCOPE_REQUIRED');
 const now=new Date();
 const c=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),database:env.DB_NAME,
  user:env.DB_USER,password:env.DB_PASSWORD,ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  connectionTimeoutMillis:6000,statement_timeout:25000});
 let begun=false;
 try{
  await c.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  const scope=await c.query(SCOPE,[env.VPS_FOREX_SCANNER_USER_ID]);
  if(scope.rows.length!==1)throw Error('NO_ACTIVE_CONNECTED_OWNER_PEPPERSTONE_DEMO');
  const params=[env.VPS_FOREX_SCANNER_USER_ID,scope.rows[0].id,START,now.toISOString()];
  const t=(await c.query(TRADES,params)).rows;
  if(t.length>1500)throw Error('TRADE_LEDGER_TRUNCATED');
  const d=(await c.query(DECISIONS,params)).rows;
  if(d.length>=200)throw Error('DECISION_GROUPS_TRUNCATED');
  const report=summarize(t,d,{from:START,until:now.toISOString(),now});
  await c.query('COMMIT');begun=false;
  mkdirSync(dirname(REPORT),{recursive:true,mode:0o700});
  const tmp=REPORT+'.tmp-'+process.pid;
  writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  chmodSync(tmp,0o600);renameSync(tmp,REPORT);
  console.log('CONTINUOUS_EVIDENCE',JSON.stringify({
   generatedAt:report.generatedAt,summary:report.summary,byRoute:report.byRoute,
   latest:report.positionLedger.slice(-7)
  }));
 }finally{if(begun)await c.query('ROLLBACK').catch(()=>{});await c.end()}
}
module.exports={val,money,summarize,START,CONTINUOUS_START,TRADES,DECISIONS};
if(require.main===module)run().catch(e=>{console.error('CONTINUOUS_EVIDENCE_ERROR',e.message);process.exitCode=1});
