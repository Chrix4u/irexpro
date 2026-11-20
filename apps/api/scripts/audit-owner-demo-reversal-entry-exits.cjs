#!/usr/bin/env node
'use strict';
/**
 * Broker-verified owner USD DEMO ONLY. Read-only entry timing and profit-peak
 * threshold audit. Historical peak != executable alternate close or fill.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='owner-demo-reversal-entry-profit-protection-forensics-v1';
const ROOT='/home/lightworld/webapps/irexpro-research/reversal-entry-profit-review';
const ACTIVATE='/home/lightworld/webapps/irexpro-research/loss-pattern-forward/activation.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
 "SELECT t.id::text trade_id,t.opened_at,t.closed_at,t.instrument,t.direction,",
 "t.lot_size,t.realised_pnl,t.commission,t.swap,t.close_reason,t.status,",
 "t.max_favorable_pnl,t.max_adverse_pnl,t.path_observation_count,",
 "ti.metadata,ca.sizing_inputs,d.route m1_route,d.blockers,",
 "d.evaluated_at decision_at,d.candidate,d.governance",
 "FROM trading.trades t",
 "JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
 "AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id",
 "LEFT JOIN LATERAL (SELECT ca.sizing_inputs FROM trading.capital_allocations ca",
 "WHERE ca.user_id=t.user_id AND ca.trade_intent_id=t.trade_intent_id",
 "AND ca.created_at<=t.opened_at ORDER BY ca.created_at DESC,ca.id DESC LIMIT 1) ca ON TRUE",
 "LEFT JOIN LATERAL (SELECT d.route,d.blockers,d.evaluated_at,d.candidate,d.governance",
 "FROM trading.m1_tactical_decisions d WHERE d.user_id=t.user_id",
 "AND d.broker_connection_id=t.broker_connection_id",
 "AND d.trade_intent_id=t.trade_intent_id AND d.evaluated_at<=t.opened_at",
 "ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 1) d ON TRUE",
 "WHERE t.user_id=$1 AND b.user_id=$1 AND b.deleted_at IS NULL",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD'",
 "AND t.status='CLOSED' AND t.opened_at>=$2::timestamptz",
 "AND t.closed_at<=$3::timestamptz",
 "ORDER BY t.closed_at DESC,t.id DESC LIMIT 501"
].join(' ');
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const round=(x,n=2)=>x==null||!Number.isFinite(x)?null:Number(x.toFixed(n));
const when=x=>{const n=new Date(x).getTime();return Number.isFinite(n)?n:null;};
const sum=items=>round(items.reduce((a,x)=>a+x,0));
function peakGate({peak,risk,fee,fraction}) {
 if (![peak,risk,fee,fraction].every(Number.isFinite)||
   risk<=0||fee<=0||peak<0||fraction<=0||fraction>1)
   return {state:'NO_CAUSAL_FEE_OR_RISK',reached:false,threshold:null};
 const threshold=Math.max(risk*fraction,fee*1.8,fee+risk*.15);
 return {state:peak>=threshold?'PEAK_THRESHOLD_REACHED':'BELOW_PEAK_THRESHOLD',
  reached:peak>=threshold,threshold:round(threshold)};
}
function analyze(row,activationAt) {
 const entry=row.metadata||{},candidate=row.candidate||{},
   governance=row.governance||{},sizing=row.sizing_inputs||{};
 const lots=num(row.lot_size),risk=num(sizing.finalRiskAtStop);
 const feePerLot=num(sizing.demoExecutionRiskEnvelope?.historicalFeePerLot);
 const fee=lots>0&&feePerLot>0?lots*feePerLot:null;
 const peak=num(row.max_favorable_pnl),gross=num(row.realised_pnl),
   bookedFee=num(row.commission),swap=num(row.swap);
 const net=[gross,bookedFee,swap].every(Number.isFinite)?
   sum([gross,bookedFee,swap]):null;
 const route=entry.multimodel_plan_b_route||
   governance.multimodelEnsemble?.strategyRoute||null;
 const m5Body=num(candidate.alignedM5LatestBodyPressure),
   h1=num(candidate.alignedH1),h4=num(candidate.alignedH4);
 const baseline=peakGate({peak,risk,fee,fraction:.5});
 const hypothesis=peakGate({peak,risk,fee,fraction:.25});
 return {
  openedAt:new Date(row.opened_at).toISOString(),
  closedAt:new Date(row.closed_at).toISOString(),
  cohort:when(row.opened_at)>=when(activationAt)?
    'FROZEN_FORWARD':'PRE_ACTIVATION_HISTORICAL',
  pair:row.instrument,side:row.direction,route,lot:lots,
  closeReason:row.close_reason,
  pnl:{gross:round(gross),commission:round(bookedFee),swap:round(swap),
    net,peakBrokerNet:round(peak),
    worstBrokerNet:round(num(row.max_adverse_pnl)),
    pathObservations:Number(row.path_observation_count||0)},
  entry:{
    m1Route:row.m1_route,
    reversalTimingUnconfirmed:Array.isArray(row.blockers)&&
      row.blockers.includes('MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'),
    expertState:governance.multimodelTrainedExpert?.state||
      entry.multimodel_trained_expert_state||null,
    authority:entry.multimodel_execution_authority_path||null,
    m5BodyPressure:round(m5Body,4),
    m5BodyOpposing:m5Body==null?null:m5Body<=-.3,
    h1:round(h1,4),h4:round(h4,4),
    bothHigherOpposing:h1==null||h4==null?null:h1<=-.25&&h4<=-.25,
  },
  profitStudy:{
    initialStopRisk:round(risk),observedPeakR:risk>0&&peak!=null?
      round(peak/risk,3):null,
    entryKnownFeePerLot:round(feePerLot),
    entryKnownConservativeReserve:round(fee),
    currentPeak50PercentGate:baseline,
    researchPeak25PercentGate:hypothesis,
    lowerThresholdOnly:hypothesis.reached&&!baseline.reached,
    theoreticalPeakAfterReserve:fee==null||peak==null?null:
      round(peak-fee),
    actionableFillDemonstrated:false,estimatedSavedProfit:null,
  },
 };
}
function summary(rows) {
 const settled=rows.filter(r=>r.pnl.net!=null);
 return {trades:rows.length,winners:settled.filter(r=>r.pnl.net>0).length,
  losers:settled.filter(r=>r.pnl.net<0).length,
  netUsd:sum(settled.map(r=>r.pnl.net)),
  independentUtcDays:new Set(rows.map(r=>r.openedAt.slice(0,10))).size,
  m1ReversalUnconfirmed:rows.filter(r=>r.entry.reversalTimingUnconfirmed).length,
  expertAbstained:rows.filter(r=>r.entry.expertState==='ABSTAIN').length,
  opposingM5Body:rows.filter(r=>r.entry.m5BodyOpposing===true).length,
  lowerPeakThresholdOnly:rows.filter(r=>r.profitStudy.lowerThresholdOnly).length,
  favorablePeakThenSettledLoss:rows.filter(r=>r.pnl.peakBrokerNet>0&&r.pnl.net<0).length,
 };
}
function grouping(rows,fn) {
 const groups={};
 for(const r of rows){const k=fn(r);(groups[k]??=[]).push(r);}
 return Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,summary(v)]));
}
async function audit(db,{owner,since,through,activatedAt}) {
 if(!UUID.test(owner||''))throw Error('INVALID_OWNER');
 const start=when(since),end=when(through);
 if([start,end,when(activatedAt)].some(x=>x==null)||
   start>=end||end-start>21*86400000)throw Error('INVALID_TIME_WINDOW');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='30000ms'");
  const raw=(await db.query(SQL,[owner,since,through])).rows;
  if(raw.length>500)throw Error('COHORT_TRUNCATED');
  await db.query('COMMIT');
  const records=raw.map(x=>analyze(x,activatedAt)).filter(x=>
    ['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION'].includes(x.route));
  const forward=records.filter(x=>x.cohort==='FROZEN_FORWARD');
  const historical=records.filter(x=>x.cohort==='PRE_ACTIVATION_HISTORICAL');
  const forwardReversal=forward.filter(x=>x.route==='CONFIRMED_REVERSAL');
  const historicalReversal=historical.filter(x=>x.route==='CONFIRMED_REVERSAL');
  const bodyBucket=x=>x.entry.m5BodyOpposing===true?
    'OPPOSING':'NOT_OPPOSING_OR_UNKNOWN';
  return {artifact:ARTIFACT,generatedAt:new Date().toISOString(),broker:'pepperstone-ctrader',
   accountType:'DEMO',currency:'USD',researchOnly:true,brokerOrders:0,
   modifiesExecution:false,changesLots:false,changesStops:false,
   autoPromotionAllowed:false,since,through,activatedAt,
   historical:summary(historical),forward:summary(forward),
   byForwardRoute:grouping(forward,x=>x.route),
   byForwardM5BodyPressure:grouping(forward,bodyBucket),
   byHistoricalM5BodyPressure:grouping(historical,bodyBucket),
   byForwardConfirmedReversalM5BodyPressure:grouping(forwardReversal,bodyBucket),
   byHistoricalConfirmedReversalM5BodyPressure:grouping(historicalReversal,bodyBucket),
   confirmedReversalProspectiveMaturity:{
     observedTrades:forwardReversal.length,
     distinctUtcDays:summary(forwardReversal).independentUtcDays,
     sufficientToAutoChangeExecution:false,
   },
   latestTrades:records.slice(0,15),forwardTrades:forward,
   caveats:[
    'Settled PnL is broker-recorded; peak broker PnL is observational.',
    'A historical peak cannot prove the time or fill of a hypothetical lower profit lock.',
    'The 0.25R threshold is research-only; no existing broker stops, targets or trading logic are modified.',
    'Only fee evidence frozen at entry is used; missing evidence is never treated as a free exit.',
    'Training trades are correlated, not independent observations or validated trading filters.',
    'No new automatic trade vetos or strategy promotion; owner Start/Stop is unchanged.',
   ]};
 }catch(err){await db.query('ROLLBACK').catch(()=>{});throw err;}
}
async function main() {
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const activatedAt=JSON.parse(fs.readFileSync(ACTIVATE,'utf8')).activatedAt;
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  application_name:'irexpro-owner-reversal-profit-audit-readonly',
  connectionTimeoutMillis:8000,statement_timeout:30000});
 try{
  await db.connect();
  const through=new Date().toISOString(),
    since=process.env.IREXPRO_REVERSAL_FORENSIC_SINCE||
      new Date(Date.now()-4*86400000).toISOString();
  const result=await audit(db,{
    owner:process.env.VPS_FOREX_SCANNER_USER_ID,since,through,activatedAt});
  fs.mkdirSync(ROOT,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(ROOT,'latest-report.json'),
    JSON.stringify(result,null,2),{mode:0o600});
  console.log('REVERSAL_ENTRY_EXIT_FORENSICS',JSON.stringify({
    created:result.generatedAt,
    historical:result.historical,forward:result.forward,
    byForwardRoute:result.byForwardRoute,
    byForwardM5Body:result.byForwardConfirmedReversalM5BodyPressure,
    byHistoricalM5Body:result.byHistoricalConfirmedReversalM5BodyPressure,
    latest:result.latestTrades.slice(0,8).map(x=>({
      pair:x.pair,side:x.side,route:x.route,net:x.pnl.net,
      peakR:x.profitStudy.observedPeakR,
      research25PeakOnly:x.profitStudy.lowerThresholdOnly,
    })),
  }));
 }finally{await db.end();}
}
module.exports={ARTIFACT,SQL,peakGate,analyze,summary,grouping,audit};
if(require.main===module)main().catch(e=>{
 console.error('REVERSAL_ENTRY_EXIT_AUDIT_FAILED',String(e.message||e).slice(0,250));
 process.exitCode=1;
});
