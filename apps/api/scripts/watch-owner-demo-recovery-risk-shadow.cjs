#!/usr/bin/env node
'use strict';
/**
 * Owner-only Pepperstone USD DEMO prospective recovery-pressure observer.
 * READ ONLY against DB. Immutable OPEN-only entry and as-of quote snapshots.
 * No broker calls, no stop changes, no model training, no execution authority.
 */
const path=require('node:path'),fs=require('node:fs');
const {createHash}=require('node:crypto');
const model=require('./owner-demo-recovery-risk-shadow.cjs');
const rapid=require('./owner-demo-subminute-recovery-shadow.cjs');
const {evaluate:evaluateForwardRecovery}=require('./owner-demo-recovery-risk-evaluation.cjs');
const ROOT='/home/lightworld/webapps/irexpro-research/recovery-risk-forward';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HORIZONS=model.HORIZONS;
const ns=x=>x===null||x===undefined||x===''?null:Number.isFinite(+x)?+x:null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const sha=x=>createHash('sha256').update(x).digest('hex');
const TRADES_SQL=[
 'SELECT t.id::text trade_id,t.broker_connection_id::text broker_connection_id,',
 't.opened_at,t.closed_at,t.status,t.instrument,t.direction,t.fill_price,t.lot_size,',
 'ti.stop_loss,ti.metadata->>\'multimodel_plan_b_route\' route,',
 't.max_favorable_pnl,t.profit_giveback,t.path_last_observed_at,',
 't.realised_pnl,t.commission,t.swap,t.close_reason,ca.sizing_inputs',
 'FROM trading.trades t JOIN broker.broker_connections b',
 'ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
 'AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id',
 'LEFT JOIN LATERAL(SELECT a.sizing_inputs FROM trading.capital_allocations a',
 'WHERE a.user_id=t.user_id AND a.trade_intent_id=ti.id',
 'AND a.created_at<=t.opened_at ORDER BY a.created_at DESC,a.id DESC LIMIT 1) ca ON TRUE',
 'WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND b.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD'",
 'AND b.deleted_at IS NULL AND t.opened_at>=$3::timestamptz',
 "AND t.opened_at>=current_timestamp-interval '48 hours'",
 "AND t.status IN ('OPEN','CLOSED')",
 "AND (t.status='OPEN' OR t.closed_at>=current_timestamp-interval '2 hours')",
 "AND ti.metadata->>'multimodel_plan_b_route' IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
 'ORDER BY t.opened_at DESC,t.id LIMIT 251'
].join(' ');
const QUOTES_SQL=[
 'SELECT instrument,timeframe,bucket_time,source,created_at,updated_at,',
 'sample_count,positive_quote_sample_count,last_positive_sample_at,',
 'last_positive_bid,last_positive_ask',
 'FROM market_data.provider_quote_candles',
 "WHERE connection_id=$1 AND timeframe='M1' AND source='ctrader-broker-native'",
 'AND instrument=ANY($2::text[])',
 "AND bucket_time>=current_timestamp-interval '11 minutes'",
 'ORDER BY instrument,bucket_time DESC LIMIT 100'
].join(' ');
// Live forming M1 native quotes are read only while fresh OPEN demo positions
// exist; never use later-updated quotes as an earlier decision snapshot.
const RAPID_QUOTES_SQL=[
 'SELECT DISTINCT ON(instrument) instrument,timeframe,bucket_time,source,',
 'created_at,updated_at,sample_count,positive_quote_sample_count,',
 'last_positive_sample_at,last_positive_bid,last_positive_ask',
 'FROM market_data.provider_quote_candles',
 "WHERE connection_id=$1 AND timeframe='M1' AND source='ctrader-broker-native'",
 'AND instrument=ANY($2::text[])',
 "AND bucket_time>=date_trunc('minute',$3::timestamptz)-interval '1 minute'",
 'AND bucket_time<=date_trunc(\'minute\',$3::timestamptz)',
 'ORDER BY instrument,bucket_time DESC'
].join(' ');
// Pre-entry broker fee evidence ONLY: never use the trade's own subsequent
// commission to form a predictor. Limit to the latest 32 PRIOR settlements.
const FEES_SQL=[
 'SELECT count(*)::int AS fee_samples,',
 'round(avg(z.fee)::numeric,5) AS historical_fee_per_lot,',
 'min(z.fee) AS min_fee_per_lot,max(z.fee) AS max_fee_per_lot',
 'FROM (SELECT abs(h.commission)/h.lot_size AS fee FROM trading.trades h',
 'WHERE h.user_id=$1 AND h.broker_connection_id=$2',
 "AND h.account_currency='USD' AND h.status='CLOSED'",
 'AND h.closed_at<$3::timestamptz',
 'AND h.created_at<=$3::timestamptz AND h.updated_at<=$3::timestamptz',
 "AND h.opened_at>=$3::timestamptz-interval '7 days'",
 'AND h.commission<0 AND h.lot_size>0',
 'ORDER BY h.closed_at DESC LIMIT 32) z'
].join(' ');
function setup(root,owner,connection,now=Date.now()){
 if(!UUID.test(owner)||!UUID.test(connection))throw Error('MISSING_EXACT_DEMO_SCOPE');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const file=path.join(root,'activation.json');
 if(!fs.existsSync(file)){
  const marker={artifact:model.ARTIFACT,activatedAt:new Date(now).toISOString(),
   ownerHash:sha(owner),brokerConnectionHash:sha(connection),
   accountType:'DEMO',accountCurrency:'USD',broker:'pepperstone-ctrader',
   readOnly:true,noBrokerOrders:true,changesExecution:false,
   canAutoPromote:false};
  fs.writeFileSync(file,JSON.stringify(marker,null,2),{flag:'wx',mode:0o600});
 }
 const marker=JSON.parse(fs.readFileSync(file,'utf8'));
 if(marker.artifact!==model.ARTIFACT||marker.ownerHash!==sha(owner)||
  marker.brokerConnectionHash!==sha(connection)||marker.changesExecution!==false||
  marker.canAutoPromote!==false||marker.readOnly!==true||
  marker.broker!=='pepperstone-ctrader'||marker.accountType!=='DEMO'||
  marker.accountCurrency!=='USD'||!Number.isFinite(ms(marker.activatedAt))||
  ms(marker.activatedAt)>now)throw Error('INVALID_FROZEN_ACTIVATION');
 const statePath=path.join(root,'state.json');
 const state=fs.existsSync(statePath)?
  JSON.parse(fs.readFileSync(statePath,'utf8')):
  {artifact:model.ARTIFACT,trades:{}};
 if(state.artifact!==model.ARTIFACT||!state.trades)throw Error('INVALID_STATE');
 return {marker,state};
}
function setupEarlyCaution(root,owner,conn,now=Date.now()){
 if(!UUID.test(owner)||!UUID.test(conn))throw Error('EARLY_CAUTION_SCOPE_REQUIRED');
 const file=path.join(root,'early-profit-caution-activation.json');
 if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({
  artifact:model.EARLY_CAUTION_ARTIFACT,
  activatedAt:new Date(now).toISOString(),
  ownerHash:sha(owner),brokerConnectionHash:sha(conn),
  broker:'pepperstone-ctrader',accountType:'DEMO',accountCurrency:'USD',
  priceDecayFractionMax:.8,priceDecayFractionMin:.2,
  minimumPeakToFeeMultiple:1.5,minimumStopHeadroomR:.35,
  m1AlignedRMax:-.055,m3AlignedRMin:-.11,
  quoteNetPositiveRequired:true,readOnly:true,canAutoClose:false,
  noRetrospectiveScoring:true,canAutoPromote:false,
 },null,2),{flag:'wx',mode:0o600});
 const rule=JSON.parse(fs.readFileSync(file,'utf8'));
 if(rule.artifact!==model.EARLY_CAUTION_ARTIFACT||rule.ownerHash!==sha(owner)||
  rule.brokerConnectionHash!==sha(conn)||rule.broker!=='pepperstone-ctrader'||
  rule.accountType!=='DEMO'||rule.accountCurrency!=='USD'||
  rule.priceDecayFractionMax!==.8||rule.priceDecayFractionMin!==.2||
  rule.minimumPeakToFeeMultiple!==1.5||rule.minimumStopHeadroomR!==.35||
  rule.quoteNetPositiveRequired!==true||
  rule.m1AlignedRMax!==-.055||rule.m3AlignedRMin!==-.11||
  rule.canAutoClose!==false||rule.canAutoPromote!==false||
  rule.noRetrospectiveScoring!==true||rule.readOnly!==true||
  !Number.isFinite(ms(rule.activatedAt))||ms(rule.activatedAt)>now)
  throw Error('INVALID_FROZEN_EARLY_CAUTION_RULE');
 return rule;
}
function setupRapid(root,owner,conn,now=Date.now()){
 if(!UUID.test(owner)||!UUID.test(conn))throw Error('RAPID_QUOTE_EXACT_SCOPE_REQUIRED');
 const file=path.join(root,'subminute-quote-activation.json');
 if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({
  artifact:rapid.ARTIFACT,activatedAt:new Date(now).toISOString(),
  ownerHash:sha(owner),brokerConnectionHash:sha(conn),
  broker:'pepperstone-ctrader',accountType:'DEMO',accountCurrency:'USD',
  maxTradeAgeSeconds:60,maxQuoteAgeSeconds:10,
  noRetrospectiveScoring:true,brokerOrders:0,
  readOnly:true,autoClose:false,autoStopAmend:false,
  autoModelPromotion:false,
 },null,2),{flag:'wx',mode:0o600});
 const r=JSON.parse(fs.readFileSync(file,'utf8'));
 if(r.artifact!==rapid.ARTIFACT||r.ownerHash!==sha(owner)||
  r.brokerConnectionHash!==sha(conn)||r.broker!=='pepperstone-ctrader'||
  r.accountType!=='DEMO'||r.accountCurrency!=='USD'||
  r.maxTradeAgeSeconds!==60||r.maxQuoteAgeSeconds!==10||
  r.noRetrospectiveScoring!==true||r.brokerOrders!==0||
  r.readOnly!==true||r.autoClose!==false||r.autoStopAmend!==false||
  r.autoModelPromotion!==false||!Number.isFinite(ms(r.activatedAt))||
  ms(r.activatedAt)>now)throw Error('INVALID_FROZEN_RAPID_ACTIVATION');
 return r;
}
function feeEvidence(row){
 const lots=ns(row.lot_size);
 if(!(lots>0))return null;
 const prefill=ns(row.sizing_inputs?.demoExecutionRiskEnvelope?.historicalFeePerLot);
 if(prefill>0)return {reserveUsd:+(prefill*lots).toFixed(4),
  feePerLot:prefill,source:'PRE_FILL_ALLOCATION_HISTORICAL_FEE',
  priorSettledSampleCount:null};
 const average=ns(row.historical_fee_per_lot),
  lo=ns(row.min_fee_per_lot),hi=ns(row.max_fee_per_lot),
  count=ns(row.fee_samples);
 // Do not assert costs from a small, mixed or volatile broker sample.
 if(!(count>=12&&count<=32&&average>0&&lo>0&&hi>=lo&&
  hi/lo<=1.05&&average>=lo&&average<=hi))return null;
 return {reserveUsd:+(average*lots).toFixed(4),
  feePerLot:average,source:'PRIOR_SETTLED_BROKER_FEES_BEFORE_OPEN',
  priorSettledSampleCount:count};
}
function feeReserve(row){return feeEvidence(row)?.reserveUsd??null;}
function enroll(row,marker,now){
 const opened=ms(row.opened_at),start=ms(marker.activatedAt),
  amount=ns(row.lot_size),fill=ns(row.fill_price),stop=ns(row.stop_loss),
  sign=row.direction==='BUY'?1:-1;
 if(row.status!=='OPEN'||!UUID.test(String(row.trade_id))||
  !model.ROUTES.includes(row.route)||!model.INSTRUMENTS.includes(row.instrument)||
  !['BUY','SELL'].includes(row.direction)||!(amount>0)||
  !(fill>0&&stop>0&&sign*(fill-stop)>0)||
  !Number.isFinite(opened)||opened<start||opened>now||now-opened>90000)
  return null;
 const frozenFee=feeEvidence(row);
 return {tradeId:row.trade_id,openedAt:new Date(opened).toISOString(),
  brokerConnectionId:row.broker_connection_id,route:row.route,
  instrument:row.instrument,direction:row.direction,filledLots:amount,
  originalStop:stop,feeReserveUsd:frozenFee?.reserveUsd??null,
  feeReserveSource:frozenFee?.source??'MISSING_VERIFIED_ASOF_COST',
  feeEvidencePriorSettlements:frozenFee?.priorSettledSampleCount??null,
  enrolledAt:new Date(now).toISOString(),snapshots:{},rapidSamples:[],settled:null};
}
function plan(row,entry,marker,now,quotes,rapidRaw=null){
 const events=[];
 let current=entry;
 if(!current){
  current=enroll(row,marker,now);
  if(!current)return {entry:null,events};
  events.push({stage:'ENROLLED',frozenEntry:{
   openedAt:current.openedAt,route:current.route,instrument:current.instrument,
   filledLots:current.filledLots,feeReserveUsd:current.feeReserveUsd,
   feeReserveSource:current.feeReserveSource,
   feeEvidencePriorSettlements:current.feeEvidencePriorSettlements}});
 }
 const rapidStart=ms(marker.rapidActivatedAt),age=now-ms(current.openedAt);
 if(row.status==='OPEN'&&Number.isFinite(rapidStart)&&
  ms(current.openedAt)>=rapidStart&&age>=5000&&age<=60000){
  const q=rapid.freshFormingNativeQuote(rapidRaw,now,current.openedAt);
  const samples=current.rapidSamples||[];
  const last=samples.length?samples[samples.length-1]:null;
  if(q&&samples.length<8&&(!last||
   ms(q.at)-ms(last.quoteSampledAt)>=8000)){
   const signal=rapid.evaluateRapid(row,q,last,current.feeReserveUsd,now);
   if(signal.status==='VALID_ASOF_SUBMINUTE_OBSERVATION'){
    current.rapidSamples=samples;
    samples.push(signal);
    events.push({stage:'PROSPECTIVE_SUBMINUTE_OPEN_NATIVE_QUOTE',
     rapidSignal:signal,noBrokerOrders:true,watchOnly:true});
   }
  }
 }
 const checkpoint=model.asOfCheckpoint(row,current.openedAt,now);
 if(checkpoint&&!current.snapshots[checkpoint]){
  const result=model.evaluate(row,quotes,now,current.feeReserveUsd);
  const cautionStart=ms(marker.earlyCautionActivatedAt);
  if(!Number.isFinite(cautionStart)||
   ms(current.openedAt)<cautionStart||now<cautionStart){
   // Original live snapshots remain immutable; reviewed earlier trades
   // cannot silently become independent successes under this NEW rule.
   result.earlyFeeCoveredProfitFadeWatchOnly=false;
   result.earlyFadeLabel='INELIGIBLE_PRE_EARLY_CAUTION_RULE_ACTIVATION';
   result.earlyFadeTheoreticalRemainingNetUsd=null;
  }
  current.snapshots[checkpoint]={at:new Date(now).toISOString(),
   checkpointMinute:checkpoint,signal:result,
   futures:Object.fromEntries(HORIZONS.map(h=>[h,{
    assessedAt:result.assessedAt||new Date(now).toISOString(),
    horizonMinutes:h,actual:null}]))};
  events.push({stage:'OPEN_REALTIME_RISK_SNAPSHOT',checkpointMinute:checkpoint,
   signal:result});
 }
 for(const [minute,snapshot] of Object.entries(current.snapshots)){
  for(const h of HORIZONS){
   const record=snapshot.futures[h];
   if(!record||record.actual)continue;
   const actual=model.labelMature(record,row,quotes,now,current.feeReserveUsd);
   if(!actual)continue;
   // Preserve original observation clock, allowing a fresh quote to arrive
   // only within the genuine 90s maturity window; never backfill afterwards.
   if(['NO_FRESH_ASOF_HORIZON_MARK','UNVERIFIED_HORIZON_MARK'].includes(actual.state))continue;
   record.actual=actual;
   events.push({stage:'FUTURE_REALITY_LABEL',fromCheckpointMinute:Number(minute),
    horizonMinutes:h,actual});
  }
 }
 if(row.status==='CLOSED'&&!current.settled){
  const gross=ns(row.realised_pnl),fee=ns(row.commission),swap=ns(row.swap);
  if([gross,fee,swap].every(x=>x!==null)&&Number.isFinite(ms(row.closed_at))){
   current.settled={closedAt:new Date(ms(row.closed_at)).toISOString(),
    netUsd:+(gross+fee+swap).toFixed(2),
    grossUsd:gross,commissionUsd:fee,swapUsd:swap,
    closeReason:row.close_reason||'UNKNOWN'};
   events.push({stage:'ACTUAL_SETTLED_BROKER_OUTCOME',outcome:current.settled});
  }
 }
 return {entry:current,events:events.map(e=>({
  artifact:model.ARTIFACT,tradeId:row.trade_id,
  capturedAt:new Date(now).toISOString(),
  ...e,noBrokerOrders:true,noTradingAuthority:true,noStopChanges:true,
 }))};
}
function summary(state,marker,now=Date.now()){
 const trades=Object.values(state.trades);
 const snapshots=trades.flatMap(t=>Object.values(t.snapshots||{}).map(x=>({t,x})));
 const warn=new Set(['TOWARD_ORIGINAL_STOP','POSITIVE_PEAK_GIVEBACK_WITH_COUNTER_MOMENTUM']);
 const warned=snapshots.filter(p=>warn.has(p.x.signal.state));
 const warnedSettled=warned.filter(p=>p.t.settled);
 // Per-checkpoint signals repeat for a position. Account economics must be
 // deduplicated by actual trade, NEVER sum one settlement per warning event.
 const warnedTradeMap=new Map(warned.map(p=>[p.t.tradeId,p.t]));
 const warnedTrades=[...warnedTradeMap.values()];
 const warnedDistinctSettled=warnedTrades.filter(t=>t.settled);
 const byCheckpoint={};
 for(const m of model.CHECKPOINTS){
  const xs=snapshots.filter(x=>x.x.checkpointMinute===m);
  if(xs.length)byCheckpoint[m]={observations:xs.length,
   warnings:xs.filter(x=>warn.has(x.x.signal.state)).length,
   missingQuote:xs.filter(x=>x.x.signal.state==='NO_FRESH_BROKER_NATIVE_QUOTE').length};
 }
 const byFutureHorizon={};
 for(const h of HORIZONS){
  const labels=snapshots.map(x=>x.x.futures[h]?.actual).filter(Boolean);
  byFutureHorizon[h]={recorded:labels.length,
   actualBrokerClosesBeforeHorizon:labels.filter(x=>x.state==='ACTUAL_POSITION_CLOSED_BEFORE_HORIZON').length,
   realTimeQuoteMarks:labels.filter(x=>x.state==='REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY').length,
   missingOrMissed:labels.filter(x=>/MISSED|UNVERIFIED|NO_FRESH/.test(x.state)).length,
   markedNetPositiveEstimated:labels.filter(x=>x.quoteOnlyAboveEstimatedCost===true).length,
   markedNetNegativeEstimated:labels.filter(x=>x.quoteOnlyAboveEstimatedCost===false).length};
 }
 return {artifact:model.ARTIFACT,generatedAt:new Date(now).toISOString(),
  activatedAt:marker.activatedAt,
  earlyCautionRuleActivatedAt:marker.earlyCautionActivatedAt||null,
  rapidQuoteRuleActivatedAt:marker.rapidActivatedAt||null,
  rapidQuoteForwardValidation:rapid.forwardSummary(trades,marker.rapidActivatedAt),
  earlyCautionEligibleOnlyOnNewPostActivationTrades:true,
  broker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
  enrolled:trades.length,settled:trades.filter(t=>t.settled).length,
  snapshots:snapshots.length,warningSnapshots:warned.length,
  warnedThenActuallySettledSnapshots:warnedSettled.length,
  warnedDistinctTrades:warnedTrades.length,
  warnedThenActuallySettled:warnedDistinctSettled.length,
  warnedThenSettledWinner:warnedDistinctSettled.filter(t=>t.settled.netUsd>0).length,
  warnedThenSettledLoser:warnedDistinctSettled.filter(t=>t.settled.netUsd<0).length,
  realizedNetUsdOnWarnedDistinctTrades:+warnedDistinctSettled.reduce((s,t)=>s+t.settled.netUsd,0).toFixed(2),
  possibleRepeatedSignalsPerTrade:true,notAnEstimatedSavingsClaim:true,
  independentEntryDays:new Set(trades.map(t=>t.openedAt.slice(0,10))).size,
  byCheckpoint,byFutureHorizon,
  forwardValidation:evaluateForwardRecovery(trades,now),
  readOnly:true,modelCalibrated:false,probabilityModelQualified:false,
  noAutomaticProfitProtectionChanges:true,noBrokerOrders:true,noTradeAuthority:true,
  noModelPromotion:true,noStopAmendments:true,
  requiredValidation:'Prospectively compare warned AND unwarned true fills after costs; count winners mistakenly signaled, quote coverage and false alerts for 5/10/15/20-minute forecasts across several independent trading days before proposing any discretionary exit change.',
  limitations:['Intraminute markets can reverse between samples. A marked gain is not an executable broker close.',
   'Signal is an explicitly uncalibrated scenario classifier, NOT probability of a future recovery.',
   'A broker exit before the forecast horizon proves actual settlement only, not whether a hypothetical earlier close was achievable.',
   'No historical mutable candle is backfilled to recreate a missing past decision.'],
 };
}
function atomic(file,json){
 const temp=file+'.'+process.pid+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(json,null,2),{flag:'wx',mode:0o600});
 fs.renameSync(temp,file);
}
async function query(db,owner,conn,activatedAt,now,existingTrades={},rapidActivatedAt=null){
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='12000ms'");
  const t=(await db.query(TRADES_SQL,[owner,conn,activatedAt])).rows;
  if(t.length>250)throw Error('TOO_MANY_TRADES_FOR_COMPLETE_SCOPED_AUDIT');
  const symbols=[...new Set(t.map(r=>r.instrument))].filter(x=>model.INSTRUMENTS.includes(x));
  const quotes=symbols.length?(await db.query(QUOTES_SQL,[conn,symbols])).rows:[];
  if(quotes.length>100)throw Error('QUOTE_SCOPE_TRUNCATED');
  // Query historical cost only for brand-new OPEN trade enrolments. The
  // prior cohort closes STRICTLY before that trade opened, never afterwards.
  const openNew=t.filter(r=>r.status==='OPEN'&&!existingTrades[r.trade_id]&&
   Number.isFinite(ms(r.opened_at))&&ms(r.opened_at)>=ms(activatedAt)&&
   now-ms(r.opened_at)>=0&&now-ms(r.opened_at)<=90000);
  if(openNew.length>12)throw Error('UNBOUNDED_NEW_POSITION_ENROLLMENT');
  for(const row of openNew){
   const proof=(await db.query(FEES_SQL,[owner,conn,row.opened_at])).rows[0];
   if(proof)Object.assign(row,proof);
  }
  const rapidCandidates=t.filter(r=>r.status==='OPEN'&&
   Number.isFinite(ms(rapidActivatedAt))&&ms(r.opened_at)>=ms(rapidActivatedAt)&&
   now-ms(r.opened_at)>=0&&now-ms(r.opened_at)<=60000);
  const rapidSymbols=[...new Set(rapidCandidates.map(x=>x.instrument))]
   .filter(x=>model.INSTRUMENTS.includes(x));
  const rapidRaw=rapidSymbols.length?(await db.query(
   RAPID_QUOTES_SQL,[conn,rapidSymbols,new Date(now).toISOString()])).rows:[];
  if(rapidRaw.length>rapidSymbols.length)throw Error('INVALID_NATIVE_RAPID_QUERY_BOUND');
  await db.query('COMMIT');
  const by={};
  for(const q of quotes){
   const parsed=model.quote(q,now);
   if(parsed)(by[q.instrument]||=[]).push(parsed);
  }
  for(const a of Object.values(by))a.sort((x,y)=>x.barStart-y.barStart);
  return {trades:t,quotes:by,rapidRawByInstrument:Object.fromEntries(
   rapidRaw.map(x=>[x.instrument,x]))};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
async function tick(db,root,owner,conn,marker,state){
 const now=Date.now(),data=await query(db,owner,conn,marker.activatedAt,now,
  state.trades,marker.rapidActivatedAt);
 let count=0;
 for(const row of data.trades){
  const id=String(row.trade_id);
  if(!UUID.test(id))continue;
  const result=plan(row,state.trades[id],marker,now,data.quotes[row.instrument]||[],
   data.rapidRawByInstrument[row.instrument]||null);
  if(!result.entry)continue;
  state.trades[id]=result.entry;
  for(const evt of result.events){
   const file=path.join(root,evt.capturedAt.slice(0,10)+'.jsonl');
   fs.appendFileSync(file,JSON.stringify(evt)+'\n',{mode:0o600});
   count++;
  }
 }
 // Do not rewrite a growing cohort state every 12 seconds when nothing has
 // changed; bounded event-driven writes protect VPS disk and SSD I/O.
 const stateFile=path.join(root,'state.json');
 if(count||!fs.existsSync(stateFile))atomic(stateFile,state);
 const report=summary(state,marker);
 atomic(path.join(root,'latest-summary.json'),report);
 return {events:count,report};
}
async function main(){
 if(!process.argv.includes('--watch'))throw Error('EXPLICIT_READONLY_WATCH_MODE_REQUIRED');
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID,
  conn=process.env.IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID;
 const {marker,state}=setup(ROOT,owner,conn);
 const frozenEarlyCaution=setupEarlyCaution(ROOT,owner,conn);
 marker.earlyCautionActivatedAt=frozenEarlyCaution.activatedAt;
 const frozenRapid=setupRapid(ROOT,owner,conn);
 marker.rapidActivatedAt=frozenRapid.activatedAt;
 const {Client}=require('pg');
 let busy=false,started=0,failures=0;
 setInterval(()=>{
  if(busy&&Date.now()-started>90000){
   console.error('RECOVERY_SHADOW_WATCHDOG_TIMEOUT_EXIT_RESEARCH_ONLY');
   process.exit(31);
  }
 },15000).unref();
 async function scan(){
  if(busy)return;
  busy=true;started=Date.now();let db;
  try{
   db=new Client({host:process.env.DB_HOST||'localhost',
    port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    connectionTimeoutMillis:7000,statement_timeout:12000,
    application_name:'irexpro-owner-recovery-risk-READONLY'});
   await db.connect();
   const result=await tick(db,ROOT,owner,conn,marker,state);
   failures=0;
   if(result.events)console.log('OWNER_RECOVERY_RESEARCH '+JSON.stringify({
    at:result.report.generatedAt,events:result.events,enrolled:result.report.enrolled,
    snapshots:result.report.snapshots,warnings:result.report.warningSnapshots,
    noBrokerOrders:true}));
  }catch(e){
   failures++;
   console.error('OWNER_RECOVERY_RESEARCH_DEFERRED',String(e?.message||e).slice(0,200));
   if(failures>=3)process.exitCode=32;
  }finally{
   await db?.end().catch(()=>{});busy=false;
   if(process.exitCode===32)process.exit(32);
  }
 }
 await scan();
 console.log('OWNER_RECOVERY_SHADOW_ACTIVE '+marker.activatedAt+' noOrders=true');
 setInterval(()=>void scan(),12000);
}
module.exports={ROOT,TRADES_SQL,QUOTES_SQL,RAPID_QUOTES_SQL,FEES_SQL,
 setup,setupEarlyCaution,setupRapid,feeEvidence,feeReserve,enroll,plan,summary,query,tick};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_RECOVERY_RESEARCH_FATAL',String(e.message).slice(0,200));
 process.exitCode=1;
});
