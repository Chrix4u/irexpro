#!/usr/bin/env node
'use strict';
/**
 * iRexPro USD common-factor research — owner Pepperstone USD DEMO, broker native
 * quote candles, read-only. A pair is ALWAYS omitted from its own USD signal.
 *
 * USD as BASE (USDJPY, USDCAD, USDCHF): positive log-return = USD strength.
 * USD as QUOTE (EURUSD, GBPUSD, AUDUSD): negative log-return = USD strength.
 *
 * Causal at completed candle t; compare to next completed t+5 or t+15
 * ONLY in retrospective evaluation, never during the live feature estimate.
 *
 * No orders, trading gates, model weights, broker connections, or risk changes.
 */
const fs=require('node:fs'),path=require('node:path');
const PAIRS=Object.freeze(['AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY']);
const PAIR_SET=new Set(PAIRS);
const ARTIFACT='irexpro-owner-demo-usd-common-factor-readonly-v1';
const OUTPUT='/home/lightworld/webapps/irexpro-research/usd-common-factor/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN=60000, FIVE=5*MIN, QUARTER=15*MIN;
const FACTOR_LOOKBACK=5;
const q={
 scope:[
 "SELECT b.id::text connection_id,transaction_timestamp() snapshot_at",
 "FROM trading.trading_sessions s",
 "JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id",
 "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
 "AND b.deleted_at IS NULL AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.account_currency='USD'",
 "AND b.status='CONNECTED' AND b.authorization_status='ACTIVE'",
 "ORDER BY s.started_at DESC LIMIT 1"
 ].join(' '),
 candles:[
 "SELECT instrument,bucket_time,bid_close,ask_close,last_quote_sample_at,",
 "last_positive_bid,last_positive_ask,last_positive_sample_at,",
 "positive_quote_sample_count FROM market_data.provider_quote_candles",
 "WHERE connection_id=$1 AND timeframe='M1' AND source='ctrader-broker-native'",
 "AND instrument=ANY($2::text[]) AND bucket_time>=$3::timestamptz",
 "AND bucket_time+interval '1 minute'<=$4::timestamptz-interval '3 seconds'",
 "ORDER BY bucket_time,instrument LIMIT 24001"
 ].join(' '),
 trades:[
 "SELECT t.opened_at,t.closed_at,t.instrument,t.direction,t.lot_size,",
 "t.realised_pnl,t.commission,t.swap,",
 "ti.metadata->>'multimodel_plan_b_route' AS route",
 "FROM trading.trades t",
 "JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id",
 "WHERE t.user_id=$1 AND t.broker_connection_id=$2",
 "AND b.deleted_at IS NULL AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.account_currency='USD'",
 "AND t.account_currency='USD' AND t.status='CLOSED'",
 "AND t.opened_at>=$3::timestamptz AND t.opened_at<=$4::timestamptz",
 "ORDER BY t.opened_at ASC LIMIT 501"
 ].join(' '),
};
const ms=x=>{const t=new Date(x).getTime();return Number.isFinite(t)?t:null};
const round=(n,d=3)=>Number.isFinite(n)?+n.toFixed(d):null;
const clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
function usdPolarity(pair){
 if(typeof pair!=='string'||pair.length!==6||!PAIR_SET.has(pair))return null;
 if(pair.startsWith('USD'))return 1;
 if(pair.endsWith('USD'))return -1;
 return null;
}
function median(nums){
 if(!Array.isArray(nums)||!nums.length||!nums.every(Number.isFinite))return null;
 const x=[...nums].sort((a,b)=>a-b),mid=Math.floor(x.length/2);
 return x.length%2?x[mid]:(x[mid-1]+x[mid])/2;
}
function toBars(rows,asOf){
 const now=ms(asOf);
 if(now===null)throw Error('INVALID_ASOF');
 const bars=new Map(PAIRS.map(p=>[p,new Map()]));
 let malformed=0,invalidTime=0,recoveredPositiveQuote=0;
 for(const row of rows){
  if(!PAIR_SET.has(row.instrument)){malformed++;continue}
  const t=ms(row.bucket_time),obs=ms(row.last_quote_sample_at);
  if(t===null||obs===null||t%MIN!==0||t+MIN>now-3000||
     obs<t||obs>=t+MIN||obs>now){
    invalidTime++;continue;
  }
  if(!(Number(row.positive_quote_sample_count)>0)){
    malformed++;continue;
  }
  let bid=Number(row.bid_close),ask=Number(row.ask_close),
    observedAt=obs,source='VALID_CLOSE';
  const spreadGood=(b,a)=>b>0&&a>b&&(a-b)/b<.002;
  if(!spreadGood(bid,ask)){
    // The provider sometimes overwrites a valid tick with zero bid/ask
    // spread at bucket close. Only a real, recorded positive-spread
    // broker-native quote within the FINAL 20 sec can be used. No
    // interpolation, previous-minute carry, or synthetic spread.
    const positiveAt=ms(row.last_positive_sample_at);
    const positiveBid=Number(row.last_positive_bid),
      positiveAsk=Number(row.last_positive_ask);
    if(positiveAt===null||positiveAt<t+40000||
      positiveAt>=t+MIN||positiveAt>obs||
      obs-positiveAt>20000||positiveAt>now||
      !spreadGood(positiveBid,positiveAsk)){
      malformed++;continue;
    }
    bid=positiveBid;ask=positiveAsk;observedAt=positiveAt;
    source='LAST_POSITIVE_QUOTE_FINAL_20S';
    recoveredPositiveQuote++;
  }
  bars.get(row.instrument).set(t,{
   time:t,mid:(bid+ask)/2,spreadBps:10000*(ask-bid)/((ask+bid)/2),
   quoteObservedAt:observedAt,source
  });
 }
 return {bars,malformed,invalidTime,recoveredPositiveQuote};
}
function barsFor(minutes,bucket,lookback=FACTOR_LOOKBACK){
 if(!(bucket instanceof Map)||!Number.isInteger(lookback)||lookback<1)return null;
 const result=[];
 for(let i=lookback;i>=0;i--){
  const b=bucket.get(minutes-i*MIN);
  if(!b||!(b.mid>0))return null;
  result.push(b);
 }
 return result;
}
function usdMomentum(bars,pair,t,minutes=FACTOR_LOOKBACK){
 const sign=usdPolarity(pair);
 if(sign===null||!Number.isInteger(minutes)||minutes<1)return null;
 const seq=barsFor(t,bars?.get(pair),minutes);
 if(!seq)return null;
 const first=seq[0].mid,last=seq[seq.length-1].mid;
 const value=10000*sign*Math.log(last/first);
 return Number.isFinite(value)?value:null;
}
function factorAt(bars,target,t){
 if(!PAIR_SET.has(target)||!Number.isInteger(t)||t%MIN!==0)return null;
 const peer=[];
 for(const pair of PAIRS){
  if(pair===target)continue; // leave-one-out prevents self-confirmation
  const raw=usdMomentum(bars,pair,t);
  if(raw===null)continue;
  peer.push({pair,polarity:usdPolarity(pair),
   usdReturnBps:round(raw,4),clippedUsdReturnBps:clamp(raw,-30,30)});
 }
 if(peer.length<4||!peer.some(p=>p.polarity>0)||
    !peer.some(p=>p.polarity<0)){
  return {state:'INSUFFICIENT_INDEPENDENT_PEERS',peerCount:peer.length,
   targetExcluded:true,hasMixedUsdQuotePositions:
    peer.some(p=>p.polarity>0)&&peer.some(p=>p.polarity<0)};
 }
 const med=median(peer.map(x=>x.clippedUsdReturnBps));
 const significant=peer.filter(x=>Math.abs(x.usdReturnBps)>=.35);
 const side=med>.5?'USD_STRONG':med<-.5?'USD_WEAK':'USD_MIXED';
 const agreement=side==='USD_MIXED'?null:
  significant.filter(x=>Math.sign(x.usdReturnBps)===Math.sign(med)).length/
    (significant.length||1);
 const state=side!=='USD_MIXED'&&significant.length>=3&&agreement>=.67?
  side:'NO_STRONG_CONSENSUS';
 return {state,rawSide:side,peerCount:peer.length,
  significantPeers:significant.length,usdMedianBps:round(med,4),
  agreement:round(agreement,4),targetExcluded:true,
  hasMixedUsdQuotePositions:true,
  peer,consensusPairDirection:state==='USD_STRONG'?
   (usdPolarity(target)>0?'BUY':'SELL'):
   state==='USD_WEAK'?(usdPolarity(target)>0?'SELL':'BUY'):null,
 };
}
function outcome(bars,target,t,horizon,signal){
 if(!Number.isInteger(horizon)||horizon<1||
    !['USD_STRONG','USD_WEAK'].includes(signal?.state))return null;
 const targetBars=bars.get(target);
 const start=targetBars?.get(t),future=targetBars?.get(t+horizon*MIN);
 if(!start||!future)return null;
 // Future quote is a LABEL only. It does not enter factorAt.
 const raw=10000*Math.log(future.mid/start.mid);
 const direction=signal.consensusPairDirection==='BUY'?1:-1;
 const favorable=direction*raw;
 // Round-trip spread estimate only; does NOT include commission, slippage,
 // broker fill or execution feasibility, hence never call it net profit.
 const spreadOnly=favorable-(start.spreadBps+future.spreadBps)/2;
 return {directionalCorrect:favorable>0,
  pairChangeBps:round(raw),directionalChangeBps:round(favorable),
  afterIndicativeSpreadOnlyBps:round(spreadOnly),
  includesFullBrokerCosts:false,brokerFill:false};
}
function stats(observations){
 const n=observations.length;
 const sumKey=k=>observations.reduce((s,x)=>s+x[k],0);
 return {events:n,directionalWins:observations.filter(x=>x.directionalCorrect).length,
  directionalLosses:observations.filter(x=>!x.directionalCorrect).length,
  directionalHitRate:n?round(observations.filter(x=>x.directionalCorrect).length/n,4):null,
  meanDirectionalChangeBps:n?round(sumKey('directionalChangeBps')/n):null,
  meanAfterSpreadOnlyBps:n?round(sumKey('afterIndicativeSpreadOnlyBps')/n):null,
  independentUtcDays:new Set(observations.map(x=>x.decisionDay)).size,
 };
}
function usdDirectionalBet(pair,direction){
 const sign=usdPolarity(pair);
 if(sign===null||!['BUY','SELL'].includes(direction))return null;
 const usdGains=(direction==='BUY'?1:-1)*sign;
 return usdGains===1?'USD_STRONG':'USD_WEAK';
}
function historicalUsdConcentration(trades){
 // All rows are from the same verified owner USD DEMO broker. The report
 // counts trade overlap, NOT equivalent USD notional; lot notionals differ.
 const valid=trades.map(t=>{
  const opened=ms(t.opened_at),closed=ms(t.closed_at),
    bet=usdDirectionalBet(t.instrument,t.direction);
  return {...t,opened,closed,bet};
 }).filter(t=>t.opened!=null&&t.closed!=null&&t.closed>t.opened&&t.bet);
 const opened=[...valid].sort((a,b)=>a.opened-b.opened);
 let maxConcurrent=0;
 const moments=[];
 for(const trade of opened){
  const overlapping=valid.filter(o=>o.bet===trade.bet&&
    o.opened<=trade.opened&&o.closed>trade.opened);
  const unique=overlapping.length;
  maxConcurrent=Math.max(maxConcurrent,unique);
  if(unique>=2){
   moments.push({at:new Date(trade.opened).toISOString(),
    exposureSide:trade.bet,concurrentPositions:unique,
    pairs:overlapping.map(x=>x.instrument+' '+x.direction).sort(),
    isIndependentExposure:false});
  }
 }
 return {
  totalClosedTradesConsidered:valid.length,
  maxConcurrentSameUsdDirectionPositions:maxConcurrent,
  sameUsdDirectionOverlapEvents:moments.length,
  latestOverlapMoments:moments.slice(-12),
  historicalOnly:true,changesExecution:false,
  note:'Overlapping currency pairs can express the same USD bet. Position counts are not risk-adjusted USD notionals; stop-risk, correlation and portfolio margin need separate verified analysis.',
 };
}
function tradeAlignmentReview(bars,tradeRows){
 const eligible=[],coverage={totalClosed:tradeRows.length,eligibleSignals:0,
  missingAsOfFactor:0,notStrongAtEntry:0,unknownCosts:0};
 for(const t of tradeRows){
  const when=ms(t.opened_at),pair=t.instrument;
  if(!PAIR_SET.has(pair)||when===null||
    !['BUY','SELL'].includes(t.direction)){
   coverage.missingAsOfFactor++;continue;
  }
  // The candle containing the order can only close AFTER the fill. Use the
  // immediately PRECEDING completed M1 candle; never its forming candle.
  const asOf=Math.floor(when/MIN)*MIN-MIN;
  if(!barsFor(asOf,bars.get(pair))){
   coverage.missingAsOfFactor++;continue;
  }
  const f=factorAt(bars,pair,asOf);
  if(!f||f.state==='INSUFFICIENT_INDEPENDENT_PEERS'){
   coverage.missingAsOfFactor++;continue;
  }
  if(!['USD_STRONG','USD_WEAK'].includes(f.state)){
   coverage.notStrongAtEntry++;continue;
  }
  const gross=Number(t.realised_pnl),commission=Number(t.commission),
    swap=Number(t.swap);
  if(![gross,commission,swap].every(Number.isFinite)||
    t.realised_pnl==null||t.commission==null||t.swap==null){
   coverage.unknownCosts++;continue;
  }
  eligible.push({
   at:new Date(when).toISOString(),pair,side:t.direction,
   strategy:t.route||'UNKNOWN',
   usdState:f.state,peerCount:f.peerCount,
   peerAgreement:f.agreement,
   factorAligned:f.consensusPairDirection===t.direction,
   netUsd:round(gross+commission+swap,2),
  });
 }
 coverage.eligibleSignals=eligible.length;
 const sum=group=>{
  const n=group.length,total=group.reduce((a,x)=>a+x.netUsd,0);
  return {trades:n,wins:group.filter(x=>x.netUsd>0).length,
   losses:group.filter(x=>x.netUsd<0).length,
   netUsd:round(total,2),meanNetUsd:n?round(total/n,2):null,
   independentUtcDays:new Set(group.map(x=>x.at.slice(0,10))).size};
 };
 const byRoute=Object.fromEntries([...new Set(eligible.map(x=>x.strategy))]
  .map(route=>[route,{
   aligned:sum(eligible.filter(x=>x.strategy===route&&x.factorAligned)),
   opposed:sum(eligible.filter(x=>x.strategy===route&&!x.factorAligned)),
  }]));
 return {
  coverage,
  aligned:sum(eligible.filter(x=>x.factorAligned)),
  opposed:sum(eligible.filter(x=>!x.factorAligned)),
  byStrategy:byRoute,
  cases:eligible.slice(-20),
  trainingOnly:true,
  changesExecution:false,
  warning:'Matched broker trade outcomes do not prove factor causality. Evaluation was not randomized and strategies self-selected their trades.',
 };
}
function auditBars(bars,options={}){
 const horizons=[5,15];
 const allTimes=[...new Set([...bars.values()].flatMap(m=>[...m.keys()]))]
  .filter(t=>Number.isInteger(t)).sort((a,b)=>a-b);
 const byHorizon={},last={};
 let totalAttempts=0,completeInputs=0;
 for(const horizon of horizons){
  const events=[],attempts=[],byTarget={};
  for(const target of PAIRS)byTarget[target]=[];
  for(const t of allTimes){
   if(t%(horizon*MIN)!==0)continue;
   for(const target of PAIRS){
    totalAttempts++;
    const targetPast=barsFor(t,bars.get(target));
    if(!targetPast)continue;
    const f=factorAt(bars,target,t);
    if(!f||f.state==='INSUFFICIENT_INDEPENDENT_PEERS')continue;
    completeInputs++;
    attempts.push({target,t,state:f.state});
    const future=outcome(bars,target,t,horizon,f);
    if(!future)continue;
    if(!last[target]||t>last[target].t){
     last[target]={t,target,state:f.state,
      factorMedianBps:f.usdMedianBps,agreement:f.agreement,
      peerCount:f.peerCount,direction:f.consensusPairDirection,
      targetExcluded:f.targetExcluded};
    }
    if(f.state==='NO_STRONG_CONSENSUS')continue;
    const entry={target,t,decisionDay:new Date(t).toISOString().slice(0,10),
     horizon,usdState:f.state,direction:f.consensusPairDirection,
     agreement:f.agreement, ...future};
    events.push(entry);
    byTarget[target].push(entry);
   }
  }
  byHorizon[String(horizon)+'m']={
   sampling:'non-overlapping '+horizon+'-minute bars PER instrument',
   attemptsWithCompleteOwnAndPeerHistory:attempts.length,
   strongSignals:events.length,
   summary:stats(events),
   byTarget:Object.fromEntries(Object.entries(byTarget)
    .map(([k,v])=>[k,stats(v)])),
   bySignal:Object.fromEntries(['USD_STRONG','USD_WEAK'].map(key=>
     [key,stats(events.filter(e=>e.usdState===key))])),
   // Genuine holdout requires a FUTURE collection, this is descriptive only.
   sampleCases:events.slice(-12).map(e=>({
    target:e.target,at:new Date(e.t).toISOString(),
    usdState:e.usdState,pairDirection:e.direction,
    outcomeAfterMinutes:e.horizon,directionalCorrect:e.directionalCorrect,
    directionalBps:e.directionalChangeBps,
    afterSpreadOnlyBps:e.afterIndicativeSpreadOnlyBps,
   })),
  };
 }
 return {artifact:ARTIFACT,mode:'READ_ONLY_RETROSPECTIVE',
  researchOnly:true,brokerOrders:0,modifiesExecution:false,
  changesLot:false,changesStop:false,modelWeightChanges:false,
  autoPromoteAllowed:false,universe:PAIRS,
  factorDefinition:'Median USD-oriented 5m broker-native M1 log returns across five OTHER pairs, clipped at +/-30bp; one mixed-side minimum',
  sideConvention:'USD as base: positive return means USD strength; USD as quote: negative return means USD strength',
  horizons:byHorizon,allTimeBuckets:allTimes.length,
  attemptedFactorSnapshots:totalAttempts,
  availableFactorSnapshots:completeInputs,
  latestEvaluatedSignals:Object.values(last).sort((a,b)=>b.t-a.t)
   .map(x=>({...x,at:new Date(x.t).toISOString()})).slice(0,6),
  caveats:[
   'Retrospective directional labels are not independently held-out forward results.',
   'Only completed broker-native M1 bars with within-minute positive bid/ask evidence are used; an invalid final close may use the actual last positive quote only if recorded in the last 20 seconds of the same minute and within 20 seconds of the last sample. Current forming bars never enter factors.',
   'No pair contributes to its own signal; other pairs must be timestamp-aligned.',
   'Spread-only estimates omit broker commission, slippage, position sizing, stop/target execution and correlation of exposures.',
   'Multiple pairs on the same timestamps are correlated; five-minute bar spacing does not create independent market days.',
   'Common factor correlation can disappear or invert in USD-versus-local-currency shocks and news events.',
   'No authorization to adjust DEMO trades, LIVE trades, Start/Stop, or expert weights.',
  ],
 };
}
async function queryAudit(db,owner,since){
 if(!UUID.test(owner||'')||!Number.isFinite(ms(since)))
  throw Error('INVALID_OWNER_OR_WINDOW');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='25000ms'");
  const scope=(await db.query(q.scope,[owner])).rows[0];
  if(!scope)throw Error('NO_ACTIVE_CONNECTED_OWNER_PEPPERSTONE_USD_DEMO');
  if(ms(scope.snapshot_at)-ms(since)>60*3600000||
     ms(since)>ms(scope.snapshot_at)-30*MIN)
    throw Error('AUDIT_TIME_WINDOW_OUT_OF_RANGE');
  const records=(await db.query(q.candles,[
   scope.connection_id,PAIRS,since,scope.snapshot_at])).rows;
  if(records.length>24000)throw Error('BROKER_CANDLE_RESULTS_TRUNCATED');
  const trades=(await db.query(q.trades,[owner,scope.connection_id,since,scope.snapshot_at])).rows;
  if(trades.length>500)throw Error('OWNER_TRADE_COHORT_TRUNCATED');
  await db.query('COMMIT');
  const parsed=toBars(records,scope.snapshot_at);
  const tradeAlignment=tradeAlignmentReview(parsed.bars,trades);
  const exposureOverlap=historicalUsdConcentration(trades);
  return {createdAt:new Date().toISOString(),
   windowFrom:since,windowThrough:scope.snapshot_at,
   broker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
   source:'ctrader-broker-native',rowsRead:records.length,
   malformedRows:parsed.malformed,invalidTimeRows:parsed.invalidTime,
   recoveredRecentPositiveSpreadQuotes:parsed.recoveredPositiveQuote,
   brokerTradeAlignment:tradeAlignment,
   historicalUsdExposureOverlap:exposureOverlap,
   barsByPair:Object.fromEntries([...parsed.bars.entries()]
    .map(([k,v])=>[k,v.size])),
   ...auditBars(parsed.bars)};
 }catch(error){
  await db.query('ROLLBACK').catch(()=>{});
  throw error;
 }
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
  application_name:'irexpro-owner-usd-common-factor-research',
  connectionTimeoutMillis:8000,statement_timeout:25000});
 try{
  await db.connect();
  const from=process.env.IREXPRO_USD_FACTOR_SINCE||
    new Date(Date.now()-48*3600000).toISOString();
  const report=await queryAudit(db,process.env.VPS_FOREX_SCANNER_USER_ID,from);
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2),{mode:0o600});
  console.log('OWNER_USD_CROSSPAIR_RESEARCH '+JSON.stringify({
   at:report.createdAt,source:report.source,
   bars:report.barsByPair,rows:report.rowsRead,
   forward5min:report.horizons['5m'].summary,
   forward15min:report.horizons['15m'].summary,
   byPair5min:report.horizons['5m'].byTarget,
   brokerTrades:report.brokerTradeAlignment,
   exposure:report.historicalUsdExposureOverlap,
   latest:report.latestEvaluatedSignals,
  }));
 }finally{await db.end();}
}
module.exports={ARTIFACT,PAIRS,usdPolarity,median,toBars,barsFor,usdMomentum,
 factorAt,outcome,stats,usdDirectionalBet,historicalUsdConcentration,
 tradeAlignmentReview,auditBars,queryAudit,q};
if(require.main===module)main().catch(error=>{
 console.error('OWNER_USD_CROSSPAIR_RESEARCH_FAILED',
  String(error?.message||error).slice(0,230));process.exitCode=1;
});
