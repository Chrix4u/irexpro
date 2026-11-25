#!/usr/bin/env node
'use strict';
const {readBoundedText}=require('./bounded-research-file.cjs');
/**
 * Read-only, owner-scoped alignment of genuinely prospective, PRE-INTENT
 * M1 forming-candle research forecasts against actual settled DEMO trades.
 * This does not infer hypothetical fills or allow trade vetoes.
 */
const fs=require('node:fs'),path=require('node:path');
const ROOT='/home/lightworld/webapps/irexpro-research/forming-candle-predictions';
const OUT=ROOT+'/latest-trade-alignment.json';
const ARTIFACT='irexpro-owner-demo-candle-trade-asof-alignment-v1';
const SOURCE='irexpro-owner-demo-prospective-candle-shadow-v1';
const START='2026-11-17T17:00:00Z';
const END='2026-11-21T00:00:00Z';
const MAX_AGE=90000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=[
'SELECT t.instrument,t.direction,t.lot_size,t.opened_at,t.closed_at,',
't.realised_pnl,t.commission,t.swap,ti.created_at intent_at,',
"ti.metadata->>'multimodel_plan_b_route' route",
'FROM trading.trades t',
'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
'AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id',
'WHERE t.user_id=$1 AND b.user_id=$1',
"AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
"AND b.account_currency='USD' AND t.account_currency='USD'",
'AND b.deleted_at IS NULL AND t.status=\'CLOSED\' AND t.closed_at IS NOT NULL',
'AND t.opened_at >=$2::timestamptz AND t.opened_at <$3::timestamptz',
'ORDER BY t.opened_at LIMIT 501'
].join(' ');
const money=n=>Number(Number(n).toFixed(2));
function isSafeForecast(p) {
 if(!p||p.artifact!==SOURCE||p.researchOnly!==true||
   p.brokerOrderAuthority!==false||p.modifiesExecution!==false||
   p.nextCandleOutcomeKnown!==false||p.afterCostPnlKnown!==false||
   !['EURUSD','AUDUSD','USDCAD','USDJPY'].includes(p.instrument)||
   p.timeframe!=='M1'||!['RED_OR_DOWN','GREEN_OR_UP','COST_SMALL_OR_FLAT'].includes(p.predictedNextCandleClass)||
   !Number.isFinite(p.confidence)||p.confidence<0||p.confidence>1)return false;
 const written=Date.parse(p.forecastWrittenAt),decided=Date.parse(p.decisionAt),bar=Date.parse(p.barStart);
 if(!Number.isFinite(written)||!Number.isFinite(decided)||!Number.isFinite(bar))return false;
 const labels=['RED_OR_DOWN','COST_SMALL_OR_FLAT','GREEN_OR_UP'];
 const probabilities=p.rawUncalibratedProbabilities;
 if(!probabilities||typeof probabilities!=='object'||
   Object.keys(probabilities).length!==labels.length||
   labels.some(k=>!Number.isFinite(probabilities[k])||probabilities[k]<0||probabilities[k]>1)||
   Math.abs(labels.reduce((s,k)=>s+probabilities[k],0)-1)>.001||
   Math.abs(Math.max(...labels.map(k=>probabilities[k]))-p.confidence)>.001||
   Math.abs(probabilities[p.predictedNextCandleClass]-p.confidence)>.001)return false;
 const offset=decided-bar,latency=written-decided;
 if(!Number.isFinite(p.snapshotAgeSeconds)||Math.abs(p.snapshotAgeSeconds-latency/1000)>.25)return false;
 return [15000,45000].includes(offset)&&latency>=2000&&latency<=12000&&written<bar+60000&&
   Number.isFinite(Date.parse(p.modelTrainedAt))&&decided>Date.parse(p.modelTrainedAt)+60000;
}
function loadForecasts(dir=ROOT){
 const byPair=new Map();
 for(const day of ['2026-11-17','2026-11-18','2026-11-19','2026-11-20']){
  const f=path.join(dir,day+'.jsonl');
  const body=readBoundedText(f,25*1024*1024,'UNBOUNDED_FORECAST_FILE',true);
  if(body===null)continue;
  for(const line of body.split('\n')){
   if(!line)continue;let p;try{p=JSON.parse(line)}catch{continue}
   if(!isSafeForecast(p))continue;
   (byPair.get(p.instrument)||byPair.set(p.instrument,[]).get(p.instrument)).push(p);
  }
 }
 for(const list of byPair.values())list.sort((a,b)=>Date.parse(a.forecastWrittenAt)-Date.parse(b.forecastWrittenAt));
 return byPair;
}
function latestPreIntent(list,intentAt){
 if(!Number.isFinite(intentAt))return null;
 let candidate=null;
 for(const p of list||[]){
  const at=Date.parse(p.forecastWrittenAt);
  if(at>intentAt)break;
  if(intentAt-at<=MAX_AGE)candidate=p;
 }
 return candidate;
}
function group(){return {trades:0,winners:0,losers:0,netUsd:0,volumeLots:0}}
function add(g,t){g.trades++;g.winners+=t.net>0;g.losers+=t.net<0;g.netUsd+=t.net;g.volumeLots+=t.lots}
function summarize(rows,forecasts){
 const byRoute={};
 let withForecast=0,noForecast=0,invalid=0;
 for(const r of rows){
  const intent=Date.parse(r.intent_at),opened=Date.parse(r.opened_at),
   closed=Date.parse(r.closed_at),gross=Number(r.realised_pnl),
   commission=Number(r.commission),swap=Number(r.swap),lots=Number(r.lot_size);
  if(!['BUY','SELL'].includes(r.direction)||!Number.isFinite(intent)||
    !Number.isFinite(opened)||!Number.isFinite(closed)||intent>opened||
    opened>closed||![gross,commission,swap,lots].every(Number.isFinite)||lots<=0){invalid++;continue}
  const t={net:gross+commission+swap,lots};
  const o=byRoute[r.route||'UNKNOWN']??={
   all:group(),matched:group(),unmatched:group(),highConfFlat:group(),
   otherMatched:group(),opposingDirAt40:group(),agreeingDirAt40:group()};
  add(o.all,t);
  const p=latestPreIntent(forecasts.get(r.instrument),intent);
  if(!p){noForecast++;add(o.unmatched,t);continue}
  withForecast++;add(o.matched,t);
  if(p.predictedNextCandleClass==='COST_SMALL_OR_FLAT'&&p.confidence>=.65)
   add(o.highConfFlat,t);
  else add(o.otherMatched,t);
  if(p.confidence>=.4){
   const buy=r.direction==='BUY',up=p.predictedNextCandleClass==='GREEN_OR_UP',down=p.predictedNextCandleClass==='RED_OR_DOWN';
   if((buy&&down)||(!buy&&up))add(o.opposingDirAt40,t);
   if((buy&&up)||(!buy&&down))add(o.agreeingDirAt40,t);
  }
 }
 for(const route of Object.values(byRoute)){
  for(const g of Object.values(route)){g.netUsd=money(g.netUsd);g.volumeLots=money(g.volumeLots)}
 }
 return {artifact:ARTIFACT,generatedAt:new Date().toISOString(),
   observationalOnly:true,noExecutionAuthority:true,promotionAllowed:false,
   noCounterfactualBrokerFills:true,postOpenOutcomesUsedOnlyForAudit:true,
   cohort:{ownerBroker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
    fromUtc:START,toExclusiveUtc:END,maxSnapshotAgeSeconds:90,
    qualifyingForecast:'latest safely persisted M1 before original trade intent',
    totalSettledRows:rows.length,withForecast,noForecast,invalid},
   byRoute,limitations:[
    'Flags were not actually used to defer or block these broker trades.',
    'Hypothetical saved losses are not realized profits or proof of better delayed fills.',
    'High-confidence FLAT is a forecast of the next candle category, not a direct prediction of the trade outcome.',
    'Traded positions overlap, share USD market shocks and have different lot sizes.',
    'Unobserved rejected candidates and subsequent opportunities are not included.',
    'Do not choose thresholds from this audit and promote them without sealed later-market-date testing.'
   ]};
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;if(!UUID.test(owner||''))throw Error('DEMO_OWNER_SCOPE_UNVERIFIED');
 const c=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  application_name:'irexpro-owner-candle-trade-alignment-READONLY',statement_timeout:12000});
 let rows;
 await c.connect();try{await c.query('BEGIN READ ONLY');rows=(await c.query(SQL,[owner,START,END])).rows;await c.query('ROLLBACK')}
 catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{await c.end()}
 if(rows.length>500)throw Error('TRADE_QUERY_EXCEEDED_BOUND');
 const report=summarize(rows,loadForecasts());
 fs.writeFileSync(OUT,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({generatedAt:report.generatedAt,cohort:report.cohort,byRoute:report.byRoute,
  noExecutionAuthority:true},null,2));
}
module.exports={ARTIFACT,isSafeForecast,latestPreIntent,summarize,loadForecasts};
if(require.main===module)main().catch(e=>{console.error('CANDLE_TRADE_ALIGNMENT_DEFERRED',String(e.message).slice(0,170));process.exitCode=1});
