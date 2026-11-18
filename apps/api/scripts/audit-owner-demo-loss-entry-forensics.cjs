#!/usr/bin/env node
'use strict';

/**
 * Read-only forensics for the owner Pepperstone USD DEMO 17-18 Nov 2026
 * Early Transition and Confirmed Reversal trades. No order, model or flag
 * mutation. Entry features/forecasts are frozen at decision time.
 * Retrospective price marks are labeled OUTCOMES, never predictive inputs.
 */
const fs = require('node:fs');
const path = require('node:path');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OUT='/home/lightworld/webapps/irexpro-research/loss-entry-forensics';
const FROM='2026-11-17T00:00:00.000Z';
const TO='2026-11-19T00:00:00.000Z';
const ROUTES=['EARLY_TRANSITION','CONFIRMED_REVERSAL'];
const HORIZONS=[1,3,5,10];
const PAIR_SOURCE='ctrader-broker-native';

const TRADE_SQL = [
 "SELECT t.id::text trade_id,t.instrument,t.direction,t.lot_size,t.opened_at,t.closed_at,",
 "t.status,t.close_reason,t.realised_pnl,t.commission,t.swap,t.fill_price,t.exit_price,",
 "t.stop_loss,t.take_profit,t.max_favorable_pnl,t.max_adverse_pnl,t.profit_giveback,",
 "t.path_observation_count,t.path_peak_observed_at,",
 "ti.id::text trade_intent_id,ti.metadata,ti.rationale,ti.strategy_code,",
 "d.id::text decision_id,d.route m1_route,d.evaluated_at decision_at,",
 "d.candidate,d.governance,d.blockers,d.outcome_state,",
 "ca.sizing_inputs->>'finalRiskAtStop' initial_risk,",
 "ca.sizing_inputs->>'riskAmount' fallback_risk",
 "FROM trading.trades t",
 "JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
 " AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id",
 "LEFT JOIN LATERAL (SELECT d.id,d.route,d.evaluated_at,d.candidate,d.governance,d.blockers,d.outcome_state",
 " FROM trading.m1_tactical_decisions d WHERE d.trade_intent_id=ti.id AND d.user_id=t.user_id",
 " AND d.broker_connection_id=t.broker_connection_id AND d.evaluated_at<=t.opened_at",
 " ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 1) d ON TRUE",
 "LEFT JOIN LATERAL (SELECT a.sizing_inputs FROM trading.capital_allocations a",
 " WHERE a.trade_intent_id=ti.id AND a.user_id=t.user_id",
 " AND a.created_at<=t.opened_at ORDER BY a.created_at DESC,a.id DESC LIMIT 1) ca ON TRUE",
 "WHERE t.user_id=$1 AND b.user_id=$1 AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND t.account_currency='USD' AND t.status='CLOSED'",
 "AND t.opened_at>=$2::timestamptz AND t.opened_at<$3::timestamptz",
 "AND ti.metadata->>'multimodel_plan_b_route' IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
 "ORDER BY t.opened_at,t.id LIMIT 1501"
].join(' ');

const QUOTE_SQL=[
 "SELECT instrument,bucket_time,bid_close,ask_close,sample_count,",
 "positive_quote_sample_count,last_positive_sample_at,source",
 "FROM market_data.provider_quote_candles",
 "WHERE connection_id=$1 AND instrument=ANY($2::text[])",
 "AND source='ctrader-broker-native' AND timeframe='M1'",
 "AND bucket_time>=$3::timestamptz AND bucket_time<$4::timestamptz",
 "AND bucket_time+interval '1 minute'<=now()",
 "ORDER BY instrument,bucket_time LIMIT 15001"
].join(' ');

function num(x){if(x===null||x===undefined||x==='')return null;const n=Number(x);return Number.isFinite(n)?n:null}
function round(n,decimals=2){return n===null||!Number.isFinite(n)?null:Number(n.toFixed(decimals))}
function date(x){const n=new Date(x).getTime();return Number.isFinite(n)?n:null}
function risk(row){const a=num(row.initial_risk);if(a!==null&&a>0)return a;const b=num(row.fallback_risk);return b!==null&&b>0?b:null}
function cost(row){return num(row.commission)===null?null:Math.abs(Number(row.commission))}
function net(row){const p=num(row.realised_pnl),f=num(row.commission),s=num(row.swap);
 return p===null||f===null||s===null?null:round(p+f+s)}
function route(row){const x=row.metadata?.multimodel_plan_b_route;return ROUTES.includes(x)?x:null}
function rNumber(obj,key){return num(obj?.[key])}
function quoteUsable(q,nowMs){
 const time=date(q.bucket_time),last=date(q.last_positive_sample_at);
 return q.source===PAIR_SOURCE&&time!==null&&last!==null &&
   time+60_000<=nowMs &&
   last>=time+30_000&&last<time+60_000 &&
   num(q.sample_count)>=2&&num(q.positive_quote_sample_count)>=2&&
   num(q.bid_close)>0&&num(q.ask_close)>num(q.bid_close);
}
/**
 * Completed native bid/ask M1 quote closes. Outcome labels ONLY, not entry
 * knowledge, and without any intraminute TP/SL sequencing assumption.
 */
function sampledAfterEntry(row,quoteList,nowMs){
 const result={};
 const opened=date(row.opened_at),fill=num(row.fill_price);
 const pip=row.instrument.endsWith('JPY')?0.01:0.0001;
 if(opened===null||fill===null||!['BUY','SELL'].includes(row.direction))return result;
 const direction=row.direction==='BUY'?1:-1;
 for(const minutes of HORIZONS){
  const target=opened+minutes*60_000;
  const match=(quoteList||[]).find(q=>{
    const at=date(q.bucket_time);
    return at!==null && at+60_000>=target&&at+60_000<=target+60_000
      && quoteUsable(q,nowMs);
  });
  if(!match){result[minutes+'m']={status:'NO_VALID_COMPLETED_NATIVE_QUOTE'};continue}
  const exitSide=direction===1?num(match.bid_close):num(match.ask_close);
  const pips=direction*(exitSide-fill)/pip;
  result[minutes+'m']={
   status:'VALID_BROKER_NATIVE_CLOSE',
   at:new Date(date(match.bucket_time)+60_000).toISOString(),
   directionAlignedPips:round(pips,2),
   directionFavorableAtSample:pips>0,
   duringActualPositionOpen:date(match.bucket_time)+60_000<=date(row.closed_at),
   notAnExecutableExit:true,
  };
 }
 return result;
}
function entrySnapshot(row){
 const m=row.metadata||{},g=row.governance||{},c=row.candidate||{};
 const ensemble=g.multimodelEnsemble||{},gen=g.multimodelGovernance||{};
 const expert=g.multimodelTrainedExpert||{};
 const memory=g.patternMemory||{};
 const native=g.genericGovernance||{};
 return {
  source:'MATCHED_TRADE_INTENT_AND_ENTRY_TIME_TACTICAL_DECISION',
  lineagePresent:Boolean(row.trade_intent_id&&row.decision_id),
  decisionAt:row.decision_at?new Date(row.decision_at).toISOString():null,
  decisionRoute:row.m1_route??null,
  decisionOutcome:row.outcome_state??null,
  entryRoute:route(row),entryAuthority:m.multimodel_execution_authority_path??null,
  entryPolicy:m.m1_policy_version??null,
  regime:ensemble.regime??null,
  score:round(num(ensemble.ensembleScore),3),
  predictedNetR:round(num(m.multimodel_governance_net_expected_r),3),
  estimatedCostR:round(num(gen.estimatedExecutionCostR),3),
  metaProbability:round(num(ensemble.metaProbability),3),
  paperAdmitted:ensemble.paperAdmitted??null,
  consensusPassed:num(ensemble.consensusPassed),
  consensusRequired:num(ensemble.consensusRequired),
  modelDirection:row.direction,
  expertState:expert.state??m.multimodel_trained_expert_state??null,
  expertDirection:expert.direction??m.multimodel_trained_expert_direction??null,
  expertLongVotes:num(expert.longVotes??m.multimodel_trained_expert_long_votes),
  expertShortVotes:num(expert.shortVotes??m.multimodel_trained_expert_short_votes),
  expertConfidence:round(num(expert.ensembleConfidence),3),
  expertFreshnessSeconds:num(expert.freshnessSeconds),
  expertAdmitted:expert.admitted??null,
  m1CandidateDirection:c.direction??null,
  m1Confidence:round(num(c.confidence),3),
  alignedH1:round(num(c.alignedH1),3),
  alignedH4:round(num(c.alignedH4),3),
  alignedM15:round(num(c.alignedM15),3),
  alignedM5:round(num(c.alignedM5),3),
  alignedM1Momentum3Atr:round(num(c.alignedMomentum3Atr),3),
  alignedM5Momentum3Atr:round(num(c.alignedM5Momentum3Atr),3),
  alignedM5BodyPressure:round(num(c.alignedM5LatestBodyPressure),3),
  m5BodyExpansionRatio:round(num(c.m5BodyExpansionRatio),3),
  alignedHigherTimeframeAgreement:round(num(c.alignedHigherTimeframeAgreement),3),
  driftState:native.driftState??null,
  driftQuality:round(num(native.driftQuality),3),
  patternMemoryHypothesis:memory.hypothesis??null,
  patternMemoryMatchingEpisodes:num(memory.matchingEpisodes),
  patternMemoryWins:num(memory.wins),
  patternMemoryLosses:num(memory.losses),
  patternMemoryAverageNetR:round(num(memory.averageNetR),3),
  patternMemoryShadowOnly:memory.shadowOnly??null,
 };
}
function classifyLoss(item){
 if(item.netUsd===null||item.netUsd>=0)return null;
 const peak=item.maxFavorableBrokerNet;
 if(item.closeReason==='BROKER_CLOSE' && item.exitToRecordedStopPips!==null &&
    item.exitToRecordedStopPips<=0.5){
  item.exitGeometry='WITHIN_HALF_PIP_OF_RECORDED_STOP';
 }else if(item.closeReason==='BROKER_CLOSE'){
  item.exitGeometry='BROKER_CLOSE_REASON_NOT_PROVEN_FROM_PRICE_ALONE';
 }else if(item.closeReason==='AI_CLOSE_SIGNAL'){
  item.exitGeometry='AI_REQUESTED_EXIT_BEFORE_OR_NEAR_ORIGINAL_STOP';
 }else item.exitGeometry='OTHER_OR_UNKNOWN_EXIT';
 const fee=item.commissionAbs;
 const initial=item.initialRiskUsd;
 const labels=[];
 if(peak===null)labels.push('UNKNOWN_PEAK_EVIDENCE');
 else if(peak<=0)labels.push('NO_OBSERVED_FAVORABLE_PRICE_PEAK');
 else if(fee===null)labels.push('POSITIVE_PEAK_FEE_COVERAGE_UNKNOWN');
 else if(peak<=fee)labels.push('POSITIVE_BROKER_NET_PEAK_AT_OR_BELOW_FINAL_COMMISSION_MAGNITUDE');
 else labels.push('POSITIVE_BROKER_NET_PEAK_GREATER_THAN_FINAL_COMMISSION_MAGNITUDE');
 if(peak!==null&&peak>=20)labels.push('OBSERVED_PEAK_20_PLUS_THEN_LOSS');
 if(peak!==null&&peak>=40)labels.push('OBSERVED_PEAK_40_PLUS_THEN_LOSS');
 if(peak!==null&&initial!==null&&peak>=initial*0.5)
   labels.push('PEAK_AT_LEAST_HALF_ORIGINAL_RISK_THEN_LOSS');
 if(item.entry.expertState==='ABSTAIN')labels.push('INDEPENDENT_TRAINED_EXPERT_ABSTAINED');
 if(item.entry.expertDirection&&item.entry.expertDirection!==item.direction)
   labels.push('INDEPENDENT_EXPERT_OPPOSITE_AT_ENTRY');
 if(item.entry.m1CandidateDirection&&item.entry.m1CandidateDirection!==item.direction)
   labels.push('M1_CANDIDATE_DIRECTION_DISAGREED');
 if(item.entry.alignedM5!==null&&item.entry.alignedM5<-0.2)
   labels.push('M5_DIRECTION_OPPOSED_ENTRY');
 if(item.entry.alignedM1Momentum3Atr!==null&&item.entry.alignedM1Momentum3Atr<-0.3)
   labels.push('M1_MOMENTUM3_OPPOSED_ENTRY');
 if(item.entry.alignedH1!==null&&item.entry.alignedH1<-0.25)
   labels.push('H1_DIRECTION_OPPOSED_ENTRY');
 if(item.entry.metaProbability!==null&&item.entry.metaProbability<0.53)
   labels.push('PLAN_B_META_PROBABILITY_BELOW_53PCT');
 if(item.entry.patternMemoryHypothesis==='REPEATED_FAVORABLE_PATTERN')
   labels.push('PAST_PATTERN_MEMORY_FAVORABLE_BUT_CURRENT_LOSS');
 return labels;
}
function formatEntry(item){
 const e=item.entry;
 const votes=e.expertLongVotes===null||e.expertShortVotes===null?'unavailable':
   String(e.expertLongVotes)+' BUY / '+String(e.expertShortVotes)+' SELL';
 const feats=['H1 '+e.alignedH1,'H4 '+e.alignedH4,'M15 '+e.alignedM15,
  'M5 '+e.alignedM5,'M1-mom3 '+e.alignedM1Momentum3Atr,
  'M5-body '+e.alignedM5BodyPressure].join(', ');
 return 'Entry '+item.direction+' via '+String(e.entryRoute)+
  '; Plan-B '+String(e.regime)+'; score '+String(e.score)+
  '; meta probability '+String(e.metaProbability)+
  '; forecast net R '+String(e.predictedNetR)+
  '; experts '+String(e.expertState)+' ('+votes+', direction '+String(e.expertDirection)+')'+
  '; M1 route '+String(e.decisionRoute)+
  '; '+feats+'.';
}
function makeRecords(rows,quoteBySymbol,nowMs){
 return rows.filter(r=>ROUTES.includes(route(r))).map(r=>{
   const e=entrySnapshot(r);
   const item={
    tradeKey:r.trade_id,tradeDate:new Date(r.opened_at).toISOString().slice(0,10),
    openedAt:new Date(r.opened_at).toISOString(),
    closedAt:new Date(r.closed_at).toISOString(),
    instrument:r.instrument,direction:r.direction,route:route(r),
    durationMinutes:round((date(r.closed_at)-date(r.opened_at))/60_000,2),
    lots:num(r.lot_size),
    entryPrice:num(r.fill_price),exitPrice:num(r.exit_price),
    brokerStop:num(r.stop_loss),brokerTakeProfit:num(r.take_profit),
    exitToRecordedStopPips:num(r.exit_price)!==null&&num(r.stop_loss)!==null?
      round(Math.abs(Number(r.exit_price)-Number(r.stop_loss))/
        (String(r.instrument).endsWith('JPY')?.01:.0001),2):null,
    closeReason:r.close_reason,
    grossPnlUsd:round(num(r.realised_pnl)),commissionUsd:round(num(r.commission)),
    commissionAbs:cost(r),swapUsd:round(num(r.swap)),
    netUsd:net(r),initialRiskUsd:round(risk(r)),
    maxFavorableBrokerNet:round(num(r.max_favorable_pnl)),
    maxAdverseBrokerNet:round(num(r.max_adverse_pnl)),
    pathObservations:num(r.path_observation_count),
    peakObservedAt:r.path_peak_observed_at?new Date(r.path_peak_observed_at).toISOString():null,
    entry:e,
    futureSampledNativeQuoteOutcome:sampledAfterEntry(r,quoteBySymbol[r.instrument]||[],nowMs),
   };
   item.peakAboveCommission=item.maxFavorableBrokerNet!==null &&
      item.commissionAbs!==null && item.maxFavorableBrokerNet>item.commissionAbs;
   item.peakThenLoss=item.maxFavorableBrokerNet!==null &&
     item.maxFavorableBrokerNet>0 && item.netUsd!==null && item.netUsd<0;
   item.flags=classifyLoss(item);
   item.entryExplanation=formatEntry(item);
   item.oppositeDirectionInterpretation=
    item.entry.expertDirection&&item.entry.expertDirection!==item.direction?
      'A contrary expert side existed at entry; this is research evidence, not permission to reverse trade.' :
      'No verified independently admitted opposite-side broker entry at decision time; realized loss cannot justify a retrospective side flip.';
   return item;
 });
}
function exposureStats(items){
 const sum=(list,key)=>round(list.reduce((s,r)=>s+(num(r[key])||0),0));
 const out={};
 for(const routeName of ROUTES){
  const x=items.filter(r=>r.route===routeName);
  const win=x.filter(r=>r.netUsd!==null&&r.netUsd>0);
  const lose=x.filter(r=>r.netUsd!==null&&r.netUsd<0);
  const badAtEntry=lose.filter(r=>r.maxFavorableBrokerNet!==null&&r.maxFavorableBrokerNet<=0);
  const peakSub=lose.filter(r=>r.maxFavorableBrokerNet>0&&r.maxFavorableBrokerNet<=r.commissionAbs);
  const peakCover=lose.filter(r=>r.peakAboveCommission);
  const impressive=lose.filter(r=>r.maxFavorableBrokerNet>=20);
  out[routeName]={
   closedTrades:x.length,winners:win.length,losers:lose.length,
   winsNetUsd:sum(win,'netUsd'),lossesNetUsd:sum(lose,'netUsd'),
   fullNetUsd:sum(x,'netUsd'),
   noObservedPositivePeak:badAtEntry.length,
   positivePeakAtOrBelowFinalCommissionMagnitude:peakSub.length,
   positivePeakGreaterThanFinalCommissionMagnitudeThenLost:peakCover.length,
   peak20ThenLost:impressive.length,
   peak40ThenLost:lose.filter(r=>r.maxFavorableBrokerNet>=40).length,
   lossCasesMissingEntryDecision:lose.filter(r=>!r.entry.lineagePresent).length,
   lossCasesExpertAbstain:lose.filter(r=>r.entry.expertState==='ABSTAIN').length,
   lossCasesExpertOpposite:lose.filter(r=>r.entry.expertDirection&&r.entry.expertDirection!==r.direction).length,
   lossCasesM1Abstain:lose.filter(r=>r.entry.decisionRoute==='ABSTAIN').length,
   brokerClosesNearRecordedStop:lose.filter(r=>r.closeReason==='BROKER_CLOSE' &&
      r.exitToRecordedStopPips!==null&&r.exitToRecordedStopPips<=0.5).length,
  };
 }
 return out;
}
const CAUSAL_FLAGS=[
 ['EXPERT_ABSTAIN',e=>e.expertState==='ABSTAIN'],
 ['M1_ABSTAIN',e=>e.decisionRoute==='ABSTAIN'],
 ['M5_DIRECTION_CONFLICT',e=>e.alignedM5!==null&&e.alignedM5<-0.2],
 ['M1_MOMENTUM3_CONFLICT',e=>e.alignedM1Momentum3Atr!==null&&e.alignedM1Momentum3Atr<-0.3],
 ['H1_DIRECTION_CONFLICT',e=>e.alignedH1!==null&&e.alignedH1<-0.25],
 ['META_PROB_LT_053',e=>e.metaProbability!==null&&e.metaProbability<0.53],
 ['META_PROB_LT_055',e=>e.metaProbability!==null&&e.metaProbability<0.55],
 ['M5_BODY_PRESSURE_CONFLICT',e=>e.alignedM5BodyPressure!==null&&e.alignedM5BodyPressure<-0.3],
 ['PATTERN_MEMORY_FAVORABLE',e=>e.patternMemoryHypothesis==='REPEATED_FAVORABLE_PATTERN'],
 ['PLAN_B_CONSENSUS_LT_7',e=>e.consensusPassed!==null&&e.consensusPassed<7],
];
function causalPatternContrast(items){
 const report=[];
 for(const [name,test] of CAUSAL_FLAGS){
  for(const routeName of ROUTES){
   const sample=items.filter(r=>r.route===routeName);
   const flagged=sample.filter(r=>test(r.entry));
   const losses=flagged.filter(r=>r.netUsd<0),wins=flagged.filter(r=>r.netUsd>0);
   const net=round(flagged.reduce((s,r)=>s+r.netUsd,0));
   report.push({pattern:name,route:routeName,
     flaggedEntries:flagged.length,flaggedLosses:losses.length,
     flaggedWinners:wins.length,flaggedNetUsd:net,
     hypotheticalInSampleAvoidedNetUsd:round(-net),
     sampleSize:sample.length,requiresIndependentValidation:true,
     retrospectivePatternMining:true});
  }
 }
 return report;
}
/**
 * Separate entry-time features from POST-ENTRY broker outcomes. A later ML
 * train/validate pipeline MUST exclude targets, quote horizons and trade
 * settlement from the predictor features, and must group/split by trading
 * date to prevent duplicated market episodes leaking into validation.
 */
function buildTrainingCohort(items,asOf){
 return {
  artifact:'owner-demo-asof-entry-loss-learning-cohort-v1',
  researchOnly:true,modifiesExecution:false,modelWeightsUpdated:false,
  asOf,featureTime:'ORIGINAL_ENTRY_DECISION_ONLY',
  outcomesAreFutureLabels:true,
  count:items.length,
  records:items.map(x=>({
   caseKey:x.tradeKey,
   tradingDay:x.tradeDate,openedAt:x.openedAt,
   entryFeatures:{
    instrument:x.instrument,direction:x.direction,route:x.route,
    ...x.entry,
   },
   futureOutcomesDoNotUseAsInputs:{
    settledAt:x.closedAt,
    netPnlUsd:x.netUsd,
    label:x.netUsd>0?'NET_WIN':x.netUsd<0?'NET_LOSS':'NET_FLAT',
    peakUnrealisedBrokerNet:x.maxFavorableBrokerNet,
    worstUnrealisedBrokerNet:x.maxAdverseBrokerNet,
    quoteHorizonOutcomes:x.futureSampledNativeQuoteOutcome,
    closeReason:x.closeReason,
   },
  })),
  warning:'BOTH 17 and 18 November were inspected to discover candidate features. Neither day is a pristine out-of-sample holdout. Require independent later dates and purged overlapping episode validation before any executable deployment.',
 };
}
function byInstrumentSide(items){
 const groups={};
 for(const x of items){
  const name=x.route+' / '+x.instrument+' '+x.direction;
  const g=groups[name]??={route:x.route,instrument:x.instrument,direction:x.direction,
    trades:0,winners:0,losers:0,netUsd:0,commissionUsd:0};
  g.trades++;
  if(x.netUsd>0)g.winners++;
  if(x.netUsd<0)g.losers++;
  g.netUsd+=x.netUsd??0;
  g.commissionUsd+=x.commissionUsd??0;
 }
 return Object.values(groups).map(g=>({...g,netUsd:round(g.netUsd),
   commissionUsd:round(g.commissionUsd)}))
   .sort((a,b)=>a.route.localeCompare(b.route)||a.netUsd-b.netUsd);
}
function firstMarkContrasts(items){
 const out={};
 for(const routeName of ROUTES){
  for(const minutes of HORIZONS){
   const key=routeName+' '+minutes+'m';
   const cases=items.filter(r=>r.route===routeName);
   const valid=cases.filter(r=>r.futureSampledNativeQuoteOutcome[minutes+'m']?.status===
      'VALID_BROKER_NATIVE_CLOSE' &&
      r.futureSampledNativeQuoteOutcome[minutes+'m']?.duringActualPositionOpen===true);
   const losing=valid.filter(r=>r.netUsd<0),winning=valid.filter(r=>r.netUsd>0);
   const adverse=xs=>xs.filter(r=>r.futureSampledNativeQuoteOutcome[minutes+'m']
     .directionAlignedPips<0).length;
   const favorable=xs=>xs.filter(r=>r.futureSampledNativeQuoteOutcome[minutes+'m']
     .directionAlignedPips>0).length;
   out[key]={executedTrades:cases.length,validQuotes:valid.length,
    notObservedWhilePositionOpen:cases.length-valid.length,
    losingTradeValidQuotes:losing.length,losersAlreadyAdverseAtMark:adverse(losing),
    losersStillFavorableAtMark:favorable(losing),
    winningTradeValidQuotes:winning.length,winnersAlreadyAdverseAtMark:adverse(winning),
    winnersFavorableAtMark:favorable(winning),
    flaggedAdverseNetUsd:round([...losing,...winning]
      .filter(r=>r.futureSampledNativeQuoteOutcome[minutes+'m'].directionAlignedPips<0)
      .reduce((sum,r)=>sum+r.netUsd,0)),
    flaggedAdverseTrades:adverse(valid),
    notAnExecutableEntryTimingSimulation:true};
  }
 }
 return out;
}
function byExit(items){
 const map={};
 for(const x of items.filter(r=>r.netUsd<0)){
  const k=x.route+' '+x.closeReason;
  const b=map[k]??={route:x.route,reason:x.closeReason,losingFills:0,netLossUsd:0};
  b.losingFills++;b.netLossUsd+=x.netUsd;
 }
 return Object.values(map).map(v=>({...v,netLossUsd:round(v.netLossUsd)}));
}
function renderMarkdown(losses,all,summary,patterns,asOf,sideBreakdown,firstMarks,exitBreakdown){
 const p=[];
 p.push('# Broker-verified individual loss review: Early Transition and Confirmed Reversal');
 p.push('');
 p.push('**Window:** Nov 17–18, 2026 UTC (same clock as Ghana). As-of '+asOf+
  '. Read-only Pepperstone USD DEMO; '+all.length+' closed trades; '+losses.length+' actual net losing fills.');
 p.push('');
 p.push('Every profit/loss amount includes the recorded gross settlement, signed commission and swap.');
 p.push('**Max favorable** and **max adverse** are sampled broker-reported NET unrealized marks, not guaranteed fillable gains.');
 p.push('Comparisons of those net peak marks with ABS(final recorded commission) are MAGNITUDE screens only, NOT fee-offset calculations: the broker mark may already include costs. No commission is subtracted twice.');
 p.push('The sampled +1/+3/+5/+10m bid/ask closes are POST-ENTRY OUTCOME LABELS. They cannot be used as if known on entry, and do not prove a counterfactual SELL/BUY could fill or survive stops.');
 p.push('No changes to entry strategy, account, trades, order size, broker stops, TP, or model weights.');
 p.push('');
 p.push('## Verified totals');
 p.push('');
 p.push('| Strategy | Closed | Wins | Losses | Net all | Losing-case net | Losses ever favorable | Peak above final fee magnitude then lost | Peak >=$20 then lost |');
 p.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
 for(const routeName of ROUTES){
   const x=summary[routeName];
   p.push('| '+routeName+' | '+x.closedTrades+' | '+x.winners+' | '+x.losers+' | $'+x.fullNetUsd+
    ' | $'+x.lossesNetUsd+' | '+(x.positivePeakAtOrBelowFinalCommissionMagnitude+x.positivePeakGreaterThanFinalCommissionMagnitudeThenLost)+
    ' | '+x.positivePeakGreaterThanFinalCommissionMagnitudeThenLost+' | '+x.peak20ThenLost+' |');
 }
 p.push('');
 p.push('## Loss exits by strategy');
 p.push('');
 p.push('| Route | Exit reason | Loss cases | Net loss |');
 p.push('|---|---|---:|---:|');
 for(const g of exitBreakdown)
  p.push('| '+g.route+' | '+g.reason+' | '+g.losingFills+' | $'+g.netLossUsd+' |');
 p.push('');
 p.push('## Instrument and side breakdown — includes the winners, not just failures');
 p.push('');
 p.push('| Strategy | Instrument & side | Closed | Winners | Losers | Net after costs |');
 p.push('|---|---|---:|---:|---:|---:|');
 for(const g of sideBreakdown)
  p.push('| '+g.route+' | '+g.instrument+' '+g.direction+' | '+g.trades+' | '+
   g.winners+' | '+g.losers+' | $'+g.netUsd+' |');
 p.push('');
 p.push('## Post-entry M1 sampled price movement (OUTCOMES ONLY)');
 p.push('');
 p.push('The following marks are not information the system had at the entry instant. Only verified completed quote marks captured WHILE the original position was still open are counted in comparisons. Both winners and losers can move against the chosen side at +1 minute.');
 p.push('A broker close within half a pip of the original stop is observed price geometry, NOT proof of the exact broker closure reason.');
 p.push('');
 p.push('| Route / horizon | Valid while open | Losses adverse | Losses favorable | Winners adverse | Winners favorable | Flagged adverse net |');
 p.push('|---|---:|---:|---:|---:|---:|---:|');
 for(const [key,g] of Object.entries(firstMarks))
  p.push('| '+key+' | '+g.validQuotes+' | '+g.losersAlreadyAdverseAtMark+'/'+g.losingTradeValidQuotes+
   ' | '+g.losersStillFavorableAtMark+'/'+g.losingTradeValidQuotes+
   ' | '+g.winnersAlreadyAdverseAtMark+'/'+g.winningTradeValidQuotes+
   ' | '+g.winnersFavorableAtMark+'/'+g.winningTradeValidQuotes+
   ' | $'+g.flaggedAdverseNetUsd+' |');
 p.push('');
 p.push('## Entry-time pattern contrast (losers AND winners)');
 p.push('');
 p.push('Flags below use only persisted as-of-entry evidence. They are selected after observing the cohort and therefore **not** validated predictors; blocking them now would be data snooping.');
 p.push('');
 p.push('| As-of rule | Strategy | Flagged | Lost | Won | Combined net of flagged |');
 p.push('|---|---|---:|---:|---:|---:|');
 for(const x of patterns){
   p.push('| '+x.pattern+' | '+x.route+' | '+x.flaggedEntries+' | '+x.flaggedLosses+' | '+x.flaggedWinners+' | $'+x.flaggedNetUsd+' |');
 }
 p.push('');
 for(const routeName of ROUTES){
   p.push('## '+routeName+' — each settled loss');
   p.push('');
   const x=losses.filter(r=>r.route===routeName);
   x.forEach((r,i)=>{
     const name=(routeName==='EARLY_TRANSITION'?'ET':'CR')+'-'+String(i+1).padStart(2,'0');
     const pipSample=HORIZONS.map(h=>{
       const s=r.futureSampledNativeQuoteOutcome[h+'m'];
       return h+'m='+(s?.status==='VALID_BROKER_NATIVE_CLOSE'?
         String(s.directionAlignedPips)+' pips (direction-aligned)':'unobserved');
     }).join(', ');
     const notes=r.flags.join('; ');
     p.push('### '+name+' · '+r.openedAt.slice(0,16).replace('T',' ')+' · '+r.instrument+' '+r.direction);
     p.push('');
     p.push('- Closed '+r.closedAt.slice(0,16).replace('T',' ')+
       ' UTC; held '+r.durationMinutes+' minutes; reason '+r.closeReason+
       '; lots '+r.lots+'.');
     p.push('- Net $'+r.netUsd+' = gross $'+r.grossPnlUsd+
       ' + commission $'+r.commissionUsd+' + swap $'+r.swapUsd+
       '. Original risk $'+r.initialRiskUsd+'.');
     p.push('- Recorded favorable peak $'+r.maxFavorableBrokerNet+
       '; adverse low $'+r.maxAdverseBrokerNet+
       '; peak > final fee magnitude '+(r.peakAboveCommission?'YES':'NO')+
       '; '+r.pathObservations+' observations.');
     p.push('- Entry at '+r.entryPrice+'; original SL '+r.brokerStop+
       ' and TP '+r.brokerTakeProfit+'.');
     p.push('- **At-entry evidence:** '+r.entryExplanation);
     p.push('- **Market after entry (descriptive only):** '+pipSample+'.');
     p.push('- **Exit geometry:** '+r.exitGeometry+
       '; exit distance from recorded stop '+r.exitToRecordedStopPips+
       ' pips. This does NOT prove the exact broker close trigger.');
     p.push('- **Failure markers:** '+notes+'.');
     p.push('- **Opposite-side audit:** '+r.oppositeDirectionInterpretation);
     p.push('');
   });
 }
 p.push('## What qualifies before changing entry-side logic');
 p.push('');
 p.push('1. Freeze the above patterns using only signals and broker quotes existing BEFORE each trade. Never label a failed BUY as proof of a profitable opposite SELL.');
 p.push('2. Compare each proposed warning against all profitable entries from the same route and instrument, including false positive blocks and actual after-commission expectancy.');
 p.push('3. Evaluate on independent later dates in a prospective SHADOW mode with broker-side spread, stops/targets, order availability and slippage; no data leakage or hindsight.');
 p.push('4. Update DEMO entry gates only with explicit approval and positive out-of-sample after-fee/drawdown evidence. Do not touch lot sizing or existing LIVE accounts.');
 p.push('');
 p.push('**Interpretation limit:** Current M1 primary route can say ABSTAIN while the separately qualified Plan-B Early Transition / Confirmed Reversal trial supplies independent entry authority; ABSTAIN by itself does not prove an unauthorized fill. Trained experts likewise can issue directional votes while the expert state remains ABSTAIN.');
 p.push('');
 return p.join('\n');
}
async function audit(db,owner,now=new Date()){
 if(!UUID.test(owner||''))throw Error('OWNER_SCOPE_INVALID');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='25000ms'");
  const trades=(await db.query(TRADE_SQL,[owner,FROM,TO])).rows;
  if(trades.length>1500)throw Error('TRADE_LIMIT_EXCEEDED');
  const account=(await db.query([
   "SELECT id::text FROM broker.broker_connections WHERE user_id=$1",
   "AND broker_id='pepperstone-ctrader' AND account_type='DEMO'",
   "AND account_currency='USD' AND deleted_at IS NULL",
   "ORDER BY id LIMIT 2"
  ].join(' '),[owner])).rows;
  if(account.length!==1)throw Error('NOT_EXACTLY_ONE_OWNER_DEMO_USD_CONNECTION');
  const pairs=[...new Set(trades.map(t=>t.instrument))];
  const quotes=pairs.length?(await db.query(QUOTE_SQL,[
   account[0].id,pairs,
   '2026-11-17T00:00:00Z','2026-11-19T00:20:00Z',
  ])).rows:[];
  if(quotes.length>15000)throw Error('QUOTE_LIMIT_EXCEEDED');
  const q={};for(const record of quotes)(q[record.instrument]??=[]).push(record);
  const all=makeRecords(trades,q,now.getTime());
  const losses=all.filter(r=>r.netUsd!==null&&r.netUsd<0);
  const summary=exposureStats(all);
  const patterns=causalPatternContrast(all);
  const sideBreakdown=byInstrumentSide(all);
  const initialMarkContrasts=firstMarkContrasts(all);
  const exitBreakdown=byExit(all);
  await db.query('COMMIT');
  const report={
   artifact:'owner-demo-loss-entry-forensics-nov17-18-v1',
   asOf:now.toISOString(),windowUTC:{from:FROM,to:TO},
   scope:'OWNER_ONLY_PEPPERSTONE_CTRADER_USD_DEMO',
   researchOnly:true,modifiesExecution:false,brokerOrders:0,
   totalExecutedClosedTrades:all.length,totalLosingFills:losses.length,
   validNativeQuoteBars:quotes.filter(x=>quoteUsable(x,now.getTime())).length,
   summary,causalPatterns:patterns,byInstrumentSide:sideBreakdown,
   firstMarkContrasts:initialMarkContrasts,losingExits:exitBreakdown,
   losingTrades:losses,
   limitations:[
    'Only closed executed fills in Pepperstone USD DEMO; never mix scanner candidates with broker trades.',
    'Max favorable P&L is broker-reported net unrealized mark, not a guaranteed fill; comparison with final commission is magnitude-only, NEVER subtract commission from the already-net mark.',
    'Trade-intent route is authoritative for which separately qualified strategy opened the trade; primary M1 ABSTAIN is a separate route.',
    'Frozen entry model probabilities, expert votes and candle features may not be statistically calibrated and do not guarantee a side.',
    'Observed after-entry prices are labeled outcome only; no automatic inverse order or decision permitted.',
    'This is an in-sample descriptive audit over just two dates, not a validated predictive classifier.',
   ],
  };
  return {report,trainingCohort:buildTrainingCohort(all,now.toISOString()),
    markdown:renderMarkdown(losses,all,summary,patterns,now.toISOString(),
    sideBreakdown,initialMarkContrasts,exitBreakdown)};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const c=new Client({
  host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  database:process.env.DB_NAME||'irexpro_dev',
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  application_name:'irexpro-loss-entry-forensics-readonly',
 });
 try{
  await c.connect();
  const {report,markdown,trainingCohort}=await audit(
   c,process.env.VPS_FOREX_SCANNER_USER_ID);
  fs.mkdirSync(OUT,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(OUT,'latest-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  fs.writeFileSync(path.join(OUT,'latest-report.md'),markdown,{mode:0o600});
  fs.writeFileSync(path.join(OUT,'latest-training-cohort.json'),
   JSON.stringify(trainingCohort,null,2),{mode:0o600});
  console.log('FORENSIC_REPORT_READY',JSON.stringify({
   asOf:report.asOf,total:report.totalExecutedClosedTrades,
   losses:report.totalLosingFills,validQuoteBars:report.validNativeQuoteBars,
   summary:report.summary,causalPatterns:report.causalPatterns,
   files:['latest-report.json','latest-report.md','latest-training-cohort.json'],
  }));
 }finally{await c.end()}
}
module.exports={num,round,risk,cost,net,quoteUsable,sampledAfterEntry,
 entrySnapshot,classifyLoss,makeRecords,exposureStats,causalPatternContrast,
 byInstrumentSide,firstMarkContrasts,byExit,buildTrainingCohort,audit,
 TRADE_SQL,QUOTE_SQL};
if(require.main===module)main().catch(e=>{
 console.error('READ_ONLY_LOSS_FORENSICS_FAILED',e.message);
 process.exitCode=1;
});
