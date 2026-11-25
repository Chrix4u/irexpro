#!/usr/bin/env node
'use strict';
/**
 * Research only. Outcomes are observations of a POLLED BID/ASK archive, not
 * broker fills, exhaustive ticks, causal market forecasts or instructions
 * to amend broker orders. Stops/TP never change in the actual trading path.
 */
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {
 simulateHybrid,corroborateWickOrder,
}=require('./pepperstone-profit-lock-hybrid-trailing-shadow.cjs');
const ARTIFACT='irexpro-pepperstone-demo-tp-first-milestone-trailing-shadow-v1';
const INPUT='/home/lightworld/webapps/irexpro-research/native-quote-snapshots';
const OUTPUT='/home/lightworld/webapps/irexpro-research/profit-lock-tp-trailing/latest-report.json';
const MINUTE=60000;
const HORIZONS=[15,30,60,120,240];
const ROUTES=['EARLY_TRANSITION','CONFIRMED_REVERSAL'];
const PAIRS=['EURUSD','AUDUSD','USDJPY','USDCAD'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
  'SELECT t.id::text trade_key,t.instrument,t.direction,t.opened_at,t.closed_at,',
  't.fill_price,t.exit_price,t.stop_loss,t.take_profit,t.lot_size,',
  't.realised_pnl,t.commission,t.swap,t.max_favorable_pnl,',
  'ti.metadata->>\'multimodel_plan_b_route\' strategy_route',
  'FROM trading.trades t',
  'JOIN broker.broker_connections b ON b.id=t.broker_connection_id',
  'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
  'WHERE t.user_id=$1 AND b.user_id=$1 AND b.deleted_at IS NULL',
  'AND b.broker_id=\'pepperstone-ctrader\' AND b.account_type=\'DEMO\'',
  'AND t.account_currency=\'USD\' AND t.status=\'CLOSED\'',
  'AND t.close_reason=\'PROFIT_PROTECTION\'',
  'AND ti.metadata->>\'multimodel_plan_b_route\' IN (\'EARLY_TRANSITION\',\'CONFIRMED_REVERSAL\')',
  'AND t.closed_at >= $2::timestamptz AND t.closed_at <= $3::timestamptz',
  'ORDER BY t.closed_at ASC LIMIT 250',
].join(' ');
const NATIVE_SQL=[
 "SELECT q.instrument,q.bucket_time,q.high,q.low,q.sample_count,",
 "q.positive_quote_sample_count,q.last_positive_sample_at,q.source",
 "FROM market_data.provider_quote_candles q",
 "JOIN broker.broker_connections b ON b.id=q.connection_id",
 "WHERE b.user_id=$1 AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.deleted_at IS NULL",
 "AND q.timeframe='M1' AND q.source='ctrader-broker-native'",
 "AND q.instrument IN ('EURUSD','AUDUSD','USDJPY','USDCAD')",
 "AND q.bucket_time >= $2::timestamptz AND q.bucket_time <= $3::timestamptz",
 "ORDER BY q.instrument,q.bucket_time LIMIT 30001",
].join(' ');
const TRAILING_POLICIES=['USER_50_65_60_70_80_75','PATIENT_70_55_85_65','ONLY_NEAR_TP_80_60'];
const n=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const round=(x,d=2)=>Number(x.toFixed(d));
const sign=d=>d==='BUY'?1:d==='SELL'?-1:0;
function validateTrade(t){
 const direction=sign(t?.direction),opened=ms(t?.opened_at),closed=ms(t?.closed_at);
 const entry=n(t?.fill_price),exit=n(t?.exit_price),
  stop=n(t?.stop_loss),tp=n(t?.take_profit),lots=n(t?.lot_size),
  gross=n(t?.realised_pnl),fee=n(t?.commission),swap=n(t?.swap);
 if(!PAIRS.includes(t?.instrument)||!ROUTES.includes(t?.strategy_route)||
  !direction||!Number.isFinite(opened)||!Number.isFinite(closed)||
  opened>=closed||[entry,exit,stop,tp,lots,gross,fee,swap].some(v=>v===null)||
  [entry,exit,stop,tp,lots].some(v=>v<=0)||fee>0||
  direction*(entry-stop)<=0||direction*(tp-entry)<=0)
  return null;
 return {tradeKey:String(t.trade_key||''),route:t.strategy_route,
  instrument:t.instrument,direction:t.direction,sgn:direction,opened,closed,
  entry,exit,stop,tp,lots,actualGross:gross,commission:fee,swap,
  actualNet:round(gross+fee+swap),recordedPeak:n(t.max_favorable_pnl)};
}
function record(x){
 if(!Array.isArray(x)||x.length!==5)return null;
 const [timestamp,observedAt,instrument,bid,ask]=x;
 const at=ms(timestamp),seen=ms(observedAt);
 if(!PAIRS.includes(instrument)||!Number.isFinite(at)||!Number.isFinite(seen)||
  seen<at||seen-at>10000||n(bid)===null||n(ask)===null||
  !(bid>0&&ask>bid))return null;
 return {at,instrument,bid:Number(bid),ask:Number(ask)};
}
function lowerBound(a,ts){
 let left=0,right=a.length;
 while(left<right){const mid=(left+right)>>>1;
  if(a[mid].at<ts)left=mid+1;else right=mid}
 return left;
}
async function loadQuotes(days,root=INPUT){
 const q=Object.fromEntries(PAIRS.map(x=>[x,[]]));
 const info={read:0,accepted:0,missingDates:[]};
 for(const day of days){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('INVALID_SOURCE_DAY');
  const file=path.join(root,day+'.jsonl');
  if(!fs.existsSync(file)){info.missingDates.push(day);continue;}
  const st=fs.statSync(file);
  if(!st.isFile()||st.size>90000000)throw Error('UNTRUSTED_SOURCE_SIZE');
  const stream=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
  for await(const line of stream){
   if(line.length>280)continue;
   info.read++;
   let item;try{item=JSON.parse(line)}catch{continue;}
   const r=record(item);if(!r)continue;
   q[r.instrument].push(r);info.accepted++;
  }
 }
 for(const pair of PAIRS){
  q[pair].sort((a,b)=>a.at-b.at);
  const deduped=[];
  for(const r of q[pair]){
   if(deduped.length&&deduped[deduped.length-1].at===r.at)continue;
   deduped.push(r);
  }
  q[pair]=deduped;
 }
 return {quotes:q,info};
}
function dollarGross(t,price){
 const base=t.sgn*(price-t.entry)*100000*t.lots;
 return base/(t.instrument.startsWith('USD')?price:1);
}
function netProxy(t,price,extraSlippagePips=0){
 const pip=t.instrument.endsWith('JPY')?.01:.0001;
 const slippage=extraSlippagePips*100000*pip*t.lots/
  (t.instrument.startsWith('USD')?price:1);
 return round(dollarGross(t,price)+t.commission+t.swap-slippage);
}
function firstObservedFromClose(t,quotes,now,horizonMinutes){
 const limit=t.closed+horizonMinutes*MINUTE;
 if(now<limit+10000)return {status:'NOT_MATURED'};
 const i=lowerBound(quotes,t.closed+1);
 let previous=t.closed,count=0,maxGap=0,firstGap=null;
 let first=null,everGap20=false;
 for(let j=i;j<quotes.length;j++){
  const q=quotes[j];if(q.at>limit)break;
  const gap=(q.at-previous)/1000;
  if(firstGap===null)firstGap=gap;
  maxGap=Math.max(maxGap,gap);
  if(gap>20)everGap20=true;
  previous=q.at;count++;
  const mark=t.direction==='BUY'?q.bid:q.ask;
  const target=t.sgn*(mark-t.tp)>=-1e-10;
  const stop=t.sgn*(mark-t.stop)<=1e-10;
  if(target||stop){first={status:target?'TP_FIRST_OBSERVED':'STOP_FIRST_OBSERVED',
   eventAt:new Date(q.at).toISOString(),mark,
   elapsedMinutes:round((q.at-t.closed)/MINUTE,2),sampledCountBeforeEvent:count,
   maxGapBeforeEventSeconds:round(maxGap,3),
   firstSampleLagSeconds:round(firstGap,3),
   frequentSamplesUntilEvent:maxGap<=12,
   limitedSamplingUntilEvent:maxGap<=20,
   sampledPriceNotBrokerFill:true};break;}
 }
 if(first)return first;
 const tailGap=(limit-previous)/1000;
 maxGap=Math.max(maxGap,tailGap);
 return {status:count?'NO_OBSERVED_BARRIER':'NO_SNAPSHOTS',
  sampledCount:count,maxGapInHorizonSeconds:round(maxGap,3),
  nearComplete:maxGap<=12,hadGapOver20Seconds:everGap20||tailGap>20,
  noBarrierTouchCanBeCertified:false};
}
function fractionAtProgress(progress){
 if(progress>=0.8)return 0.75;
 if(progress>=0.6)return 0.70;
 if(progress>=0.5)return 0.65;
 return null;
}
function simulateMilestoneTrailing(t,quotes,now,horizonMinutes=120){
 const end=t.closed+horizonMinutes*MINUTE;
 if(now<end+10000)return {status:'NOT_MATURED'};
 const startIndex=lowerBound(quotes,t.opened+1),side=t.sgn;
 let previous=t.opened,peak=0,activeStop=t.stop,maxGap=0,nobs=0;
 let firstQuoteLag=null,milestones={fifty:null,sixty:null,eighty:null};
 let firstTrailUpdate=null,beforeActualExit=false;
 for(let j=startIndex;j<quotes.length;j++){
  const q=quotes[j];if(q.at>end)break;
  const mark=t.direction==='BUY'?q.bid:q.ask;
  const gap=(q.at-previous)/1000;
  maxGap=Math.max(maxGap,gap);
  if(firstQuoteLag===null)firstQuoteLag=gap;
  previous=q.at;nobs++;
  const stopTouch=side*(mark-activeStop)<=0;
  const targetTouch=side*(mark-t.tp)>=0;
  if(stopTouch||targetTouch){
   const trailStopActive=side*(activeStop-t.stop)>1e-10;
   const event=targetTouch?'TP_OBSERVED':trailStopActive?
     'TRAIL_STOP_OBSERVED':'ORIGINAL_SL_OBSERVED';
   const stopPrice=activeStop;
   const compareMark=mark;
   return {
    status:'OBSERVED_EXIT',event,eventAt:new Date(q.at).toISOString(),
    eventBeforeActualClose:q.at<t.closed,observations:nobs,
    firstQuoteLagSeconds:round(firstQuoteLag,2),
    maxGapBeforeEventSeconds:round(maxGap,2),
    sampledPathFrequent:maxGap<=12,
    highestProgressFraction:round(peak/(side*(t.tp-t.entry)),4),
    triggeredMilestones:milestones,firstTrailUpdate,
    activeStopAtEvent:round(stopPrice,6),
    indicativeNetAtObservedExitMark:netProxy(t,compareMark),
    indicativeNetAtStopLimit:stopTouch?netProxy(t,stopPrice):null,
    indicativeNetAfterHalfPipExtraSlip:netProxy(t,compareMark,0.5),
    actualNet:t.actualNet,
    indicativeDifferenceVsActualNet:round(netProxy(t,compareMark)-t.actualNet),
    syntheticQuoteNotBrokerFill:true,
   };
  }
  const favorable=Math.max(0,side*(mark-t.entry));
  peak=Math.max(peak,favorable);
  const progress=peak/(side*(t.tp-t.entry));
  for(const [key,threshold] of [['fifty',.5],['sixty',.6],['eighty',.8]]){
   if(progress>=threshold&&milestones[key]===null){
    milestones[key]=new Date(q.at).toISOString();
   }
  }
  const f=fractionAtProgress(progress);
  if(f!==null){
   const proposed=t.entry+side*peak*f;
   if(side*(proposed-activeStop)>0){
    activeStop=proposed;
    if(!firstTrailUpdate)firstTrailUpdate=new Date(q.at).toISOString();
   }
  }
 }
 const tail=(end-previous)/1000;
 maxGap=Math.max(maxGap,tail);
 return {status:nobs?'NO_SAMPLED_EXIT_BY_HORIZON':'NO_SNAPSHOTS',
  highestProgressFraction:round(peak/(side*(t.tp-t.entry)),4),
  triggeredMilestones:milestones,firstTrailUpdate,
  observations:nobs,maxGapToHorizonSeconds:round(maxGap,2),
  sampledPathFrequent:maxGap<=12,syntheticQuoteNotBrokerFill:true};
}
function summarize(results){
 const summary={trades:results.length,
  bookedNet:round(results.reduce((s,r)=>s+r.actualNet,0)),
  byRoute:{},byDay:{},horizons:{},trailing:{}};
 for(const dim of ['route','day']){
  const groups={};
  for(const r of results){
   const k=r[dim]||'OTHER';(groups[k]??=[]).push(r);
  }
  summary[dim==='route'?'byRoute':'byDay']=
   Object.fromEntries(Object.entries(groups).map(([k,rows])=>[k,{
    trades:rows.length,bookedNet:round(rows.reduce((s,r)=>s+r.actualNet,0)),
    bookedAverage:round(rows.reduce((s,r)=>s+r.actualNet,0)/rows.length),
    bookedBest:round(Math.max(...rows.map(r=>r.actualNet))),
    bookedWorst:round(Math.min(...rows.map(r=>r.actualNet))),
   }]));
 }
 for(const h of HORIZONS){
  const data=results.map(r=>r.firstByHorizon[h+'m']);
  const counts={};
  for(const p of data)counts[p.status]=(counts[p.status]||0)+1;
  const tp=data.filter(x=>x.status==='TP_FIRST_OBSERVED');
  const sl=data.filter(x=>x.status==='STOP_FIRST_OBSERVED');
  summary.horizons[h+'m']={
   ...counts,
   firstObservedTP:tp.length,firstObservedSL:sl.length,
   tpWithFrequentQuotes:tp.filter(x=>x.frequentSamplesUntilEvent).length,
   tpWithGapAtMost20s:tp.filter(x=>x.limitedSamplingUntilEvent).length,
   slWithFrequentQuotes:sl.filter(x=>x.frequentSamplesUntilEvent).length,
   noBarrierNearComplete:data.filter(x=>x.status==='NO_OBSERVED_BARRIER'&&x.nearComplete).length,
   tpWithoutOpposingM1WickInFullBars:tp.filter(x=>
    x.nativeWickReview?.status==='NO_OPPOSITE_MIDPOINT_WICK_IN_COMPLETE_M1_BARS').length,
   tpWithPotentialPriorM1StopWick:tp.filter(x=>
    x.nativeWickReview?.previousMinuteWickConflict).length,
   tpWithPossibleSameMinuteM1StopWick:tp.filter(x=>
    x.nativeWickReview?.sameMinuteWickConflict).length,
   tpWithMissingNativeM1Evidence:tp.filter(x=>
    x.nativeWickReview?.missingFullM1Bars>0).length,
   allFirstTouchAreObservedNotCertified:true,
  };
 }
 const trails=results.map(r=>r.trailing);
 const counts={};
 for(const r of trails){counts[r.status==='OBSERVED_EXIT'?r.event:r.status]=(counts[r.status==='OBSERVED_EXIT'?r.event:r.status]||0)+1}
 const realized=trails.filter(r=>r.status==='OBSERVED_EXIT');
 const adequate=realized.filter(r=>r.sampledPathFrequent);
 summary.trailing={
  ...counts,exitBeforeActualClose:realized.filter(r=>r.eventBeforeActualClose).length,
  milestone50Seen:trails.filter(r=>r.triggeredMilestones?.fifty).length,
  milestone60Seen:trails.filter(r=>r.triggeredMilestones?.sixty).length,
  milestone80Seen:trails.filter(r=>r.triggeredMilestones?.eighty).length,
  completeFrequentSampledPaths:adequate.length,
  indicativeVsActualOnFrequentQuotes:adequate.length?{
   trades:adequate.length,
   scenariosBetter:adequate.filter(r=>r.indicativeDifferenceVsActualNet>0.01).length,
   scenariosWorse:adequate.filter(r=>r.indicativeDifferenceVsActualNet<-.01).length,
   totalProxyDifferenceUsd:round(adequate.reduce((s,r)=>s+r.indicativeDifferenceVsActualNet,0)),
   sumPriceMarkProxies:round(adequate.reduce((s,r)=>s+r.indicativeNetAtObservedExitMark,0)),
   sumActuallyBookedNet:round(adequate.reduce((s,r)=>s+r.actualNet,0)),
  }:null,
  allCounterfactualMarksNotBrokerFills:true,
 };
 summary.hybridByPolicy={};
 for(const policy of TRAILING_POLICIES){
  const outputs=results.map(r=>r.hybridByPolicy[policy]);
  const statuses={};
  for(const item of outputs){
   const status=item.event||item.status;
   statuses[status]=(statuses[status]||0)+1;
  }
  const candidates=outputs.filter(x=>x.proposal?.status==='SIMULATED_STOP_CANDIDATE');
  const filled=outputs.filter(x=>x.status==='SHADOW_FIRST_OBSERVED_EXIT');
  const frequent=filled.filter(x=>x.hasFrequentQuotePath);
  const compared=frequent.map(x=>x.indicativeIncrementVsActual);
  summary.hybridByPolicy[policy]={
   ...statuses,
   asOfCloseCandidates:candidates.length,
   noCandidateKeepsRealBookedExit:outputs.filter(x=>x.status==='ACTUAL_PROFIT_CLOSE_RETAINED').length,
   suggestedStopAfterHalfPipPositive:candidates.filter(x=>x.proposal.netAtStopAfterHalfPipExtraSlippage>0).length,
   firstObservedResolved:filled.length,
   frequentPostCloseQuotePathCount:frequent.length,
   betterThanActualOnSelectedFrequentProxy:compared.filter(x=>x>0.01).length,
   worseThanActualOnSelectedFrequentProxy:compared.filter(x=>x<-.01).length,
   aggregateProxyDifferenceOnSelectedFrequentUsd:compared.length?round(compared.reduce((a,b)=>a+b,0)):null,
   excludedUnresolvedOrSparse:results.length-frequent.length,
   originalBrokerStopNotModified:true,
  };
 }
 return summary;
}
async function audit(client,ownerId,now=new Date(),start='2026-11-17T00:00:00Z'){
 if(!UUID.test(ownerId||''))throw Error('INVALID_OWNER_ID');
 await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 let rows,nativeBars=[];
 try{
  await client.query("SET LOCAL statement_timeout='25000ms'");
  rows=(await client.query(SQL,[ownerId,start,now.toISOString()])).rows;
  if(rows.length){
   const first=new Date(Math.min(...rows.map(x=>ms(x.closed_at)))-MINUTE).toISOString();
   const last=new Date(Math.max(...rows.map(x=>ms(x.closed_at)))+240*MINUTE).toISOString();
   nativeBars=(await client.query(NATIVE_SQL,[ownerId,first,last])).rows;
   if(nativeBars.length>30000)throw Error('NATIVE_M1_RESEARCH_ROW_LIMIT');
  }
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
 if(rows.length>=250)throw Error('OWNER_TRADE_LIMIT');
 const checked=rows.map(validateTrade);
 if(checked.some(r=>!r))throw Error('INVALID_BROKER_TRADE_GEOMETRY');
 const trades=checked;
 const days=new Set();
 for(const trade of trades){
  for(let at=Math.floor(trade.opened/86400000)*86400000;
   at<=trade.closed+240*MINUTE;at+=86400000){
   days.add(new Date(at).toISOString().slice(0,10));
  }
 }
 const {quotes,info}=await loadQuotes([...days].sort());
 info.nativeM1BrokerCandles=nativeBars.length;
 const byInstrument=Object.fromEntries(PAIRS.map(pair=>[pair,nativeBars.filter(b=>b.instrument===pair)]));
 const output=trades.map(t=>{
  const observations=quotes[t.instrument];
  const firstByHorizon=Object.fromEntries(HORIZONS.map(h=>{
   const first=firstObservedFromClose(t,observations,now.getTime(),h);
   if(first.status==='TP_FIRST_OBSERVED'||first.status==='STOP_FIRST_OBSERVED'){
    first.nativeWickReview=corroborateWickOrder(t,first,byInstrument[t.instrument]);
   }
   return [h+'m',first];
  }));
  const hybridByPolicy=Object.fromEntries(TRAILING_POLICIES.map(policy=>[
   policy,simulateHybrid(t,observations,now.getTime(),120,policy)
  ]));
  return {
   instrument:t.instrument,direction:t.direction,route:t.route,
   openedAt:new Date(t.opened).toISOString(),closedAt:new Date(t.closed).toISOString(),
   day:new Date(t.closed).toISOString().slice(0,10),lots:t.lots,
   fillPrice:t.entry,actualExitPrice:t.exit,originalStop:t.stop,originalTakeProfit:t.tp,
   actualNet:t.actualNet,recordedPeak:t.recordedPeak,
   hypotheticalTpNetIfFillAtOriginalTP:netProxy(t,t.tp),
   hypotheticalTpExtraVsBookedNet:round(netProxy(t,t.tp)-t.actualNet),
   firstByHorizon,
   trailing:simulateMilestoneTrailing(t,observations,now.getTime()),
   hybridByPolicy,
  };
 });
 return {artifact:ARTIFACT,generatedAt:now.toISOString(),
  scope:'OWNER_PEPPERSTONE_CTRADER_USD_DEMO_TWO_EXECUTING_ROUTES',
  researchOnly:true,noTradeAuthority:true,
  modifiesExecution:false,brokerStopAmendments:0,
  data:info,summary:summarize(output),details:output,
  assumptions:[
   'All after-close barriers are FIRST OBSERVED sampled bid/ask values, not exhaustive tick ordering or certified broker stop/TP fills.',
   'Quote samples are captured from an independently time-stamped 2-second poll. Every unsampled interval could hide a barrier; even 12-second maximum gaps are not proof of ordering.',
   'Hypothetical TP net assumes the original TP price fills and original settled commission/swap; actual spread, slippage, commission, swap, margin or conversion can differ.',
   'Milestone trailing is a CAUSAL REPLAY over observed quotes, never a real broker trailing order. 50% TP progress locks 65% of peak favorable move; 60% locks 70%; 80% locks 75%. Stop only ratchets, checked against next observed quote.',
   'Trailing stop price amendment must be validated for cTrader broker tick, min stop distance, accepted amendments, latency and reconciliation before EXECUTION is considered.',
   'Indicative net at observed exit mark uses simple USD contract conversion and actual settled commission/swap with optional extra 0.5-pip slip; it is NOT a verified broker fill or a tradable backtest.',
   'The hybrid scenario leaves an actual protected close unchanged unless a positive, fresh, price-headroom-validated stop was already possible at the historical exit. A shadow proposal never means the broker accepted any amendment.',
   'A native M1 wick may contradict the order of first quote-observed TP/SL; midpoint OHLC does not establish broker-executable side-specific extrema.',
   'No lot size, entry gates, risk, automated profit close, original broker SL/TP or LIVE trading configuration was changed.',
  ]};
}
async function main(){
 require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||
  path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const {getDatabaseSslOptions}=require('../dist/config/database-tls');
 const c=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-tp-first-trailing-audit-readonly'});
 try{
  await c.connect();const result=await audit(c,process.env.VPS_FOREX_SCANNER_USER_ID,new Date());
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
  const tmp=OUTPUT+'.'+process.pid+'.tmp';
  const fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(result,null,2));}
  finally{fs.closeSync(fd)}
  fs.renameSync(tmp,OUTPUT);
  console.log('PROTECTED_PROFIT_TP_TRAILING_RESEARCH',
   JSON.stringify({date:result.generatedAt,summary:result.summary,data:result.data}));
 }finally{await c.end()}
}
module.exports={ARTIFACT,HORIZONS,validateTrade,record,lowerBound,
 dollarGross,netProxy,firstObservedFromClose,fractionAtProgress,
 simulateMilestoneTrailing,summarize,audit,loadQuotes,SQL};
if(require.main===module)main().catch(e=>{
 console.error('PROFIT_TP_TRAILING_AUDIT_FAILED',e.message);
 process.exitCode=1;
});