'use strict';
/**
 * Owner Pepperstone USD DEMO only. Forward-enrolls OPEN positions <=90s from
 * broker opening, freezes pre-entry features, and later joins settled outcomes.
 * Historical 17-18 November loss memory is FROZEN ONCE before activation.
 * Never alters orders, risk gates, stop, TP, lot size, weights, LIVE accounts.
 */
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {fetchForOpenDecision}=require('./owner-demo-entry-candlestick-context.cjs');
const ROOT='/home/lightworld/webapps/irexpro-research/loss-pattern-forward';
const BASELINE_SOURCE='/home/lightworld/webapps/irexpro-research/loss-entry-forensics/latest-training-cohort.json';
const JOURNAL_SOURCE='irexpro-owner-demo-loss-pattern-forward-v1';
const ROUTES=['EARLY_TRANSITION','CONFIRMED_REVERSAL'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CADENCE=12000;
const MAX_ROWS=1500;
const SQL=[
 'SELECT t.id::text trade_key,t.broker_connection_id::text broker_connection_id,',
 't.opened_at,t.closed_at,t.status,t.instrument,t.direction,',
 't.lot_size,t.realised_pnl,t.commission,t.swap,t.close_reason,',
 't.max_favorable_pnl,t.max_adverse_pnl,t.path_observation_count,',
 'ti.id::text intent_id,ti.metadata,ti.created_at intent_at,',
 'd.id::text decision_id,d.evaluated_at decision_at,d.candidate,d.governance,',
 "ca.sizing_inputs->>'finalRiskAtStop' initial_risk,",
 "ca.sizing_inputs->>'riskAmount' fallback_risk",
 'FROM trading.trades t',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
 'AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id',
 'LEFT JOIN LATERAL (SELECT d.id,d.evaluated_at,d.candidate,d.governance',
 'FROM trading.m1_tactical_decisions d WHERE d.user_id=t.user_id',
 'AND d.broker_connection_id=t.broker_connection_id AND d.trade_intent_id=ti.id',
 'AND d.evaluated_at<=t.opened_at ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 1) d ON TRUE',
 'LEFT JOIN LATERAL (SELECT ca.sizing_inputs FROM trading.capital_allocations ca',
 'WHERE ca.user_id=t.user_id AND ca.trade_intent_id=ti.id',
 'AND ca.created_at<=t.opened_at ORDER BY ca.created_at DESC,ca.id DESC LIMIT 1) ca ON TRUE',
 'WHERE t.user_id=$1 AND b.user_id=$1 AND b.broker_id=$2',
 "AND b.account_type='DEMO' AND b.account_currency='USD'",
 "AND b.deleted_at IS NULL AND t.account_currency='USD'",
 'AND t.opened_at >= $3::timestamptz',
 "AND ti.metadata->>'multimodel_plan_b_route' IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
 "AND t.status IN ('OPEN','CLOSED')",
 'ORDER BY t.opened_at DESC LIMIT 1501',
].join(' ');
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const date=x=>x==null?NaN:new Date(x).getTime();
const iso=x=>new Date(x).toISOString();
const rnd=(x,k=3)=>x==null||!Number.isFinite(x)?null:+x.toFixed(k);
const sha=s=>createHash('sha256').update(s).digest('hex');
function frozenEntry(row,now){
 const opened=date(row.opened_at),at=date(row.decision_at),intent=date(row.intent_at);
 if(!UUID.test(String(row.trade_key))||!UUID.test(String(row.intent_id))||
   !UUID.test(String(row.decision_id))||
   !Number.isFinite(opened)||!Number.isFinite(at)||!Number.isFinite(intent)||
   at>opened||intent>opened||opened-at>10*60000||
   opened-intent>120000||now<opened||now-opened>90000||row.status!=='OPEN')
  return null;
 const route=row.metadata?.multimodel_plan_b_route;
 if(!ROUTES.includes(route)||!['BUY','SELL'].includes(row.direction)||
    !['EURUSD','AUDUSD','USDJPY','USDCAD'].includes(row.instrument))
  return null;
 const c=row.candidate||{},g=row.governance||{},
  e=g.multimodelEnsemble||{},expert=g.multimodelTrainedExpert||{};
 const risk=num(row.initial_risk)>0?num(row.initial_risk):
   num(row.fallback_risk)>0?num(row.fallback_risk):null;
 const feature={
  instrument:row.instrument,direction:row.direction,route,
  decisionAt:iso(at),openedAt:iso(opened),
  alignedH1:num(c.alignedH1),alignedH4:num(c.alignedH4),
  alignedM15:num(c.alignedM15),alignedM5:num(c.alignedM5),
  alignedM1Momentum3Atr:num(c.alignedMomentum3Atr),
  alignedM5Momentum3Atr:num(c.alignedM5Momentum3Atr),
  alignedM5BodyPressure:num(c.alignedM5LatestBodyPressure),
  m5BodyExpansionRatio:num(c.m5BodyExpansionRatio),
  metaProbability:num(e.metaProbability),
  ensembleScore:num(e.ensembleScore),
  expectedNetR:num(row.metadata?.multimodel_governance_net_expected_r),
  expertState:expert.state??row.metadata?.multimodel_trained_expert_state??null,
  expertDirection:expert.direction??row.metadata?.multimodel_trained_expert_direction??null,
  consensusPassed:num(e.consensusPassed),consensusRequired:num(e.consensusRequired),
  originalAuthority:row.metadata?.multimodel_execution_authority_path??null,
  initialRiskUsd:risk,
 };
 return feature;
}
const HYPOTHESES=Object.freeze([
 {id:'CR_USDJPY_BUY',test:f=>f.route==='CONFIRMED_REVERSAL'&&f.instrument==='USDJPY'&&f.direction==='BUY'},
 {id:'CR_M5_OPPOSES',test:f=>f.route==='CONFIRMED_REVERSAL'&&f.alignedM5!==null&&f.alignedM5<=-0.2},
 {id:'ET_M1_MOMENTUM3_OPPOSES',test:f=>f.route==='EARLY_TRANSITION'&&f.alignedM1Momentum3Atr!==null&&f.alignedM1Momentum3Atr<=-0.3},
 {id:'HIGHER_H1_H4_BOTH_OPPOSE',test:f=>f.alignedH1!==null&&f.alignedH4!==null&&f.alignedH1<=-0.25&&f.alignedH4<=-0.25},
 {id:'PLANB_META_BELOW_50PCT',test:f=>f.metaProbability!==null&&f.metaProbability<0.50},
 {id:'M5_BODY_PRESSURE_OPPOSES',test:f=>f.alignedM5BodyPressure!==null&&f.alignedM5BodyPressure<=-0.3},
 {id:'INDEPENDENT_EXPERT_ABSTAIN',test:f=>f.expertState==='ABSTAIN'},
]);
function scoreEntry(f,baseline){
 const historical=baseline.records.filter(r=>{
  const b=r.entryFeatures;return b.route===f.route&&
   b.instrument===f.instrument&&b.direction===f.direction;
 });
 const numeric=['alignedH1','alignedH4','alignedM15','alignedM5',
  'alignedM1Momentum3Atr','alignedM5Momentum3Atr','alignedM5BodyPressure',
  'metaProbability'];
 const distance=b=>{
  let sum=0,covered=0;
  for(const field of numeric){
   if(num(f[field])===null||num(b[field])===null)continue;
   const unit=field==='metaProbability'?0.2:
    field.includes('Momentum')?2:1;
   const d=Math.max(-3,Math.min(3,(f[field]-b[field])/unit));
   sum+=d*d;covered++;
  }
  return covered>=5?Math.sqrt(sum/covered):Infinity;
 };
 const ranked=historical.map(r=>({
  distance:distance(r.entryFeatures),openedAt:r.openedAt,
  day:r.tradingDay,net:r.futureOutcomesDoNotUseAsInputs.netPnlUsd,
 })).filter(x=>Number.isFinite(x.distance))
  .sort((a,b)=>a.distance-b.distance||a.openedAt.localeCompare(b.openedAt))
  .slice(0,5);
 const n=ranked.length,loss=ranked.filter(r=>r.net<0).length,
  days=new Set(ranked.map(r=>r.day)).size;
 return {
  nearestHistoryCount:n,independentHistoricalDays:days,
  nearestLosses:loss,nearestWinners:n-loss,
  nearestMeanNetUsd:n?rnd(ranked.reduce((a,b)=>a+b.net,0)/n,2):null,
  nearestMeanDistance:n?rnd(ranked.reduce((a,b)=>a+b.distance,0)/n,4):null,
  memoryState:n>=5&&days>=3?'EXPLORATORY_ONLY_NOT_CALIBRATED':
    'INSUFFICIENT_INDEPENDENT_HISTORICAL_EXAMPLES',
  canAuthorizeOppositeOrder:false,
 };
}
function evaluateEntry(f,baseline){
 return {features:f,preRegisteredWarnings:HYPOTHESES.filter(x=>x.test(f)).map(x=>x.id),
  memory:scoreEntry(f,baseline),
  originalDirectionRemainsAuthoritative:true,
  noTradeAuthority:true,noDirectionFlip:true,noTradeVeto:true};
}
function setStages(events){
 const map=new Map();
 for(const x of events){
  if(x?.artifact!==JOURNAL_SOURCE||!UUID.test(String(x.tradeKey))||
   typeof x.stage!=='string')continue;
  if(!map.has(x.tradeKey))map.set(x.tradeKey,new Map());
  const m=map.get(x.tradeKey);
  if(!m.has(x.stage))m.set(x.stage,x);
 }
 return map;
}
function plan(row,stages,now,baseline){
 const key=String(row.trade_key);
 if(!UUID.test(key))return [];
 const m=stages?.get(key)||new Map(),opened=date(row.opened_at);
 if(!Number.isFinite(opened)||opened>now)return [];
 const events=[];
 if(!m.has('ENTRY')&&!m.has('ENTRY_MISSED')){
  const feature=frozenEntry(row,now);
  if(!feature){
   return [{artifact:JOURNAL_SOURCE,tradeKey:key,stage:'ENTRY_MISSED',
    capturedAt:iso(now),reason:'NOT_OPEN_ON_TIME_OR_ENTRY_EVIDENCE_UNAVAILABLE',
    noTradeAuthority:true}];
  }
  return [{artifact:JOURNAL_SOURCE,tradeKey:key,stage:'ENTRY',
   capturedAt:iso(now),openedAt:iso(opened),
   entry:{...evaluateEntry(feature,baseline),
    preEntryCandlesticks:row.preEntryCandlesticks||{
     mode:'NO_VERIFIED_PRE_ENTRY_CANDLES',
     M1:{state:'NOT_AVAILABLE_AT_CAPTURE'},
     M5:{state:'NOT_AVAILABLE_AT_CAPTURE'},
     noTradingAuthority:true}},
   noPostEntryDataAtEnrollment:true,noTradeAuthority:true}];
 }
 if(!m.has('ENTRY'))return events;
 const entry=m.get('ENTRY'),risk=num(entry.entry?.features?.initialRiskUsd);
 const peak=num(row.max_favorable_pnl);
 if(row.status==='OPEN'&&risk>0&&peak!==null){
  for(const [stage,level] of [['PEAK_025R',.25],['PEAK_050R',.50]]){
   if(!m.has(stage)&&peak>=risk*level){
    events.push({artifact:JOURNAL_SOURCE,tradeKey:key,stage,
     capturedAt:iso(now),peakBrokerNetUsd:rnd(peak,2),
     originalRiskUsd:risk,observedPeakR:rnd(peak/risk),
     positionWasOpenAtObservation:true,noTradeAuthority:true});
   }
  }
 }
 if(row.status==='CLOSED'&&!m.has('SETTLED')){
  const gross=num(row.realised_pnl),fee=num(row.commission),swap=num(row.swap);
  // A local OPEN observation is not broker proof by itself. Later settlement
  // must independently establish that the position closed AFTER capture.
  const closed=date(row.closed_at),captured=date(entry.capturedAt);
  if(Number.isFinite(closed)&&closed>captured&&
     gross!==null&&fee!==null&&fee<=0&&swap!==null){
   events.push({artifact:JOURNAL_SOURCE,tradeKey:key,stage:'SETTLED',
    capturedAt:iso(now),closedAt:row.closed_at,closeReason:row.close_reason,
    settledNetUsd:rnd(gross+fee+swap,2),grossUsd:rnd(gross,2),
    signedCommissionUsd:rnd(fee,2),swapUsd:rnd(swap,2),
    maxFavorableBrokerNetUsd:rnd(num(row.max_favorable_pnl),2),
    maxAdverseBrokerNetUsd:rnd(num(row.max_adverse_pnl),2),
    pathObservationCount:num(row.path_observation_count),
    eventualOutcomeOnly:true,noTradeAuthority:true});
  }
 }
 return events;
}
function summarize(events,marker,baseline){
 const map=setStages(events),valid=[];
 let missed=0,unmatched=0,peak025=0,peak050=0;
 for(const [,m] of map){
  if(m.has('ENTRY_MISSED')){missed++;continue}
  const entry=m.get('ENTRY');
  if(!entry)continue;
  if(date(entry.capturedAt)<date(marker.activatedAt)||
    date(entry.openedAt)<date(marker.activatedAt)){
   unmatched++;continue
  }
  const settled=m.get('SETTLED')||null;
  if(m.has('PEAK_025R'))peak025++;
  if(m.has('PEAK_050R'))peak050++;
  valid.push({entry,settled,peak025:m.has('PEAK_025R'),peak050:m.has('PEAK_050R')});
 }
 const stats=rows=>{
  const done=rows.filter(x=>num(x.settled?.settledNetUsd)!==null);
  const winners=done.filter(x=>num(x.settled.settledNetUsd)>0);
  const losers=done.filter(x=>num(x.settled.settledNetUsd)<0);
  const sum=xs=>rnd(xs.reduce((a,b)=>a+Number(b.settled.settledNetUsd),0),2);
  const riskRows=done.filter(x=>num(x.entry.entry.features.initialRiskUsd)>0);
  const sumRisk=riskRows.reduce((a,x)=>a+num(x.entry.entry.features.initialRiskUsd),0);
  const meanR=riskRows.length?riskRows.reduce((a,x)=>
   a+num(x.settled.settledNetUsd)/num(x.entry.entry.features.initialRiskUsd),0)/riskRows.length:null;
  const winNet=sum(winners),lossNet=sum(losers);
  // Economic attribution is computed only AFTER broker settlement. None of
  // gross/fee/swap/closeReason feeds the frozen pre-entry warning membership.
  // All three signed components must exist; do not infer missing charges.
  const economic=done.filter(x=>{
   const s=x.settled,g=num(s.grossUsd),c=num(s.signedCommissionUsd),w=num(s.swapUsd),n=num(s.settledNetUsd);
   return g!==null&&c!==null&&c<=0&&w!==null&&n!==null&&
    Math.abs((g+c+w)-n)<=0.03;
  });
  const grossPositive=economic.filter(x=>num(x.settled.grossUsd)>0);
  const grossNegative=economic.filter(x=>num(x.settled.grossUsd)<0);
  const feeFlipped=economic.filter(x=>num(x.settled.grossUsd)>0&&num(x.settled.settledNetUsd)<0);
  const grossSum=xs=>xs.reduce((s,x)=>s+num(x.settled.grossUsd),0);
  const signedCosts=economic.reduce((s,x)=>({
   commission:s.commission+num(x.settled.signedCommissionUsd),
   swap:s.swap+num(x.settled.swapUsd),
  }),{commission:0,swap:0});
  return {enrolled:rows.length,settled:done.length,openOrUnsettled:rows.length-done.length,
   wins:winners.length,losses:losers.length,
   winRate:done.length?rnd(winners.length/done.length,4):null,
   winnerNetUsd:winNet,loserNetUsd:lossNet,netUsd:sum(done),
   afterCostProfitFactor:lossNet<0?rnd(winNet/-lossNet,4):null,
   economicsSettlementCovered:economic.length,
   economicsMissingOrMismatched:done.length-economic.length,
   grossTradingPnlUsd:rnd(grossSum(economic),2),
   signedCommissionUsd:rnd(signedCosts.commission,2),
   signedSwapUsd:rnd(signedCosts.swap,2),
   totalSignedCostUsd:rnd(signedCosts.commission+signedCosts.swap,2),
   grossProfitableTrades:grossPositive.length,
   grossLossMakingTrades:grossNegative.length,
   grossProfitableButNetLosingTrades:feeFlipped.length,
   grossProfitableButNetLosingGrossUsd:rnd(grossSum(feeFlipped),2),
   grossProfitableButNetLosingNetUsd:sum(feeFlipped),
   grossNegativeTradesNetUsd:sum(grossNegative),
   costsDoNotOverrideFrozenEntryMembership:true,
   initialStopRiskCovered:riskRows.length,initialStopRiskMissing:done.length-riskRows.length,
   meanNetR:meanR===null?null:rnd(meanR,4),
   pooledNetPerInitialStopRisk:sumRisk>0?
    rnd(riskRows.reduce((a,x)=>a+num(x.settled.settledNetUsd),0)/sumRisk,4):null,
   eligibleToRecommendTrades:false};
 };
 const byRoute={};
 for(const route of ROUTES)
  byRoute[route]=stats(valid.filter(x=>x.entry.entry.features.route===route));
 const byWarning={};
 for(const h of HYPOTHESES){
  const yes=valid.filter(x=>x.entry.entry.preRegisteredWarnings.includes(h.id));
  const no=valid.filter(x=>!x.entry.entry.preRegisteredWarnings.includes(h.id));
  byWarning[h.id]={flagged:stats(yes),unflagged:stats(no),
   originallyFixedBeforeFutureOutcome:true,notAnExecutableRiskVeto:true};
 }
 // Frozen entry-time enrollment only; instrument/route slices cannot use
 // future realized outcomes to change their membership or thresholds.
 const byRouteInstrument={};
 const byRouteWarning={};
 const byCloseReason={};
 for(const route of ROUTES){
  const routed=valid.filter(x=>x.entry.entry.features.route===route);
  for(const symbol of ['EURUSD','AUDUSD','USDJPY','USDCAD']){
   const scoped=routed.filter(x=>x.entry.entry.features.instrument===symbol);
   byRouteInstrument[route+'|'+symbol]=stats(scoped);
  }
  for(const hypothesis of HYPOTHESES){
   const flagged=routed.filter(x=>x.entry.entry.preRegisteredWarnings.includes(hypothesis.id));
   const unflagged=routed.filter(x=>!x.entry.entry.preRegisteredWarnings.includes(hypothesis.id));
   byRouteWarning[route+'|'+hypothesis.id]={
    flagged:stats(flagged),unflagged:stats(unflagged),
    hypotheticalWinnersRejected:stats(flagged).wins,
    hypotheticalLosersAvoided:stats(flagged).losses,
    purelyObservational:true,executableVetoEligible:false,
   };
  }
 }
 for(const reason of ['PROFIT_PROTECTION','AI_CLOSE_SIGNAL','BROKER_CLOSE'])
  byCloseReason[reason]=stats(valid.filter(x=>x.settled?.closeReason===reason));
 const settled=valid.filter(x=>num(x.settled?.settledNetUsd)!==null);
 const days=[...new Set(settled.map(x=>x.entry.entry.features.openedAt.slice(0,10)))];
 const profitGivebacks=settled.filter(x=>x.settled.settledNetUsd<0&&
  num(x.settled.maxFavorableBrokerNetUsd)>0);
 return {
  artifact:'irexpro-owner-demo-loss-pattern-forward-summary-v1',
  generatedAt:new Date().toISOString(),activatedAt:marker.activatedAt,
  frozenBaselineSha256:marker.baselineSha256,
  baselineTrades:baseline.records.length,
  broker:'pepperstone-ctrader',accountType:'DEMO',accountCurrency:'USD',
  researchOnly:true,modifiesExecution:false,modifiesLotSize:false,
  brokerOrders:0,modelWeightsUpdated:false,autoReverseEnabled:false,
  futureEntriesEnrolled:valid.length,missedEntryWindows:missed,
  preActivationEntriesIgnored:unmatched,
  futureIndependentSettledDays:days.length,
  confirmedPeak025REvents:peak025,confirmedPeak050REvents:peak050,
  futureSettledProfitGaveBackToLoss:profitGivebacks.length,
  byRoute,byWarning,byRouteInstrument,byRouteWarning,byCloseReason,
  riskNormalization:'BROKER_NET_DIVIDED_BY_FROZEN_PRE_FILL_ALLOCATION_RISK_DENOMINATOR; FALLBACK_RISK_AMOUNT_MAY_NOT_EQUAL_ACTUAL_STOP_RISK',
  frozenWarningMembershipUnchanged:true,
  qualification:'NOT_QUALIFIED_TO_MODIFY_EXECUTION',
  requiredEvidence:'Multiple independent future market days, broker-net positive expectancy, low false rejection of winners, after-cost and drawdown tests. A losing BUY is not proof that a SELL would profit.',
 };
}
function loadActivation(root,owner,at=Date.now(),source=BASELINE_SOURCE){
 if(!UUID.test(owner))throw Error('INVALID_OWNER_ID');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const baselineFile=path.join(root,'frozen-baseline.json');
 const markerFile=path.join(root,'activation.json');
 let marker;
 if(!fs.existsSync(markerFile)){
  const raw=fs.readFileSync(source,'utf8'),baseline=JSON.parse(raw);
  if(!Array.isArray(baseline.records)||baseline.records.length<10||
     baseline.records.some(x=>date(x.openedAt)>=at)||
     baseline.researchOnly!==true||baseline.modifiesExecution!==false)
   throw Error('INVALID_OR_FUTURE_CONTAMINATED_BASELINE');
  const hash=sha(raw),ownerFingerprint=sha(owner);
  if(fs.existsSync(baselineFile)){
   if(sha(fs.readFileSync(baselineFile,'utf8'))!==hash)
    throw Error('BASELINE_FREEZE_COLLISION');
  }else fs.writeFileSync(baselineFile,raw,{flag:'wx',mode:0o600});
  marker={artifact:JOURNAL_SOURCE,activatedAt:iso(at),
   baselineSha256:hash,ownerFingerprint,
   frozenRoutes:ROUTES,hypothesisIds:HYPOTHESES.map(x=>x.id),
   riskAndExecutionAuthority:'NONE'};
  fs.writeFileSync(markerFile,JSON.stringify(marker,null,2),{flag:'wx',mode:0o600});
 }else marker=JSON.parse(fs.readFileSync(markerFile,'utf8'));
 const raw=fs.readFileSync(baselineFile,'utf8');
 if(marker.artifact!==JOURNAL_SOURCE||marker.ownerFingerprint!==sha(owner)||
    sha(raw)!==marker.baselineSha256||!(date(marker.activatedAt)<=at)||
    JSON.stringify(marker.hypothesisIds)!==JSON.stringify(HYPOTHESES.map(x=>x.id)))
  throw Error('TAMPERED_OR_MISMATCHED_SHADOW_FREEZE');
 return {marker,baseline:JSON.parse(raw)};
}
function readJournal(root,at=Date.now()){
 const events=[];
 const from=at-20*86400000;
 for(const name of fs.readdirSync(root).filter(x=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()){
  if(date(name.slice(0,10)+'T00:00:00Z')<from)continue;
  const file=path.join(root,name),st=fs.statSync(file);
  if(!st.isFile()||st.size>8*1024*1024)throw Error('OVERSIZED_SHADOW_JOURNAL');
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
   if(!line)continue;
   const e=JSON.parse(line);events.push(e);
   if(events.length>20000)throw Error('TOO_MANY_SHADOW_EVENTS');
  }
 }
 return events;
}
function append(root,e){
 const file=path.join(root,e.capturedAt.slice(0,10)+'.jsonl');
 fs.appendFileSync(file,JSON.stringify(e)+'\n',{encoding:'utf8',flag:'a',mode:0o600});
}
function writeSummary(root,marker,baseline,events){
 const report=summarize(events,marker,baseline);
 const p=path.join(root,'latest-summary.json'),temp=p+'.'+process.pid+'.tmp';
 // Owner-only summary is readable by the authorized 'lightworld' ACL
 // inherited from the private directory; private raw journal stays 0600.
 fs.writeFileSync(temp,JSON.stringify(report,null,2),{flag:'wx',mode:0o640});
 fs.renameSync(temp,p);
 return report;
}
async function readTrades(client,owner,activation){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='12000ms'");
  const rows=(await client.query(SQL,[owner,'pepperstone-ctrader',activation])).rows;
  if(rows.length>MAX_ROWS)throw Error('SHADOW_DB_SCAN_TOO_LARGE');
  await client.query('COMMIT');return rows;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
}
async function tick({client,owner,marker,baseline,root,now=Date.now()}){
 const rows=await readTrades(client,owner,marker.activatedAt);
 const events=readJournal(root,now),stages=setStages(events);
 let added=0;
 for(const row of rows){
  const stagesForTrade=stages.get(String(row.trade_key));
  if(row.status==='OPEN'&&!stagesForTrade?.has('ENTRY')&&
     !stagesForTrade?.has('ENTRY_MISSED')&&
     Number.isFinite(date(row.opened_at))&&
     now>=date(row.opened_at)&&now-date(row.opened_at)<=90000){
   try{
    // Completed, as-of native candle snapshots are captured exactly once
    // before a position outcome. A data gap never delays other trades.
    row.preEntryCandlesticks=await fetchForOpenDecision(client,row);
   }catch(error){
    row.preEntryCandlesticks={
     mode:'NO_VERIFIED_PRE_ENTRY_CANDLES',
     M1:{state:'NATIVE_CANDLE_QUERY_UNAVAILABLE'},
     M5:{state:'NATIVE_CANDLE_QUERY_UNAVAILABLE'},
     noTradingAuthority:true};
   }
  }
  const decisions=plan(row,stages,now,baseline);
  for(const e of decisions){
   // Recheck idempotence even when several related events arise in same poll.
   const m=stages.get(e.tradeKey)||new Map();
   if(m.has(e.stage))continue;
   append(root,e);events.push(e);m.set(e.stage,e);stages.set(e.tradeKey,m);
   added++;
  }
 }
 const report=writeSummary(root,marker,baseline,events);
 return {added,observed:rows.length,report};
}
const MAX_STALLED_STEP_MS=90_000;
function watchdogStalled(busySince,now=Date.now(),threshold=MAX_STALLED_STEP_MS){
 return Number.isFinite(busySince)&&busySince>0&&Number.isFinite(now)&&
  Number.isFinite(threshold)&&threshold>0&&now-busySince>threshold;
}
async function main(){
 require('dotenv').config({path:path.join(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const {getDatabaseSslOptions}=require('../dist/config/database-tls');
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 const {marker,baseline}=loadActivation(ROOT,owner);
 const c=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  connectionTimeoutMillis:8000,query_timeout:15000,
  application_name:'irexpro-owner-loss-memory-readonly'});
 await c.connect();
 let busy=false,stopped=false,busySince=null,consecutiveFailures=0;
 // Install watchdog before FIRST tick: otherwise a hung initial read may
 // leave PM2 reporting 'online' while no future entries are frozen.
 const watchdog=setInterval(()=>{
  if(!stopped&&watchdogStalled(busySince)){
   console.error('LOSS_PATTERN_SHADOW_STALLED_RESTART',JSON.stringify({
    busySeconds:Math.round((Date.now()-busySince)/1000),
    noTradingAuthority:true}));
   process.exit(1); // PM2 restarts only this isolated read-only watcher.
  }
 },CADENCE);
 const step=async()=>{
  if(stopped||busy)return;
  busy=true;busySince=Date.now();try{
   const x=await tick({client:c,owner,marker,baseline,root:ROOT});
   consecutiveFailures=0;
   if(x.added||!process.argv.includes('--watch'))
    console.log('LOSS_PATTERN_SHADOW',JSON.stringify({
     at:x.report.generatedAt,enrolled:x.report.futureEntriesEnrolled,
     settled:Object.values(x.report.byRoute).reduce((n,v)=>n+v.settled,0),
     events:x.added,qualified:false,brokerOrders:0,modifiesExecution:false,
   }));
  }catch(e){
   consecutiveFailures++;
   console.error('LOSS_PATTERN_SHADOW_DEFERRED',e.message.slice(0,180));
   if(consecutiveFailures>=3){
    console.error('LOSS_PATTERN_SHADOW_REPEAT_FAILURE_RESTART',JSON.stringify({
     consecutiveFailures,noTradingAuthority:true}));
    process.exit(1); // Restart only this research process; do not touch API.
   }
  }finally{busy=false;busySince=null}
 };
 await step();
 if(!process.argv.includes('--watch')){
  clearInterval(watchdog);await c.end();
  if(consecutiveFailures)process.exitCode=1;
  return;
 }
 const timer=setInterval(step,CADENCE);
 const stop=async()=>{stopped=true;clearInterval(timer);clearInterval(watchdog);
  while(busy)await new Promise(r=>setTimeout(r,100));
  await c.end().catch(()=>{});process.exit(0)};
 process.once('SIGTERM',()=>void stop());
 process.once('SIGINT',()=>void stop());
}
module.exports={ROOT,JOURNAL_SOURCE,BASELINE_SOURCE,HYPOTHESES,SQL,
 frozenEntry,scoreEntry,evaluateEntry,plan,summarize,loadActivation,
 setStages,readJournal,readTrades,tick,watchdogStalled,MAX_STALLED_STEP_MS};
if(require.main===module)main().catch(e=>{
 console.error('LOSS_PATTERN_SHADOW_FATAL',String(e.message).slice(0,180));process.exitCode=1;
});
