#!/usr/bin/env node
'use strict';
/**
 * Post-PROFIT_PROTECTION quote-path shadow for Pepperstone USD DEMO.
 * Reuses the exact two-clock quote validation and quote-side logic of the
 * deployed five-minute guard postexit audit. No counterfactual fills.
 * Read-only; no exits are changed; only settled broker trades are included.
 */
const fs=require('node:fs'),path=require('node:path');
const reference=require('./audit-owner-demo-drawdown-guard-postexit.cjs');
const ROOT='/home/lightworld/webapps/irexpro-research';
const OUT=ROOT+'/exit-payoff/latest-protected-postexit-quotes.json';
const HORIZONS=reference.HORIZONS;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const QUERY=[
 'SELECT t.instrument,t.direction,t.opened_at,t.closed_at,t.fill_price,',
 't.exit_price,ti.stop_loss,ti.take_profit,t.realised_pnl,t.commission,',
 "t.swap,t.lot_size,ti.metadata->>'multimodel_plan_b_route' AS route",
 'FROM trading.trades t',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
 'AND ti.broker_connection_id=t.broker_connection_id',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'WHERE t.user_id=$1 AND b.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD' AND b.deleted_at IS NULL",
 "AND t.status='CLOSED' AND t.close_reason='PROFIT_PROTECTION'",
 'AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL',
 'AND t.closed_at>=$2::timestamptz',
 'ORDER BY t.closed_at ASC LIMIT 501'
].join(' ');
const round=(x,d=3)=>Number(x.toFixed(d));
function summarize(trades,stats,fromUtc,now=new Date()){
 const horizons={};
 for(const h of HORIZONS){
  const key=h+'m';
  const valid=trades.filter(x=>x.status==='BROKER_SETTLED');
  const complete=valid.filter(x=>x.stages[key]?.status==='COMPLETE_SAMPLED_PATH');
  const notMature=valid.filter(x=>x.stages[key]?.status==='NOT_MATURE');
  const missed=valid.filter(x=>!['COMPLETE_SAMPLED_PATH','NOT_MATURE'].includes(x.stages[key]?.status));
  const accum=(rows)=>{
   const n=rows.length,better=rows.filter(x=>x.stages[key].additionalPipsAtLastSample>0),
    worse=rows.filter(x=>x.stages[key].additionalPipsAtLastSample<0),
    flat=rows.filter(x=>x.stages[key].additionalPipsAtLastSample===0);
   const stops=rows.filter(x=>x.stages[key].sampledOriginalStop);
   const targets=rows.filter(x=>x.stages[key].sampledOriginalTarget);
   const firstTargets=rows.filter(x=>x.stages[key].firstSeenOriginalBarrier==='TARGET');
   const firstStops=rows.filter(x=>x.stages[key].firstSeenOriginalBarrier==='STOP');
   return {completeSampledPaths:n,betterQuoteAtHorizon:better.length,
    worseQuoteAtHorizon:worse.length,sameQuoteAtHorizon:flat.length,
    sampledOriginalStop:stops.length,sampledOriginalTarget:targets.length,
    firstSampledBarrierTarget:firstTargets.length,
    firstSampledBarrierStop:firstStops.length,
    meanAdditionalPipsAtHorizon:n?round(rows.reduce((s,x)=>s+x.stages[key].additionalPipsAtLastSample,0)/n):null,
    medianAdditionalPipsAtHorizon:n?(()=>{
     const sorted=rows.map(x=>x.stages[key].additionalPipsAtLastSample).sort((a,b)=>a-b);
     return round(n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2);
    })():null,
    actualNetUsdForCoveredExits:round(rows.reduce((s,x)=>s+x.exitNetUsd,0),2),
    hypotheticalDelayedBrokerNetUsd:null,
    noExecutableQuoteOrFillClaim:true};
  };
  const routeGroups={};
  for(const x of complete)(routeGroups[x.route]??=[]).push(x);
  horizons[key]={
   completeSampledPaths:complete.length,
   noMatureQuotePath:notMature.length,
   incompleteOrMissingQuotePath:missed.length,
   ...accum(complete),
   byRoute:Object.fromEntries(Object.entries(routeGroups).map(([route,subset])=>[route,accum(subset)])),
  };
 }
 const supported=trades.filter(x=>x.status==='BROKER_SETTLED');
 const result={
  artifact:'irexpro-owner-demo-profit-protection-postexit-quotes-v1',
  asOf:now.toISOString(),fromUtc,
  scopedBroker:'pepperstone-ctrader',
  accountType:'DEMO',currency:'USD',
  brokerSettledProfitProtectedExits:supported.length,
  unsupportedSettledRows:trades.length-supported.length,
  actualExitNetUsd:round(supported.reduce((s,x)=>s+x.exitNetUsd,0),2),
  quoteValidation:stats,
  horizons,
  researchOnly:true,modifiesExecution:false,noSqlWrites:true,
  brokerOrders:false,changedStopOrProfitProtection:false,
  limitations:[
   'This cohort comprises ONLY positions already closed by profit protection, not a randomized delayed-exit policy.',
   'For a BUY, a sampled BID is used; for a SELL, sampled ASK. The quotes reflect archived market data, not a guaranteed order fill.',
   'A positive additional pip value says the sampled market price at the specified horizon moved favorably beyond the actual exit, not that delaying would have generated more realized after-cost USD.',
   'A negative additional pip value says sampled prices turned worse; the sampled quote could be unreachable with live latency, slippage, priority, spread or execution.',
   'The original intent stop and target are used for price observation, not the potentially modified broker-side protective stop at exit.',
   'A sampled original target can occur after an unobserved stop or market gap; first-sampled barrier is not proven stop/target precedence.',
   'Quotes must have both captured and source clocks within 15 seconds; 30-second boundary and max-60-second interquote gaps are required. Incomplete paths are censored.',
   'Different lot sizes and independent entry-selection changes make extrapolated delayed-exit financial outcomes unreliable.',
   'No strategy is retrained or promoted, no stops or profit-protection thresholds are changed, and the owner high-lot DEMO trial remains untouched.',
  ]
 };
 return result;
}
async function runWithArchive(byPair,quoteStats,fromUtc=reference.windowStart()){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('OWNER_SCOPE_UNAVAILABLE');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  statement_timeout:16000,connectionTimeoutMillis:6000,
  application_name:'irexpro-owner-profit-protection-postexit-READONLY'});
 let rows;
 await db.connect();
 try{await db.query('BEGIN READ ONLY');
  rows=(await db.query(QUERY,[owner,fromUtc])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end();}
 if(rows.length>500)throw Error('PROFIT_PROTECTION_TRADE_QUERY_LIMIT');
 const now=new Date();
 const details=rows.map(r=>reference.outcome(r,byPair.get(r.instrument),now.getTime()));
 const report=summarize(details,quoteStats,fromUtc,now);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 const payload=JSON.stringify(report,null,2);
 fs.writeFileSync(OUT,payload,{mode:0o600});
 const archive=path.join(path.dirname(OUT),'daily',report.asOf.slice(0,10)+'-profit-protection-postexit.json');
 fs.mkdirSync(path.dirname(archive),{recursive:true,mode:0o700});
 fs.writeFileSync(archive,payload,{mode:0o600});
 console.log('PROFIT_PROTECTION_POSTEXIT_SHADOW '+JSON.stringify({
  asOf:report.asOf,settled:report.brokerSettledProfitProtectedExits,
  actualNetUsd:report.actualExitNetUsd,
  complete5m:report.horizons['5m'].completeSampledPaths,
  better5m:report.horizons['5m'].betterQuoteAtHorizon,
  worse5m:report.horizons['5m'].worseQuoteAtHorizon,
  researchOnly:true,noBrokerOrders:true}));
 return report;
}
async function run(){
 const from=reference.windowStart(),q=reference.loadQuotes(ROOT,from);
 return runWithArchive(q.byPair,q.stats,from);
}
module.exports={QUERY,summarize,runWithArchive,run};
if(require.main===module)run().catch(e=>{
 console.error('PROFIT_PROTECTION_POSTEXIT_SHADOW_FAILED',String(e.message).slice(0,220));
 process.exitCode=1;
});
