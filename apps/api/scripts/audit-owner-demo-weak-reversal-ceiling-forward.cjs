#!/usr/bin/env node
'use strict';
/**
 * Strict owner Pepperstone USD DEMO post-deployment scorecard.
 * Uses entry-time immutable cap metadata and actual broker-settled net P&L.
 * No account API, no broker write, no trading changes, no counterfactual fills.
 */
const fs=require('node:fs'),path=require('node:path');
const confluence=require('./owner-demo-preentry-fee-conflict-shadow.cjs');
const frozenEntry=require('./owner-demo-preentry-fee-conflict-shadow-state.cjs');
const ARTIFACT='owner-demo-weak-reversal-ceiling-prospective-broker-outcomes-v1';
const RULE='owner-pepperstone-demo-weak-reversal-seven-lot-ceiling-v1';
const ACTIVATED_AT='2026-11-20T17:37:18.000Z'; // Verified API activation.
const OUT='/home/lightworld/webapps/irexpro-research/weak-reversal-forward';
const LIMIT=500;
const num=x=>x===undefined||x===null||x===''?null:
 Number.isFinite(Number(x))?Number(x):null;
const time=x=>x==null?NaN:new Date(x).getTime();
const rounded=x=>Number.isFinite(x)?+x.toFixed(2):null;
const validBool=x=>x==='true'?true:x==='false'?false:null;
const SQL=[
 'SELECT t.id::text AS trade_id,t.instrument,t.direction,t.opened_at,',
 't.closed_at,t.status,t.close_reason,t.lot_size,',
 't.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,t.profit_giveback,',
 "ti.metadata->>'multimodel_plan_b_route' AS route,",
 "ti.metadata->>'m1_owner_demo_weak_reversal_ceiling_artifact' AS cap_artifact,",
 "ti.metadata->>'m1_owner_demo_weak_reversal_ceiling_applied' AS cap_applied,",
 "ti.metadata->>'m1_owner_demo_weak_reversal_ceiling_reason' AS cap_reason,",
 "ti.metadata->>'m1_owner_demo_weak_reversal_ceiling_before_lots' AS cap_before,",
 "ti.metadata->>'m1_owner_demo_weak_reversal_ceiling_after_lots' AS cap_after,",
 "ti.metadata->>'m1_owner_demo_weak_reversal_ceiling_fee_warning' AS cap_fee_warning,",
 "ti.metadata->>'m1_owner_demo_weak_reversal_ceiling_loss_warning' AS cap_loss_warning,",
 "ti.metadata->>'m1_advisory_quality_risk_fraction' AS quality_fraction,",
 "ti.metadata->>'m1_owner_demo_ongoing_seven_lot_artifact' AS seven_lot_artifact,",
 "ti.metadata->>'m1_pepperstone_demo_pre_screen_lot_cap' AS broker_prescreen_cap,",
 'e.m1_decision_at,e.m1_decision_created_at,e.m1_entry_route,',
 'e.trained_expert_state,e.fee_shadow_reason,',
 'e.fee_shadow_sample_count,e.fee_shadow_after_fee_expected_r,',
 'e.fee_shadow_minimum_after_fee_r,',
 'e.model_loss_brake_active,e.model_loss_brake_negative_payoff,',
 'e.model_loss_brake_payoff_closed_trades,e.model_loss_brake_recent_closed_trades,',
 'e.aligned_h1_at_entry,e.aligned_m5_at_entry',
 'FROM trading.trades t',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
 'AND ti.broker_connection_id=t.broker_connection_id',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'LEFT JOIN LATERAL (SELECT z.evaluated_at AS m1_decision_at,',
 'z.created_at AS m1_decision_created_at,z.route AS m1_entry_route,',
 "z.governance->'multimodelTrainedExpert'->>'state' AS trained_expert_state,",
 "z.governance->'demoBrokerCommissionGate'->>'shadowReason' AS fee_shadow_reason,",
 "z.governance->'demoBrokerCommissionGate'->>'sampleCount' AS fee_shadow_sample_count,",
 "z.governance->'demoBrokerCommissionGate'->>'shadowAfterFeeExpectedR' AS fee_shadow_after_fee_expected_r,",
 "z.governance->'demoBrokerCommissionGate'->>'minimumAfterFeeR' AS fee_shadow_minimum_after_fee_r,",
 "z.governance->'multimodelLossStreakBrake'->>'active' AS model_loss_brake_active,",
 "z.governance->'multimodelLossStreakBrake'->>'negativePayoff' AS model_loss_brake_negative_payoff,",
 "z.governance->'multimodelLossStreakBrake'->>'payoffClosedTrades' AS model_loss_brake_payoff_closed_trades,",
 "z.governance->'multimodelLossStreakBrake'->>'recentClosedTrades' AS model_loss_brake_recent_closed_trades,",
 "z.candidate->>'alignedH1' AS aligned_h1_at_entry,",
 "z.candidate->>'alignedM5' AS aligned_m5_at_entry",
 'FROM trading.m1_tactical_decisions z',
 'WHERE z.trade_intent_id=ti.id AND z.user_id=t.user_id',
 'AND z.broker_connection_id=t.broker_connection_id',
 'AND z.created_at<=t.opened_at AND z.evaluated_at<=t.opened_at',
 'ORDER BY z.evaluated_at DESC,z.id DESC LIMIT 1) e ON TRUE',
 "WHERE t.user_id=$1 AND t.broker_connection_id=$2",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND t.account_currency='USD' AND t.opened_at>=$3::timestamptz",
 'AND t.opened_at<=$4::timestamptz',
 'ORDER BY t.opened_at,t.id LIMIT 501',
].join(' ');
function decode(row,asOf) {
 const opened=time(row.opened_at),closed=time(row.closed_at),now=time(asOf);
 if(!row.trade_id||!['BUY','SELL'].includes(row.direction)||
  !['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION'].includes(row.route)||
  !Number.isFinite(opened)||opened<Date.parse(ACTIVATED_AT)||opened>now||
  !['OPEN','CLOSED'].includes(row.status))
  throw Error('INVALID_POST_RELEASE_EXACT_DEMO_TRADE');
 const capBefore=num(row.cap_before),capAfter=num(row.cap_after),
  lots=num(row.lot_size),quality=num(row.quality_fraction),
  fee=validBool(row.cap_fee_warning),loss=validBool(row.cap_loss_warning),
  applied=validBool(row.cap_applied);
 if(!(lots>0))throw Error('INVALID_POST_RELEASE_BROKER_LOTS');
 const provenance=row.cap_artifact===RULE && applied!==null &&
  capBefore!==null && capAfter!==null && capBefore>0 &&
  capAfter>0 && capAfter<=capBefore &&
  (fee!==null)&&(loss!==null) &&
  (applied ? row.route==='CONFIRMED_REVERSAL' &&
   capBefore>4 && capAfter<=4 &&
   capAfter<=capBefore && !!row.seven_lot_artifact &&
   quality!==null && quality>=.2 && quality<=.5 &&
   (fee||loss) &&
   row.cap_reason==='WEAK_CONFIRMATION_PLUS_INDEPENDENT_COST_OR_LOSS_WARNING'
   : capBefore===capAfter);
 const group=!provenance?'PROVENANCE_INCOMPLETE_OR_INVALID':
  row.route!=='CONFIRMED_REVERSAL'?'OTHER_ROUTE_UNCHANGED':
  applied?'WEAK_CONFIRMED_REVERSAL_CAPPED':
  'CONFIRMED_REVERSAL_UNCHANGED';
 if(row.status==='CLOSED'&&(!Number.isFinite(closed)||closed<opened||closed>now))
  throw Error('INVALID_BROKER_SETTLEMENT_CLOCK');
 const gross=num(row.realised_pnl),commission=num(row.commission),swap=num(row.swap);
 const fullySettled=row.status==='CLOSED'&&
  [gross,commission,swap].every(x=>x!==null);
 const net=fullySettled?rounded(gross+commission+swap):null;
 return {
  tradeId:row.trade_id,
  openedAt:new Date(opened).toISOString(),
  closedAt:row.status==='CLOSED'?new Date(closed).toISOString():null,
  instrument:row.instrument,direction:row.direction,route:row.route,
  accountType:'DEMO',currency:'USD',
  status:row.status,closeReason:row.status==='CLOSED'?row.close_reason:null,
  group,provenanceValid:provenance,
  capApplied:provenance?applied:null,
  capReason:row.cap_reason??null,
  requestedCapBefore:capBefore,requestedCapAfter:capAfter,
  actualFilledLots:lots,
  afterCommissionWarning:fee,recentStrategyLossWarning:loss,
  qualityFraction:quality,
  sevenLotAuthorization:Boolean(row.seven_lot_artifact),
  capCannotIncreaseLots:capBefore!==null&&capAfter!==null&&capAfter<=capBefore,
  settledBrokerNetUsd:net,
  fullySettled,
  brokerGrossUsd:fullySettled?rounded(gross):null,
  brokerCommissionUsd:fullySettled?rounded(commission):null,
  brokerSwapUsd:fullySettled?rounded(swap):null,
  observedGrossPeakUsd:num(row.max_favorable_pnl),
  observedProfitGivebackUsd:num(row.profit_giveback),
  actualAfterCostWinningTrade:net===null?null:net>0,
  actualAfterCostLosingTrade:net===null?null:net<0,
 };
}
function totals(rows){
 const complete=rows.filter(r=>r.fullySettled&&r.settledBrokerNetUsd!==null),
  wins=complete.filter(r=>r.settledBrokerNetUsd>0),
  losses=complete.filter(r=>r.settledBrokerNetUsd<0),
  winnings=wins.reduce((s,r)=>s+r.settledBrokerNetUsd,0),
  lost=losses.reduce((s,r)=>s+r.settledBrokerNetUsd,0);
 return {
  totalTrades:rows.length,openPositions:rows.filter(r=>r.status==='OPEN').length,
  settled:complete.length,closedWithMissingBrokerEconomics:
    rows.filter(r=>r.status==='CLOSED'&&!r.fullySettled).length,
  winners:wins.length,losers:losses.length,
  breakeven:complete.length-wins.length-losses.length,
  bookedNetUsd:rounded(winnings+lost),bookedWinningUsd:rounded(winnings),
  bookedLosingUsd:rounded(lost),
  bookedProfitFactor:lost<0?rounded(winnings/-lost):null,
  grossPeakToAfterFeeLossTrades:losses.filter(r=>
    Number.isFinite(r.observedGrossPeakUsd)&&r.observedGrossPeakUsd>0).length,
  // Post-exit diagnostics: compare the actually sampled gross peak with
  // final settled broker commission+swap. NEVER use final fees as pre-entry
  // knowledge or infer an executable profitable exit at the peak.
  lossesWithSampledPeakExceedingFinalBrokerCosts:losses.filter(r=>
    Number.isFinite(r.observedGrossPeakUsd)&&
    r.observedGrossPeakUsd+r.brokerCommissionUsd+r.brokerSwapUsd>0).length,
  lossesWithSampledPeakAtOrBelowFinalBrokerCosts:losses.filter(r=>
    Number.isFinite(r.observedGrossPeakUsd)&&
    r.observedGrossPeakUsd+r.brokerCommissionUsd+r.brokerSwapUsd<=0).length,
  sampledPeakNotExecutableBrokerExit:true,
  distinctTradingDays:[...new Set(rows.map(r=>r.openedAt.slice(0,10)))].length,
 };
}
function clusters(rows){
 const closed=rows.filter(r=>r.fullySettled).sort((a,b)=>
  time(a.closedAt)-time(b.closedAt));
 let run=[],best=[];
 const episodes=[];
 for(const r of closed){
  if(r.settledBrokerNetUsd<0) {
   run.push(r);
   if(run.length>best.length)best=[...run];
   if(run.length>=3){
    const last3=run.slice(-3);
    const span=(time(last3[2].closedAt)-time(last3[0].closedAt))/60000;
    if(span<=20)episodes.push({
      firstClose:last3[0].closedAt,lastClose:last3[2].closedAt,
      spanMinutes:rounded(span),
      bookedNetUsd:rounded(last3.reduce((s,x)=>s+x.settledBrokerNetUsd,0)),
      instruments:last3.map(x=>x.instrument),
      actualBrokerLosses:3,
      noAutoPause:true,
    });
   }
  }else run=[];
 }
 return {longestConsecutiveLosses:best.length,
  threeLossesWithin20MinCount:episodes.length,episodes,
  researchOnly:true,noAutomaticTradingPause:true};
}
function analyze(rows,asOf=new Date()){
 const parsed=rows.map(r=>decode(r,asOf));
 const valid=parsed.filter(r=>r.provenanceValid),
  capped=valid.filter(r=>r.group==='WEAK_CONFIRMED_REVERSAL_CAPPED'),
  unchanged=valid.filter(r=>r.group==='CONFIRMED_REVERSAL_UNCHANGED');
 const dayKeys=[...new Set(parsed.map(r=>r.openedAt.slice(0,10)))].sort();
 const days=Object.fromEntries(dayKeys.map(d=>[d,{
  all:totals(parsed.filter(r=>r.openedAt.startsWith(d))),
  capped:totals(capped.filter(r=>r.openedAt.startsWith(d))),
  confirmedReversalUnchanged:totals(unchanged.filter(r=>r.openedAt.startsWith(d))),
 }]));
 return {
  artifact:ARTIFACT,asOf:new Date(asOf).toISOString(),
  activatedAt:ACTIVATED_AT,
  readOnly:true,brokerOrders:0,modifiesTradeExecution:false,
  autoPromote:false,promotableToLive:false,
  source:'REAL_BROKER_SETTLEMENT_JOINED_TO_IMMUTABLE_ENTRY_TIME_INTENT',
  exactScope:'ONE_OWNER_PEPPERSTONE_CTRADER_USD_DEMO',
  all:totals(parsed),
  byGroup:{
    weakConfirmedReversalCapped:totals(capped),
    confirmedReversalUnchanged:totals(unchanged),
    otherRouteUnchanged:totals(valid.filter(r=>r.group==='OTHER_ROUTE_UNCHANGED')),
    provenanceIncompleteOrInvalid:totals(parsed.filter(r=>!r.provenanceValid)),
  },
  lossClusterObservations:clusters(parsed),
  daily:days,
  actualUniqueTradeIds:true,
  excludesPreActivationEntries:true,
  openPositionsNotCountedAsWonOrLost:true,
  costUnknownNotCountedAsSettled:true,
  doesNotRepriceBrokerFills:true,
  noCounterfactualPnLOrClaimedSavings:true,
  sampleSizeInsufficientForPromotion:dayKeys.length<5||
    capped.filter(r=>r.fullySettled).length<20||
    unchanged.filter(r=>r.fullySettled).length<20,
  inspectedTradeOutcomes:parsed,
 };
}
async function run(){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 const env='/home/lightworld/webapps/irexpro-staging/apps/api/.env';
 require('/home/lightworld/webapps/irexpro-staging/apps/api/node_modules/dotenv').config({path:env,quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID,
  conn=process.env.IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID;
 if(!uuid.test(owner||'')||!uuid.test(conn||''))throw Error('INVALID_EXACT_OWNER_DEMO_SCOPE');
 const {Client}=require('/home/lightworld/webapps/irexpro-staging/apps/api/node_modules/pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  connectionTimeoutMillis:6000,statement_timeout:15000,
  application_name:'irexpro-owner-weak-reversal-forward-only-READONLY'});
 const now=new Date();let rows;
 // Freeze hypothesis activation BEFORE reading newly opened trades. New
 // observations cannot inherit known outcomes or old history from before
 // this independent rule existed.
 const activation=frozenEntry.setup(OUT,owner,conn,now);
 await db.connect();
 try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  rows=(await db.query(SQL,[owner,conn,ACTIVATED_AT,now.toISOString()])).rows;
  if(rows.length>LIMIT)throw Error('BOUND_REACHED_REFUSE_INCOMPLETE_SCORE');
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 const result=analyze(rows,now);
 // Monotonic immutable first-OPEN observations. Any trade first seen after
 // closure is marked missed, NOT retrospectively scored as a warning.
 const previous=frozenEntry.load(OUT,activation);
 const newlyFrozen=frozenEntry.freeze(rows,previous,activation,now);
 if(newlyFrozen.newCaptures)frozenEntry.save(OUT,newlyFrozen.state);
 const observations=newlyFrozen.state.observations;
 result.preEntryConfluenceShadow=confluence.summarize(
  result.inspectedTradeOutcomes,observations,activation.activatedAt);
 result.preEntryConfluenceFrozenActivation=activation.activatedAt;
 result.preEntryConfluenceNewlyObservedThisTick=newlyFrozen.newCaptures;
 for(const position of result.inspectedTradeOutcomes){
  if(Date.parse(position.openedAt)>=Date.parse(activation.activatedAt))
   position.preEntryConfluenceFrozen=observations[position.tradeId]||null;
 }
 fs.mkdirSync(OUT,{recursive:true,mode:0o700});
 const temporary=path.join(OUT,'latest-report.json.tmp-'+process.pid);
 const destination=path.join(OUT,'latest-report.json');
 try{
  fs.writeFileSync(temporary,JSON.stringify(result,null,2)+'\n',
   {mode:0o600,flag:'wx'});
  fs.renameSync(temporary,destination);
 }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary)}
 return result;
}
if(require.main===module)run().then(result=>console.log(JSON.stringify({
 at:result.asOf,all:result.all,groups:result.byGroup,
 lossClusters:result.lossClusterObservations.threeLossesWithin20MinCount,
 researchOnly:true,autoPromote:false,
 output:path.join(OUT,'latest-report.json'),
}))).catch(e=>{console.error('RESEARCH_AUDIT_FAILED',e.message);process.exitCode=1});
module.exports={ARTIFACT,RULE,ACTIVATED_AT,SQL,decode,totals,clusters,analyze,run};
