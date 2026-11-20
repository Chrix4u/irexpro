#!/usr/bin/env node
'use strict';
/**
 * Owner Pepperstone cTrader USD DEMO — read-only audit of what sampled native
 * bid/ask prices did AFTER broker-confirmed five-minute guard exits.
 * NO future-exit reconstruction, broker order, stop override or model training.
 */
const fs=require('node:fs'),path=require('node:path');
const {isSafeForecast}=require('./audit-owner-demo-candle-expert-trade-alignment.cjs');
const ROOT='/home/lightworld/webapps/irexpro-research';
const OUT=ROOT+'/drawdown-guard-postexit/latest-report.json';
const ARTIFACT='irexpro-owner-demo-5m-guard-postexit-v1';
const HORIZONS=[1,3,5,10,20,30];
const FROM='2026-11-17T00:00:00Z';
const ROLLING_UTC_DAYS=7;
function windowStart(now=Date.now()){
 const today=Math.floor(now/86400000)*86400000;
 return new Date(Math.max(Date.parse(FROM),today-(ROLLING_UTC_DAYS-1)*86400000)).toISOString();
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
'SELECT t.instrument,t.direction,t.opened_at,t.closed_at,t.fill_price,',
't.exit_price,t.stop_loss,t.take_profit,t.realised_pnl,t.commission,',
't.swap,t.lot_size,ti.metadata->>\'multimodel_plan_b_route\' AS route,',
'ca.created_at AS close_requested_at',
'FROM trading.trades t',
'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
' AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id',
'JOIN LATERAL (SELECT a.created_at FROM audit.audit_logs a',
" WHERE a.actor_user_id=t.user_id AND a.resource_type='Trade'",
" AND a.resource_id=t.id::text AND a.action='TRADE_CLOSE_REQUESTED'",
" AND a.metadata->>'closeReason'='AI_CLOSE_SIGNAL'",
" AND a.metadata->'aiCloseTrigger'->>'source'='DEMO_DRAWDOWN_GUARD'",
" AND a.created_at>=t.opened_at AND a.created_at<=t.closed_at+interval '2 minutes'",
' ORDER BY a.created_at ASC LIMIT 1) ca ON true',
'WHERE t.user_id=$1 AND b.user_id=$1',
" AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
" AND b.account_currency='USD' AND t.account_currency='USD'",
" AND b.deleted_at IS NULL AND t.status='CLOSED'",
" AND t.close_reason='AI_CLOSE_SIGNAL' AND t.closed_at>=$2::timestamptz",
'ORDER BY t.closed_at ASC LIMIT 501'
].join(' ');
const ms=x=>x==null?NaN:new Date(x).getTime();
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const round=(x,d=3)=>Number(x.toFixed(d));
function validQuote(v){
 if(!Array.isArray(v)||v.length!==5||typeof v[2]!=='string')return null;
 const source=ms(v[0]),captured=ms(v[1]),bid=num(v[3]),ask=num(v[4]);
 if(!Number.isFinite(source)||!Number.isFinite(captured)||captured<source||
    captured-source>15000||bid==null||ask==null||bid<=0||ask<=bid||
    !['EURUSD','AUDUSD','USDCAD','USDJPY'].includes(v[2]))return null;
 return {source,captured,instrument:v[2],bid,ask};
}
function loadQuotes(root=ROOT,fromUtc=windowStart(),now=Date.now()){
 const byPair=new Map(),stats={files:0,accepted:0,rejected:0};
 const begin=Math.floor(ms(fromUtc)/86400000)*86400000;
 const last=Math.floor(now/86400000)*86400000;
 if(!Number.isFinite(begin)||last<begin||(last-begin)/86400000>ROLLING_UTC_DAYS-1)
  throw Error('INVALID_QUOTE_AUDIT_DATE_WINDOW');
 for(let dayMs=begin;dayMs<=last;dayMs+=86400000){
  const day=new Date(dayMs).toISOString().slice(0,10);
  const filename=path.join(root,'native-quote-snapshots',day+'.jsonl');
  if(!fs.existsSync(filename))continue;
  if(fs.statSync(filename).size>25*1024*1024)throw Error('QUOTE_FILE_SIZE_EXCEEDS_LIMIT');
  stats.files++;
  for(const line of fs.readFileSync(filename,'utf8').split('\n')){
   if(!line)continue;
   let raw;try{raw=JSON.parse(line)}catch{stats.rejected++;continue}
   const q=validQuote(raw);if(!q){stats.rejected++;continue}
   (byPair.get(q.instrument)||byPair.set(q.instrument,[]).get(q.instrument)).push(q);
   stats.accepted++;
  }
 }
 for(const q of byPair.values())q.sort((a,b)=>a.source-b.source||a.captured-b.captured);
 return {byPair,stats};
}
function outcome(trade,quotes,now=Date.now()){
 const at=ms(trade.closed_at),opened=ms(trade.opened_at);
 const entry=num(trade.fill_price),exit=num(trade.exit_price),
  stop=num(trade.stop_loss),target=num(trade.take_profit),
  lot=num(trade.lot_size),gross=num(trade.realised_pnl),
  commission=num(trade.commission),swap=num(trade.swap),
  sign=trade.direction==='BUY'?1:trade.direction==='SELL'?-1:0;
 const basic=Number.isFinite(at)&&Number.isFinite(opened)&&opened<=at&&
   ['EURUSD','AUDUSD','USDCAD','USDJPY'].includes(trade.instrument)&&
   sign!==0&&[entry,exit,stop,target,lot,gross,commission,swap].every(x=>x!=null&&Number.isFinite(x))&&
   [entry,exit,stop,target,lot].every(x=>x>0)&&sign*(entry-stop)>0&&sign*(target-entry)>0;
 if(!basic)return {status:'INVALID_BROKER_TRADE'};
 const pip=trade.instrument==='USDJPY'?.01:.0001;
 const valid=(quotes||[]).filter(q=>q.instrument===trade.instrument&&
   q.source>=at&&q.captured>=at&&q.source<=at+30*60000&&q.captured<=now);
 const stages={};
 for(const h of HORIZONS){
  const end=at+h*60000;
  if(end+15000>now){stages[h+'m']={status:'NOT_MATURE'};continue}
  const rows=valid.filter(q=>q.source<=end&&q.captured<=end);
  if(rows.length<2){stages[h+'m']={status:'INSUFFICIENT_ASOF_QUOTES',samples:rows.length};continue}
  const firstGap=rows[0].source-at,lastGap=end-rows.at(-1).source;
  let maxGap=0;for(let i=1;i<rows.length;i++)maxGap=Math.max(maxGap,rows[i].source-rows[i-1].source);
  if(firstGap>30000||lastGap>30000||maxGap>60000){
   stages[h+'m']={status:'INCOMPLETE_SAMPLED_PATH',samples:rows.length,
    startGapSeconds:round(firstGap/1000),endGapSeconds:round(lastGap/1000),
    maximumGapSeconds:round(maxGap/1000)};continue;
  }
  let observedStop=false,observedTarget=false,observedEntryRecovery=false,
   firstSeenBarrier='NONE',recoveryAfterSampledStop=false;
  const moves=[];
  for(const q of rows){
   const closeSide=sign===1?q.bid:q.ask;
   const moved=sign*(closeSide-exit)/pip;
   moves.push(moved);
   const stopSeen=sign*(closeSide-stop)<=1e-8;
   const targetSeen=sign*(closeSide-target)>=-1e-8;
   if(firstSeenBarrier==='NONE'&&(stopSeen||targetSeen))
    firstSeenBarrier=stopSeen&&targetSeen?'BOTH':stopSeen?'STOP':'TARGET';
   if(stopSeen)observedStop=true;
   if(targetSeen)observedTarget=true;
   if(sign*(closeSide-entry)>=-1e-8){
    observedEntryRecovery=true;
    if(observedStop)recoveryAfterSampledStop=true;
   }
  }
  stages[h+'m']={
   status:'COMPLETE_SAMPLED_PATH',samples:rows.length,
   startGapSeconds:round(firstGap/1000),
   endGapSeconds:round(lastGap/1000),maximumGapSeconds:round(maxGap/1000),
   additionalPipsAtLastSample:round(moves.at(-1)),
   bestAdditionalPips:round(Math.max(...moves)),worstAdditionalPips:round(Math.min(...moves)),
   sampledOriginalStop:observedStop,sampledOriginalTarget:observedTarget,
   firstSeenOriginalBarrier:firstSeenBarrier,
   sampledReturnToOriginalEntry:observedEntryRecovery,
   recoveredAfterSampledStop:recoveryAfterSampledStop,
   sampleOnlyNoExecutionProof:true
  };
 }
 return {status:'BROKER_SETTLED',instrument:trade.instrument,direction:trade.direction,
  route:trade.route||'UNKNOWN',openedAt:new Date(opened).toISOString(),
  closedAt:new Date(at).toISOString(),closeRequestedAt:trade.close_requested_at,
  exitNetUsd:round(gross+commission+swap,2),lots:lot,
  originalEntryPrice:entry,brokerExitPrice:exit,originalStop:stop,originalTarget:target,
  stages};
}
function loadGuardForecasts(fromUtc=windowStart(),now=Date.now()){
 const first=Math.floor(ms(fromUtc)/86400000)*86400000;
 const last=Math.floor(now/86400000)*86400000;
 if(!Number.isFinite(first)||last<first||(last-first)/86400000>ROLLING_UTC_DAYS-1)
  throw Error('INVALID_EXPERT_AUDIT_DATE_WINDOW');
 const byPair=new Map();
 for(let d=first;d<=last;d+=86400000){
  const name=new Date(d).toISOString().slice(0,10)+'.jsonl';
  const filename=path.join(ROOT,'forming-candle-predictions',name);
  if(!fs.existsSync(filename))continue;
  if(fs.statSync(filename).size>20*1024*1024)throw Error('EXPERT_FORECAST_FILE_SIZE_EXCEEDS_LIMIT');
  for(const line of fs.readFileSync(filename,'utf8').split('\n')){
   if(!line)continue;
   let p;try{p=JSON.parse(line)}catch{continue}
   if(!isSafeForecast(p))continue;
   const at=ms(p.forecastWrittenAt);
   if(at<ms(fromUtc)||at>now)continue;
   (byPair.get(p.instrument)||byPair.set(p.instrument,[]).get(p.instrument)).push(p);
  }
 }
 for(const a of byPair.values())a.sort((x,y)=>ms(x.forecastWrittenAt)-ms(y.forecastWrittenAt));
 return byPair;
}
function alignPreExitExpert(trade,byPair){
 const cutoff=ms(trade.close_requested_at);
 if(!Number.isFinite(cutoff))return {status:'CLOSE_REQUEST_TIME_UNVERIFIED'};
 let chosen=null;
 for(const p of (byPair?.get(trade.instrument)||[])){
  const written=ms(p.forecastWrittenAt);
  if(written>cutoff)break;
  if(cutoff-written<=90000&&isSafeForecast(p))chosen=p;
 }
 if(!chosen)return {status:'NO_VERIFIED_PRE_EXIT_FORECAST'};
 return {status:'VERIFIED_PRE_EXIT_FORECAST',class:chosen.predictedNextCandleClass,
  confidence:round(chosen.confidence,5),ageSeconds:round((cutoff-ms(chosen.forecastWrittenAt))/1000),
  modelTrainedAt:chosen.modelTrainedAt,
  directionalAgreement:chosen.predictedNextCandleClass==='COST_SMALL_OR_FLAT'?'FLAT':
   (chosen.predictedNextCandleClass==='GREEN_OR_UP')===(trade.direction==='BUY')?'AGREE':'OPPOSE',
  researchOnly:true,noExitAuthority:true};
}
function summarize(details,quotesStats,fromUtc=windowStart()){
 const b={observed:details.length,validBrokerSettlements:0,invalid:0,
  realizedGuardExitNetUsd:0,byRoute:{},byInstrument:{},horizons:{}};
 for(const t of details){
  if(t.status!=='BROKER_SETTLED'){b.invalid++;continue}
  b.validBrokerSettlements++;b.realizedGuardExitNetUsd+=t.exitNetUsd;
  for(const [dict,key] of [[b.byRoute,t.route],[b.byInstrument,t.instrument]]){
   const s=dict[key]??={guardExits:0,realizedNetUsd:0,afterCostWinners:0,afterCostLosers:0};
   s.guardExits++;s.realizedNetUsd+=t.exitNetUsd;
   s.afterCostWinners+=t.exitNetUsd>0;s.afterCostLosers+=t.exitNetUsd<0;
  }
 }
 for(const h of HORIZONS){
  const records=details.filter(t=>t.status==='BROKER_SETTLED').map(t=>({t,p:t.stages[h+'m']}));
  const clean=records.filter(x=>x.p.status==='COMPLETE_SAMPLED_PATH');
  const group=()=>{
   const obj={maturedTradeExits:records.filter(x=>x.p.status!=='NOT_MATURE').length,
    completeQuotePaths:clean.length,notMature:records.filter(x=>x.p.status==='NOT_MATURE').length,
    missingOrPartialQuotePaths:records.filter(x=>!['COMPLETE_SAMPLED_PATH','NOT_MATURE'].includes(x.p.status)).length,
    lastQuoteBetterThanActualExit:0,lastQuoteWorseThanActualExit:0,lastQuoteFlat:0,
    sampledOriginalStop:0,sampledOriginalTarget:0,
    firstSeenStop:0,firstSeenTarget:0,sampledReturnToEntry:0,
    recoveryWithoutSampledStop:0,recoveryAfterSampledStop:0,
    meanAdditionalPipsAtLastQuote:null,actualBrokerExitNetUsdForCovered:0,
    byRoute:{},byInstrument:{},counterfactualTradingNetUsd:null};
   return obj;
  };
  const g=group(),pipSum=[];
  for(const {t,p} of clean){
   g.lastQuoteBetterThanActualExit+=p.additionalPipsAtLastSample>0;
   g.lastQuoteWorseThanActualExit+=p.additionalPipsAtLastSample<0;
   g.lastQuoteFlat+=p.additionalPipsAtLastSample===0;
   g.sampledOriginalStop+=p.sampledOriginalStop;
   g.sampledOriginalTarget+=p.sampledOriginalTarget;
   g.firstSeenStop+=p.firstSeenOriginalBarrier==='STOP';
   g.firstSeenTarget+=p.firstSeenOriginalBarrier==='TARGET';
   g.sampledReturnToEntry+=p.sampledReturnToOriginalEntry;
   g.recoveryWithoutSampledStop+=p.sampledReturnToOriginalEntry&&!p.sampledOriginalStop;
   g.recoveryAfterSampledStop+=p.recoveredAfterSampledStop;
   g.actualBrokerExitNetUsdForCovered+=t.exitNetUsd;
   pipSum.push(p.additionalPipsAtLastSample);
   for(const [dict,key] of [[g.byRoute,t.route],[g.byInstrument,t.instrument]]){
    const s=dict[key]??={completePaths:0,betterAtLastQuote:0,worseAtLastQuote:0,
     sawStop:0,sawTarget:0,recoveredEntryWithoutObservedStop:0};
    s.completePaths++;s.betterAtLastQuote+=p.additionalPipsAtLastSample>0;
    s.worseAtLastQuote+=p.additionalPipsAtLastSample<0;
    s.sawStop+=p.sampledOriginalStop;s.sawTarget+=p.sampledOriginalTarget;
    s.recoveredEntryWithoutObservedStop+=p.sampledReturnToOriginalEntry&&!p.sampledOriginalStop;
   }
  }
  g.actualBrokerExitNetUsdForCovered=round(g.actualBrokerExitNetUsdForCovered,2);
  g.meanAdditionalPipsAtLastQuote=clean.length?round(pipSum.reduce((a,c)=>a+c,0)/clean.length):null;
  b.horizons[h+'m']=g;
 }
 b.realizedGuardExitNetUsd=round(b.realizedGuardExitNetUsd,2);
 for(const dict of [b.byRoute,b.byInstrument])for(const x of Object.values(dict))x.realizedNetUsd=round(x.realizedNetUsd,2);
 const expert={verifiedBeforeGuardRequest:0,unmatched:0,highConfidenceDirectional:0,
  byPriorClassAndLater10mPath:{}};
 for(const t of details){
  if(t.status!=='BROKER_SETTLED')continue;
  const p=t.preExitCandlestickExpert;
  if(p?.status!=='VERIFIED_PRE_EXIT_FORECAST'){expert.unmatched++;continue}
  expert.verifiedBeforeGuardRequest++;
  expert.highConfidenceDirectional+=p.confidence>=.65&&p.class!=='COST_SMALL_OR_FLAT';
  const h=t.stages['10m'];
  const state=h.status!=='COMPLETE_SAMPLED_PATH'?'INCOMPLETE_PATH':
   h.sampledOriginalStop?'SAMPLED_ORIGINAL_STOP':
   h.sampledReturnToOriginalEntry?'ENTRY_RETURN_NO_SAMPLED_STOP':'NO_STOP_NO_ENTRY_RETURN';
  const key=p.class+'|'+p.directionalAgreement+'|'+state;
  expert.byPriorClassAndLater10mPath[key]=(expert.byPriorClassAndLater10mPath[key]||0)+1;
 }
 return {artifact:ARTIFACT,asOf:new Date().toISOString(),researchOnly:true,
  modifiesExecution:false,brokerOrders:false,noSqlWrites:true,
  scope:{broker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
   fromInclusiveUtc:fromUtc,rollingUtcDays:ROLLING_UTC_DAYS,
   verifiedCloseRequestSource:'DEMO_DRAWDOWN_GUARD',
   quoteSource:'prospective native bid/ask sampled quote archive',verifiedQuoteStats:quotesStats},
  aggregate:b,preExitCandlestickExpertAlignment:expert,details,
  limitations:[
   'Sampled bid/ask quotes are not full tick history. An unobserved original stop/target could have triggered before a later apparent recovery.',
   'A closing quote after the actual exit is NOT a broker-executable hypothetical delayed fill or proven P&L.',
   'A guard exit versus holding requires replay of broker path, transaction costs, SL/TP precedence, position-sizing and next opportunity costs; this audit does not estimate a counterfactual net USD.',
   'Samples are required to have source and archive timestamps in order, within 15 seconds, and be contiguous enough within every horizon; incomplete/missing paths are censored, not classified as winners.',
   'Observations are correlated across pairs and times; selection includes only trades the guard actually closed.',
   'Nothing in this report authorizes altering the drawdown threshold, live trading, stops or exit logic.'
  ]};
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg'),owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('DEMO_OWNER_SCOPE_MISSING');
 const fromUtc=windowStart();
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  statement_timeout:16000,application_name:'irexpro-drawdown-guard-postexit-READONLY'});
 let rows;
 await db.connect();
 try{await db.query('BEGIN READ ONLY');rows=(await db.query(SQL,[owner,fromUtc])).rows;await db.query('ROLLBACK')}
 catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{await db.end()}
 if(rows.length>500)throw Error('BROKER_ROWS_EXCEED_AUDIT_LIMIT');
 const quoteFiles=loadQuotes(ROOT,fromUtc);
 const experts=loadGuardForecasts(fromUtc);
 const details=rows.map(r=>{
  const result=outcome(r,quoteFiles.byPair.get(r.instrument));
  if(result.status==='BROKER_SETTLED')result.preExitCandlestickExpert=alignPreExitExpert(r,experts);
  return result;
 });
 const report=summarize(details,quoteFiles.stats,fromUtc);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 const contents=JSON.stringify(report,null,2);
 fs.writeFileSync(OUT,contents,{mode:0o600});
 const archive=path.join(path.dirname(OUT),'daily',report.asOf.slice(0,10)+'.json');
 fs.mkdirSync(path.dirname(archive),{recursive:true,mode:0o700});
 fs.writeFileSync(archive,contents,{mode:0o600});
 console.log('GUARD_POSTEXIT_SHADOW '+JSON.stringify({asOf:report.asOf,
  fromUtc,closed:report.aggregate.validBrokerSettlements,
  actualNetUsd:report.aggregate.realizedGuardExitNetUsd,
  quote30m:report.aggregate.horizons['30m'].completeQuotePaths,
  sampledStop30m:report.aggregate.horizons['30m'].sampledOriginalStop,
  preExitCandleMatches:report.preExitCandlestickExpertAlignment.verifiedBeforeGuardRequest,
  researchOnly:true,brokerOrders:false}));
 return report;
}
async function watch(){
 let busy=false;
 const run=async()=>{
  if(busy)return;busy=true;
  try{await main()}catch(e){console.error('GUARD_SHADOW_REFRESH_FAILED',String(e.message).slice(0,200))}
  finally{busy=false}
 };
 await run();
 setInterval(()=>void run(),30*60*1000);
}
module.exports={ARTIFACT,SQL,HORIZONS,windowStart,validQuote,outcome,summarize,loadQuotes,
 loadGuardForecasts,alignPreExitExpert};
if(require.main===module){
 const task=process.argv.includes('--watch')?watch():main();
 task.catch(e=>{console.error('READ_ONLY_GUARD_AUDIT_FAILED',String(e.message).slice(0,180));process.exitCode=1});
}
