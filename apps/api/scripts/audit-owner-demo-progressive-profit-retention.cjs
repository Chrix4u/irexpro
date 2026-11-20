#!/usr/bin/env node
'use strict';
/**
 * Original broker-settled outcomes BEFORE vs AFTER owner Pepperstone USD DEMO
 * progressive TP-relative profit retention rollout. Read-only; no orders.
 * Capture ratios compare 5s sampled broker-net peaks with final booked net.
 * They are NOT guaranteed broker stop protections or causal A/B evidence.
 */
const fs=require('node:fs'),path=require('node:path');
const ACTIVATED_AT='2026-11-20T09:28:43.000Z';
const FROM='2026-11-20T04:30:00.000Z';
const OUT='/home/lightworld/webapps/irexpro-research/profit-protection-rollout/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
 'SELECT t.id::text trade_id,t.opened_at,t.closed_at,t.instrument,t.direction,',
 't.lot_size,t.max_favorable_pnl,t.path_peak_observed_at,',
 't.path_observation_count,t.close_reason,t.realised_pnl,t.commission,t.swap,',
 "ti.metadata->>'multimodel_plan_b_route' AS strategy_route,",
 "COALESCE(NULLIF(ca.sizing_inputs->>'finalRiskAtStop','')::numeric,",
 "NULLIF(ca.sizing_inputs->>'riskAmount','')::numeric) AS initial_risk",
 'FROM trading.trades t',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
 'LEFT JOIN LATERAL (SELECT z.sizing_inputs FROM trading.capital_allocations z',
 ' WHERE z.trade_intent_id=t.trade_intent_id AND z.user_id=t.user_id',
 ' AND z.created_at<=t.opened_at ORDER BY z.created_at DESC LIMIT 1) ca ON true',
 'WHERE t.user_id=$1 AND b.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD'",
 "AND t.status='CLOSED' AND t.closed_at IS NOT NULL",
 'AND t.opened_at>=$2::timestamptz',
 'AND t.opened_at<$3::timestamptz',
 'AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL',
 'ORDER BY t.opened_at,t.id LIMIT 1001',
].join(' ');
const amount=v=>v==null||v===''?null:Number.isFinite(+v)?+v:null;
const rnd=(v,d=2)=>+v.toFixed(d);
const moment=x=>x==null?NaN:new Date(x).getTime();
function classify(row,activation=ACTIVATED_AT){
 const at=moment(row.opened_at),end=moment(row.closed_at),cut=moment(activation);
 if(!Number.isFinite(at)||!Number.isFinite(end)||end<at||!Number.isFinite(cut))throw Error('INVALID_BROKER_TIMES');
 const gross=amount(row.realised_pnl),fee=amount(row.commission),swap=amount(row.swap),peak=amount(row.max_favorable_pnl);
 const lots=amount(row.lot_size),risk=amount(row.initial_risk);
 if([gross,fee,swap,peak,lots].some(v=>v===null)||lots<=0||peak<0)throw Error('UNVERIFIED_BROKER_ECONOMICS');
 const net=rnd(gross+fee+swap);
 const label=end<cut?'BEFORE_ROLLOUT':at>=cut?'AFTER_ROLLOUT':'STRADDLED_ROLLOUT_EXCLUDED';
 const profitProtection=row.close_reason==='PROFIT_PROTECTION';
 const meaningfulPeak=risk!==null&&risk>0&&peak>=risk*0.5;
 return {
  day:new Date(at).toISOString().slice(0,10),open:new Date(at).toISOString(),
  closed:new Date(end).toISOString(),lotSize:lots,
  instrument:row.instrument,direction:row.direction,route:row.strategy_route??'UNKNOWN',
  closeReason:row.close_reason??'UNKNOWN',rolloutPeriod:label,
  gross,fee,swap,peak,net,risk,
  peakCaptureRatio:peak>0?rnd(net/peak,4):null,
  givebackToFinalNet:peak>0?rnd(peak-net):null,
  peakToCloseSeconds:Number.isFinite(moment(row.path_peak_observed_at))?
   rnd((end-moment(row.path_peak_observed_at))/1000,1):null,
  observations:Number(row.path_observation_count)||0,
  severeRetainedBelowHalf:profitProtection&&meaningfulPeak&&net<peak*0.5,
  profitProtection,meaningfulPeak,
 };
}
function aggregate(rows){
 const winners=rows.filter(x=>x.net>0),losers=rows.filter(x=>x.net<0);
 const protectedTrade=rows.filter(x=>x.profitProtection);
 const protectedWithPeak=protectedTrade.filter(x=>x.peak>0);
 const sum=(xs,k)=>rnd(xs.reduce((a,x)=>a+(x[k]||0),0));
 const avg=(xs,fn)=>xs.length?rnd(xs.reduce((a,x)=>a+fn(x),0)/xs.length,4):null;
 return {
  settled:rows.length,wins:winners.length,losses:losers.length,
  netUsd:sum(rows,'net'),gainsUsd:sum(winners,'net'),lossesUsd:sum(losers,'net'),
  profitFactor:losers.length&&sum(losers,'net')<0?
    rnd(sum(winners,'net')/(-sum(losers,'net')),4):null,
  protectedCloses:protectedTrade.length,
  protectedPeakObserved:protectedWithPeak.length,
  protectedNetUsd:sum(protectedTrade,'net'),
  protectedPeakSumUsd:sum(protectedWithPeak,'peak'),
  protectedFinalNetSumUsd:sum(protectedWithPeak,'net'),
  aggregatePeakCapture:sum(protectedWithPeak,'peak')>0?
    rnd(sum(protectedWithPeak,'net')/sum(protectedWithPeak,'peak'),4):null,
  averagePeakCapture:avg(protectedWithPeak,x=>x.peakCaptureRatio),
  averagePeakToCloseSeconds:avg(protectedWithPeak.filter(x=>x.peakToCloseSeconds!=null),
   x=>x.peakToCloseSeconds),
  severeRetainedBelowHalf:rows.filter(x=>x.severeRetainedBelowHalf).length,
  negativeFinalAfterFavorablePeak:rows.filter(x=>x.net<0&&x.peak>0).length,
  tradingDays:new Set(rows.map(x=>x.day)).size,
 };
}
function reportForRows(rows,asOf=new Date(),activation=ACTIVATED_AT){
 const trades=rows.map(x=>classify(x,activation));
 const before=trades.filter(x=>x.rolloutPeriod==='BEFORE_ROLLOUT');
 const after=trades.filter(x=>x.rolloutPeriod==='AFTER_ROLLOUT');
 const overlap=trades.filter(x=>x.rolloutPeriod==='STRADDLED_ROLLOUT_EXCLUDED');
 const routes=['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION'];
 return {
  artifact:'owner-demo-progressive-tp-retention-before-after-v1',
  asOf:asOf.toISOString(),activationAtUtc:activation,fromUtc:FROM,
  scopedOwnerPepperstoneUsdDemoOnly:true,brokerProof:'SETTLED_TRADES',
  comparedCohorts:{before:aggregate(before),after:aggregate(after),
   straddledExcluded:aggregate(overlap),
   byRoute:routes.map(route=>({route,before:aggregate(before.filter(x=>x.route===route)),
    after:aggregate(after.filter(x=>x.route===route))}))},
  mostRecentProtected:trades.filter(x=>x.profitProtection).slice(-15)
   .map(x=>({at:x.closed,route:x.route,instrument:x.instrument,
    lotSize:x.lotSize,peak:x.peak,net:x.net,capture:x.peakCaptureRatio,
    peakToCloseSeconds:x.peakToCloseSeconds,rolloutPeriod:x.rolloutPeriod})),
  modifiesExecution:false,noOrders:true,noSqlWrites:true,
  demonstratedCausalImprovement:false,
  limitations:[
   'This compares actual broker-settled net with sampled broker-net peak; it is NOT the percent locked by a broker-side stop.',
   'A 5-second polled peak may MISS intratick peaks, and market gaps/slippage/fees can make realized outcomes lower than a trigger.',
   'Peak/current quote marks and final booked commission may have different accounting bases. Capture ratio is descriptive only.',
   'The before and after sessions differ in timing, route, lot size, volatility and other trading conditions. Not an A/B trial.',
   'Any trade straddling the activation boundary is excluded from both groups.',
   'Small samples and multiple intraday policy changes prohibit early profit claims.',
   'The rollout only tightens a pre-existing owner Pepperstone USD DEMO threshold; no broker stops are modified.',
  ],
 };
}
async function run(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('OWNER_SCOPE_REQUIRED');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,statement_timeout:14000,
  application_name:'irexpro-owner-demo-progressive-retention-READONLY'});
 await db.connect();let rows;
 try{
  await db.query('BEGIN READ ONLY');
  rows=(await db.query(SQL,[owner,FROM,new Date().toISOString()])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 if(rows.length>1000)throw Error('TRUNCATED_ROLLOUT_COHORT');
 const result=reportForRows(rows);
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,JSON.stringify(result,null,2),{mode:0o600});
 console.log('DEMO_PROGRESSIVE_PEAK_RETENTION_SCOREBOARD '+JSON.stringify({
  at:result.asOf,before:result.comparedCohorts.before,
  after:result.comparedCohorts.after,straddled:result.comparedCohorts.straddledExcluded.settled,
  demoOnly:true,noBrokerOrders:true,
 }));
 return result;
}
module.exports={ACTIVATED_AT,FROM,SQL,classify,aggregate,reportForRows,run};
if(require.main===module)run().catch(e=>{console.error('DEMO_PROGRESSIVE_RETENTION_AUDIT_FAILED',e.message);process.exitCode=1});
