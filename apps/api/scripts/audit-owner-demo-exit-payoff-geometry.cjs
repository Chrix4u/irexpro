#!/usr/bin/env node
'use strict';
/**
 * Owner Pepperstone cTrader USD DEMO research: compare causal ORIGINAL
 * M1 decision/intent stop/target geometry to broker settled economics,
 * keeping broker-close, independent guard-close and profit protection
 * attribution distinct. Read-only; no model updates or broker orders.
 */
const path=require('node:path'),fs=require('node:fs');
const FROM='2026-11-17T00:00:00.000Z';
const MAX=800,OUT='/home/lightworld/webapps/irexpro-research/exit-payoff/latest-report.json';
const TRIAL='owner-pepperstone-demo-four-plus-until-20261120t1200z-v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const QUERY=[
 'SELECT t.id::text AS trade_id,t.instrument,t.direction,t.opened_at,t.closed_at,',
 't.status,t.close_reason,t.lot_size,t.fill_price,t.exit_price,',
 't.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,',
 't.max_adverse_pnl,t.profit_giveback,t.path_peak_observed_at,',
 'ti.created_at AS intent_at,ti.stop_loss AS original_intent_stop,',
 'ti.take_profit AS original_intent_target,ti.metadata,',
 'EXISTS(SELECT 1 FROM audit.audit_logs a WHERE a.actor_user_id=t.user_id',
 "AND a.resource_type='Trade' AND a.resource_id=t.id::text",
 "AND a.action='TRADE_CLOSE_REQUESTED'",
 "AND a.created_at>=t.opened_at AND a.created_at<=t.closed_at + interval '2 minutes')",
 'AS app_close_request_persisted,',
 'EXISTS(SELECT 1 FROM trading.orders o WHERE o.trade_id=t.id AND o.user_id=t.user_id',
 "AND o.created_at>=t.opened_at AND o.created_at<=t.closed_at + interval '2 minutes')",
 'AS linked_postopen_order_persisted,',
 'd.id::text AS decision_id,d.created_at AS decision_recorded_at,',
 'd.evaluated_at AS decision_evaluated_at,d.candidate,d.governance,',
 "ca.sizing_inputs->>'finalRiskAtStop' AS allocated_stop_risk_usd,",
 "ca.sizing_inputs->>'riskPercent' AS allocated_risk_percent,",
 'EXISTS(SELECT 1 FROM audit.audit_logs a WHERE a.actor_user_id=t.user_id',
 "AND a.resource_type='Trade' AND a.resource_id=t.id::text",
 "AND a.action='TRADE_CLOSE_REQUESTED'",
 "AND a.metadata->>'closeReason'='AI_CLOSE_SIGNAL'",
 "AND a.metadata->'aiCloseTrigger'->>'source'='DEMO_DRAWDOWN_GUARD'",
 "AND a.created_at>=t.opened_at AND a.created_at<=t.closed_at + interval '2 minutes') AS verified_guard_close",
 'FROM trading.trades t',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
 'AND ti.broker_connection_id=t.broker_connection_id',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'LEFT JOIN trading.m1_tactical_decisions d ON d.id=',
 "CASE WHEN ti.metadata->>'m1_decision_id' ~ '^[a-f0-9-]{36}$'",
 "THEN (ti.metadata->>'m1_decision_id')::uuid ELSE NULL END",
 'AND d.user_id=t.user_id AND d.broker_connection_id=t.broker_connection_id',
 'LEFT JOIN LATERAL(SELECT z.sizing_inputs FROM trading.capital_allocations z',
 'WHERE z.user_id=t.user_id AND z.trade_intent_id=ti.id',
 'ORDER BY z.created_at DESC LIMIT 1) ca ON TRUE',
 'WHERE t.user_id=$1 AND b.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD' AND b.deleted_at IS NULL",
 "AND t.status='CLOSED' AND t.closed_at IS NOT NULL",
 'AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL',
 'AND t.opened_at>=$2::timestamptz',
 'ORDER BY t.opened_at ASC,t.id LIMIT 801'
].join(' ');
const val=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const rounded=(x,p=2)=>Number(x.toFixed(p));
const mean=x=>x.length?rounded(x.reduce((s,v)=>s+v,0)/x.length,4):null;
const median=x=>{if(!x.length)return null;const y=[...x].sort((a,b)=>a-b);const n=y.length;return rounded(n%2?y[(n-1)/2]:(y[n/2-1]+y[n/2])/2,4)};
function signedDist(entry,barrier,side,kind){
 if(![entry,barrier].every(Number.isFinite))return null;
 const d=(side==='BUY'?1:-1)*(barrier-entry);
 return kind==='target'?d:-d;
}
function quoteRiskUsd(instrument,lot,entry,stop){
 if(!/^(EURUSD|AUDUSD|USDCAD|USDJPY)$/.test(instrument)||
  ![lot,entry,stop].every(Number.isFinite)||lot<=0||entry<=0)return null;
 const quoted=Math.abs(entry-stop)*lot*100000;
 return instrument.startsWith('USD')?quoted/entry:quoted;
}
function pipOf(instrument){return instrument.endsWith('JPY')?.01:.0001;}
function decode(row){
 const lot=val(row.lot_size),fill=val(row.fill_price),exit=val(row.exit_price),
  originalStop=val(row.original_intent_stop),
  originalTarget=val(row.original_intent_target),
  gross=val(row.realised_pnl),commission=val(row.commission),swap=val(row.swap);
 const opened=ms(row.opened_at),closed=ms(row.closed_at),
  intentAt=ms(row.intent_at),decisionAt=ms(row.decision_evaluated_at),
  recordedAt=ms(row.decision_recorded_at);
 if(!row.trade_id||!['BUY','SELL'].includes(row.direction)||
  !['EURUSD','AUDUSD','USDCAD','USDJPY'].includes(row.instrument)||
  ![lot,fill,exit,gross,commission,swap].every(x=>x!==null)||
  ![opened,closed,intentAt].every(Number.isFinite)||
  lot<=0||fill<=0||opened>closed||intentAt>opened)
  throw Error('INVALID_COMPLETE_BROKER_TRADE_ECONOMICS');
 const m=row.metadata??{},candidate=row.candidate??{},
  model=row.governance?.multimodelGovernance??{};
 const originalDecisionVerified=!!row.decision_id&&
  [decisionAt,recordedAt].every(Number.isFinite)&&
  decisionAt<=recordedAt&&recordedAt<=intentAt&&
  opened-decisionAt>=0&&opened-decisionAt<=600000&&
  candidate.instrument===row.instrument&&candidate.direction===row.direction&&
  [val(candidate.entry),val(candidate.stopLoss),val(candidate.takeProfit)].every(x=>x!==null)&&
  originalStop!==null&&originalTarget!==null&&
  Math.abs(val(candidate.stopLoss)-originalStop)<=.00000051&&
  Math.abs(val(candidate.takeProfit)-originalTarget)<=.00000051;
 const decisionEntry=originalDecisionVerified?val(candidate.entry):null;
 const plannedRiskDistance=decisionEntry!==null?
  signedDist(decisionEntry,originalStop,row.direction,'stop'):null;
 const plannedRewardDistance=decisionEntry!==null?
  signedDist(decisionEntry,originalTarget,row.direction,'target'):null;
 const validPlan=originalDecisionVerified&&plannedRiskDistance>0&&plannedRewardDistance>0;
 const plannedRewardToRisk=validPlan?plannedRewardDistance/plannedRiskDistance:null;
 const fillRiskDist=originalStop===null?null:signedDist(fill,originalStop,row.direction,'stop');
 const fillRewardDist=originalTarget===null?null:signedDist(fill,originalTarget,row.direction,'target');
 const validFillGeometry=fillRiskDist!==null&&fillRiskDist>0&&fillRewardDist!==null&&fillRewardDist>0;
 const fillRisk=validFillGeometry?quoteRiskUsd(row.instrument,lot,fill,originalStop):null;
 const allocatedRisk=val(row.allocated_stop_risk_usd);
 const net=rounded(gross+commission+swap);
 const sourceGuard=Boolean(row.verified_guard_close)&&row.close_reason==='AI_CLOSE_SIGNAL';
 const closeClass=row.close_reason==='AI_CLOSE_SIGNAL'
  ?(sourceGuard?'INDEPENDENT_GUARD_REQUEST':'OTHER_OR_UNVERIFIED_AI_CLOSE')
  :String(row.close_reason||'UNKNOWN');
 const barrierDistance=validFillGeometry&&exit!==null?{
  stopPips:rounded(Math.abs(exit-originalStop)/pipOf(row.instrument),3),
  targetPips:rounded(Math.abs(exit-originalTarget)/pipOf(row.instrument),3),
 }:null;
 const nearOriginalStop=!!barrierDistance&&barrierDistance.stopPips<=2;
 const nearOriginalTarget=!!barrierDistance&&barrierDistance.targetPips<=2;
 const observedPeak=val(row.max_favorable_pnl);
 const observedDrawdown=val(row.max_adverse_pnl);
 const peakAt=ms(row.path_peak_observed_at);
 const settledDurationMin=rounded((closed-opened)/60000,2);
 const trial=m.m1_owner_demo_noon_lot_trial_artifact===TRIAL;
 const peakProvenance=Number.isFinite(peakAt)&&peakAt>=opened&&peakAt<=closed;
 return {
  tradeId:row.trade_id,openedAt:new Date(opened).toISOString(),
  dayUtc:new Date(opened).toISOString().slice(0,10),
  instrument:row.instrument,direction:row.direction,route:String(m.multimodel_plan_b_route||'UNKNOWN'),
  closeClass,originalCloseReason:row.close_reason||'UNKNOWN',isTrial:trial,
  // Audited application request/order records ONLY. The absence of an
  // application request cannot identify the provider's native close reason.
  appCloseRequestEvidence:row.app_close_request_persisted===true?'PERSISTED':
   row.app_close_request_persisted===false?'NOT_RECORDED':'UNKNOWN',
  linkedPostOpenOrderEvidence:row.linked_postopen_order_persisted===true?'PERSISTED':
   row.linked_postopen_order_persisted===false?'NOT_RECORDED':'UNKNOWN',
  preEntryM5Opposition:originalDecisionVerified&&val(candidate.alignedM5)!==null?
   val(candidate.alignedM5)<=-0.2:null,
  preEntryM5Value:originalDecisionVerified?val(candidate.alignedM5):null,
  trialCohort:trial?'EXPLICIT_OWNER_HIGH_LOT':'BASELINE_OTHER',closedAt:new Date(closed).toISOString(),
  filledLots:lot,netUsd:net,netPerLotUsd:rounded(net/lot),
  grossUsd:gross,commissionUsd:commission,swapUsd:swap,
  win:net>0,loss:net<0,
  originalDecisionVerified,plannedGeometryVerified:validPlan,
  plannedRewardToRisk:plannedRewardToRisk===null?null:rounded(plannedRewardToRisk,4),
  preEntryForecastNetR:originalDecisionVerified?val(model.netExpectedR):null,
  fillGeometryVerified:validFillGeometry,
  stopRiskFromFillAndIntentUsd:fillRisk===null?null:rounded(fillRisk,2),
  allocatedRiskEvidenceUsd:allocatedRisk,
  realizedNetRFromFillStop:fillRisk&&fillRisk>0?rounded(net/fillRisk,4):null,
  filledRewardToRisk:validFillGeometry?rounded(fillRewardDist/fillRiskDist,4):null,
  barrierDistance,nearOriginalStop,nearOriginalTarget,
  observedGrossPeakUsd:observedPeak,
  observedMaxAdverseUsd:observedDrawdown,
  observedPeakAtProvenance:peakProvenance,
  peakedPositiveBeforeLoss:net<0&&observedPeak!==null&&observedPeak>0&&peakProvenance,
  observedAfterFinalCostsPositivePeakBeforeLoss:net<0&&observedPeak!==null&&
   observedPeak+commission+swap>0&&peakProvenance,
  profitProtectionPeakCaptureRatio:row.close_reason==='PROFIT_PROTECTION'&&
   observedPeak!==null&&observedPeak>0&&gross>0&&peakProvenance
   ?rounded(gross/observedPeak,4):null,
  durationMinutes:settledDurationMin,
 };
}
function calculate(group){
 const nums=(key)=>group.map(x=>x[key]).filter(Number.isFinite);
 const wins=group.filter(x=>x.win),losses=group.filter(x=>x.loss);
 const winNet=wins.reduce((s,x)=>s+x.netUsd,0),
  lossNet=losses.reduce((s,x)=>s+x.netUsd,0),
  net=group.reduce((s,x)=>s+x.netUsd,0);
 const lengths=nums('durationMinutes'),netR=nums('realizedNetRFromFillStop');
 const costs=group.map(x=>x.commissionUsd/x.filledLots).filter(Number.isFinite);
 const originalPlan=group.filter(x=>x.plannedGeometryVerified);
 const nearStop=group.filter(x=>x.nearOriginalStop);
 const nearTarget=group.filter(x=>x.nearOriginalTarget);
 const ppCapture=nums('profitProtectionPeakCaptureRatio');
 return {
  trades:group.length,settledWins:wins.length,settledLosses:losses.length,
  netUsd:rounded(net),grossWinningNetUsd:rounded(winNet),grossLosingNetUsd:rounded(lossNet),
  profitFactor:lossNet<0?rounded(winNet/(-lossNet),4):null,
  winRate:group.length?rounded(wins.length/group.length,4):null,
  avgWinUsd:wins.length?rounded(winNet/wins.length):null,
  avgLossUsd:losses.length?rounded(lossNet/losses.length):null,
  avgWinNetPerLotUsd:mean(wins.map(x=>x.netPerLotUsd)),
  avgLossNetPerLotUsd:mean(losses.map(x=>x.netPerLotUsd)),
  avgNetRFromOriginalFillStop:mean(netR),
  medianNetRFromOriginalFillStop:median(netR),
  verifiedRiskRCount:netR.length,
  verifiedPreEntryPlans:originalPlan.length,
  meanOriginalPlanRr:mean(originalPlan.map(x=>x.plannedRewardToRisk)),
  meanOriginalPlanRrForWins:mean(wins.filter(x=>x.plannedGeometryVerified).map(x=>x.plannedRewardToRisk)),
  meanOriginalPlanRrForLosses:mean(losses.filter(x=>x.plannedGeometryVerified).map(x=>x.plannedRewardToRisk)),
  medianNetPerLotUsd:median(nums('netPerLotUsd')),
  meanCommissionUsdPerLot:mean(costs),
  meanDurationMinutes:mean(lengths),
  exitWithin2pOfOriginalIntentStop:nearStop.length,
  exitWithin2pOfOriginalIntentTarget:nearTarget.length,
  appCloseRequestPersisted:group.filter(x=>x.appCloseRequestEvidence==='PERSISTED').length,
  appCloseRequestNotRecorded:group.filter(x=>x.appCloseRequestEvidence==='NOT_RECORDED').length,
  appCloseRequestEvidenceUnknown:group.filter(x=>x.appCloseRequestEvidence==='UNKNOWN').length,
  linkedPostopenOrderPersisted:group.filter(x=>x.linkedPostOpenOrderEvidence==='PERSISTED').length,
  linkedPostopenOrderNotRecorded:group.filter(x=>x.linkedPostOpenOrderEvidence==='NOT_RECORDED').length,
  frozenPreentryM5Opposed:group.filter(x=>x.preEntryM5Opposition===true).length,
  frozenPreentryM5AlignedOrNeutral:group.filter(x=>x.preEntryM5Opposition===false).length,
  frozenPreentryM5Unknown:group.filter(x=>x.preEntryM5Opposition===null).length,
  previouslyPositiveBrokerGrossPeakAndNetLoss:group.filter(x=>x.peakedPositiveBeforeLoss).length,
  sampledPeakExceedsLaterFinalFeesYetTradeLoses:group.filter(
   x=>x.observedAfterFinalCostsPositivePeakBeforeLoss).length,
  profitProtectionCapturedGrossPeakCount:ppCapture.length,
  profitProtectionGrossPeakCaptureRatioMean:mean(ppCapture),
  commissionUsdTotal:rounded(group.reduce((s,x)=>s+x.commissionUsd,0)),
  swapUsdTotal:rounded(group.reduce((s,x)=>s+x.swapUsd,0)),
 };
}
function groups(rows,key){
 const buckets=new Map();
 for(const r of rows){const k=String(key(r));if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(r);}
 return Object.fromEntries([...buckets].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,calculate(v)]));
}
function analyze(rows,now=new Date()){
 const trades=rows.map(decode);
 const hasMismatch=trades.filter(x=>!x.originalDecisionVerified);
 const cr=trades.filter(x=>x.route==='CONFIRMED_REVERSAL');
 const et=trades.filter(x=>x.route==='EARLY_TRANSITION');
 const guard=trades.filter(x=>x.closeClass==='INDEPENDENT_GUARD_REQUEST');
 const notGuard=trades.filter(x=>x.closeClass!=='INDEPENDENT_GUARD_REQUEST');
 const bclose=trades.filter(x=>x.closeClass==='BROKER_CLOSE');
 const po=trades.filter(x=>x.closeClass==='PROFIT_PROTECTION');
 const lossAfterGrossPeak=trades.filter(x=>x.peakedPositiveBeforeLoss);
 return {
  artifact:'irexpro-owner-demo-original-entry-vs-exit-payoff-attribution-v1',
  asOf:now.toISOString(),fromUtc:FROM,
  cohort:'OWNER_PEPPERSTONE_CTRADER_USD_DEMO_BROKER_SETTLED_ONLY',
  all:calculate(trades),confirmedReversal:calculate(cr),earlyTransition:calculate(et),
  verifiedPreEntryDecisionCount:trades.length-hasMismatch.length,
  unmatchedPreEntryDecisionCount:hasMismatch.length,
  byStrategy:groups(trades,x=>x.route),
  byDay:groups(trades,x=>x.dayUtc),
  byDayAndStrategy:groups(trades,x=>x.dayUtc+'|'+x.route),
  byInstrumentAndStrategy:groups(trades,x=>x.route+'|'+x.instrument),
  // Include ALL actual fills when calculating hypothetical skipped winners;
  // studying M5 only within stopped-out trades would bias the denominator.
  byStrategyAndOriginalPreEntryM5:groups(trades,x=>x.route+'|'+(
   x.preEntryM5Opposition===null?'M5_UNKNOWN':
   x.preEntryM5Opposition?'M5_OPPOSED':'M5_NOT_OPPOSED')),
  byStrategyInstrumentAndOriginalPreEntryM5:groups(trades,x=>
   x.route+'|'+x.instrument+'|'+(
    x.preEntryM5Opposition===null?'M5_UNKNOWN':
    x.preEntryM5Opposition?'M5_OPPOSED':'M5_NOT_OPPOSED')),
  byExitClass:groups(trades,x=>x.closeClass),
  byStrategyAndExitClass:groups(trades,x=>x.route+'|'+x.closeClass),
  byOriginalRiskRatio:groups(trades,x=>x.plannedRewardToRisk===null?'UNVERIFIED':
   x.plannedRewardToRisk<1?'BELOW_1':x.plannedRewardToRisk<1.4?'1_TO_1_4':
   x.plannedRewardToRisk<1.8?'1_4_TO_1_8':'AT_LEAST_1_8'),
  trialVsBaseline:groups(trades,x=>x.trialCohort),
  brokerCloseOriginalIntentBarrier:groups(bclose,x=>x.nearOriginalStop?
   'EXIT_WITHIN_2P_OF_ORIGINAL_STOP':x.nearOriginalTarget?
   'EXIT_WITHIN_2P_OF_ORIGINAL_TARGET':'EXIT_AWAY_FROM_ORIGINAL_BARRIERS'),
  // A recorded app close request is independent provenance, not proof of a
  // specific native broker deal reason. Keep missing records distinct.
  brokerCloseByAppRequestEvidence:groups(bclose,x=>x.appCloseRequestEvidence),
  brokerCloseByLinkedPostopenOrderEvidence:groups(bclose,x=>x.linkedPostOpenOrderEvidence),
  brokerCloseByRouteAndAppRequest:groups(bclose,x=>x.route+'|'+x.appCloseRequestEvidence),
  brokerCloseByRouteAndStopProximity:groups(bclose,x=>x.route+'|'+(
   !x.fillGeometryVerified?'UNVERIFIED_ORIGINAL_BARRIER':
   x.nearOriginalStop?'NEAR_ORIGINAL_STOP':
   x.nearOriginalTarget?'NEAR_ORIGINAL_TARGET':'AWAY_FROM_ORIGINAL_BARRIERS')),
  brokerCloseByFrozenM5Contradiction:groups(bclose,x=>x.route+'|'+(
   x.preEntryM5Opposition===null?'UNVERIFIED_PRE_ENTRY_M5':
   x.preEntryM5Opposition?'ORIGINAL_M5_OPPOSED':'ORIGINAL_M5_NOT_OPPOSED')),
  brokerCloseNearStopNoAppRequest:calculate(bclose.filter(x=>
   x.nearOriginalStop&&x.appCloseRequestEvidence==='NOT_RECORDED')),
  providerNativeStopTriggerVerified:false,
  actualProviderDealReasonAvailable:false,
  confirmedGuardExit:calculate(guard),
  otherExit:calculate(notGuard),
  observedProfitableGrossPeakThenNetLoss:calculate(lossAfterGrossPeak),
  recordedProfitProtection:calculate(po),
  noExecutionsChanged:true,trialLotPolicyChanged:false,noModelTraining:true,
  causalNote:'Entry model candidate, original SL and TP must be linked as-of before intent. Fill-anchored risk and actual broker net are available ONLY after execution and settlement.',
  limitations:[
   'This is settled-trade selection; not causal evidence that changing exits would prevent losses.',
   'Original tactical stop/target reference is from the immutable pre-intent candidate, while actual broker fill may be offset by price movement; both geometric ratios are reported separately.',
   'Broker close_reason=BROKER_CLOSE does not prove an SL/TP trigger; within-2-pip proximity to ORIGINAL intent levels is only a price-distance label.',
   'App close-request and linked order provenance are independently checked against persisted timestamps, not provider deal events. NOT_RECORDED means the application DB has no matching record, not that the broker never received or processed other orders.',
   'No provider-native stop/target deal reason is stored in the inspected order/trade event tables, so STOP_HIT, stop-fill slippage, broker amendment ACK and exact provider attribution remain UNVERIFIED.',
   'Original frozen model M5 contradiction is an as-of diagnostic, not a universal cause of stop losses or a validated abstention feature.',
   'MFE, MAE and giveback are sampled broker-mark observations with incomplete tick coverage; they are not executable peak fills and cannot be turned into guaranteed profit claims.',
   'An earlier positive GROSS mark may still have been negative NET of commission; never equate peakGross>0 with a profitable exit opportunity.',
   'Original fill-to-intent stop dollar risk is a reference, not a guaranteed maximum loss; slippage, stop amendments, swap and broker fills can exceed it.',
   'Identical planned RR does not imply equivalent entry forecasts, execution costs or time to maturity.',
   'The temporary 4–6 lot DEMO window is separately identified and cannot be compared causally with smaller baseline lots because signals, session and price regimes change.',
   'The research is read-only and cannot authorize a new veto, re-entry, side reversal, 4+ execution or LIVE promotion.',
  ],
 };
}
async function run(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('MISSING_EXACT_OWNER_SCOPE');
 const {Client}=require('pg');
 const c=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  connectionTimeoutMillis:6000,statement_timeout:20000,
  application_name:'irexpro-owner-original-payoff-READONLY'});
 let rows;
 await c.connect();
 try{await c.query('BEGIN READ ONLY');
  rows=(await c.query(QUERY,[owner,FROM])).rows;
  await c.query('ROLLBACK');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
 finally{await c.end();}
 if(rows.length>MAX)throw Error('SETTLED_TRADE_QUERY_LIMIT');
 const report=analyze(rows);
 const payload=JSON.stringify(report,null,2);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,payload,{mode:0o600});
 const archive=path.join(path.dirname(OUT),'daily',report.asOf.slice(0,10)+'.json');
 fs.mkdirSync(path.dirname(archive),{recursive:true,mode:0o700});
 fs.writeFileSync(archive,payload,{mode:0o600});
 console.log('OWNER_EXIT_PAYOFF_ATTRIBUTION '+JSON.stringify({
  asOf:report.asOf,trades:report.all.trades,net:report.all.netUsd,
  crNet:report.confirmedReversal.netUsd,etNet:report.earlyTransition.netUsd,
  preEntryVerified:report.verifiedPreEntryDecisionCount,
  profitProtection:report.recordedProfitProtection.trades,
  verifiedGuard:report.confirmedGuardExit.trades,
  researchOnly:true,noOrders:true,
 }));
 return report;
}
module.exports={FROM,TRIAL,QUERY,signedDist,quoteRiskUsd,decode,calculate,groups,analyze,run};
if(require.main===module)run().catch(e=>{
 console.error('OWNER_EXIT_PAYOFF_RESEARCH_ERROR',String(e.message).slice(0,220));process.exitCode=1;
});
