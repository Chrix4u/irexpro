#!/usr/bin/env node
'use strict';
/**
 * Independent prospective USD-factor vs ACTUAL broker trade outcomes.
 * No order, model, broker, allocation or Start/Stop mutations.
 * Features frozen only while broker position is OPEN and within 120 sec.
 * Historical future bars CANNOT enter the pre-entry factor.
 */
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {PAIRS,q,toBars,factorAt}=require('./audit-owner-demo-usd-crosspair-factor.cjs');
const ARTIFACT='owner-pepperstone-usd-factor-trade-attribution-shadow-v1';
const ROOT='/home/lightworld/webapps/irexpro-research/usd-common-factor/trade-forward';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN=60000, FROZEN_MAX_AGE=120000;
const ALLOWED=new Set(['CONFIRMED_REVERSAL','EARLY_TRANSITION','TREND_CONTINUATION']);
const tradeSql=[
 "SELECT t.id::text trade_id,t.opened_at,t.closed_at,t.status,",
 "t.instrument,t.direction,t.lot_size,t.realised_pnl,t.commission,t.swap,",
 "t.close_reason,ti.metadata->>'multimodel_plan_b_route' route",
 "FROM trading.trades t",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
 "AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id",
 "WHERE t.user_id=$1 AND t.broker_connection_id=$2",
 "AND t.account_currency='USD' AND t.opened_at >= $3::timestamptz",
 "AND ti.metadata->>'multimodel_plan_b_route'=ANY($4::text[])",
 "ORDER BY t.opened_at DESC,t.id DESC LIMIT 501"
].join(' ');
const dateMs=v=>{const x=new Date(v).getTime();return Number.isFinite(x)?x:null;};
const round=(x,d=3)=>Number.isFinite(x)?+x.toFixed(d):null;
const numeric=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const fingerprint=s=>createHash('sha256').update(s).digest('hex');
function freeze(root,owner,conn,now){
 if(!UUID.test(owner)||!UUID.test(conn)||!Number.isFinite(now))
  throw Error('INVALID_OWNER_BROKER_OR_TIME');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const markerFile=path.join(root,'activation.json'),binding=fingerprint(owner+'/'+conn);
 if(!fs.existsSync(markerFile))
  fs.writeFileSync(markerFile,JSON.stringify({
   artifact:ARTIFACT,activatedAt:new Date(now).toISOString(),ownerBrokerBinding:binding,
   researchOnly:true,brokerOrderAuthority:'NONE',modifiesExecution:false,
   changesStartStop:false,automaticPromotion:false,
  },null,2),{flag:'wx',mode:0o600});
 const marker=JSON.parse(fs.readFileSync(markerFile,'utf8'));
 if(marker.artifact!==ARTIFACT||marker.ownerBrokerBinding!==binding||
  marker.brokerOrderAuthority!=='NONE'||marker.researchOnly!==true||
  dateMs(marker.activatedAt)==null||dateMs(marker.activatedAt)>now)
  throw Error('INVALID_OR_CHANGED_FROZEN_ACTIVATION');
 const stateFile=path.join(root,'state.json');
 const state=fs.existsSync(stateFile)?
  JSON.parse(fs.readFileSync(stateFile,'utf8')):
  {artifact:ARTIFACT,trades:{},capturedAt:null};
 if(state.artifact!==ARTIFACT||typeof state.trades!=='object'||
  Array.isArray(state.trades))throw Error('INVALID_STATE');
 return {marker,state};
}
function entrySlot(openAt){
 const at=dateMs(openAt);
 if(at==null)return null;
 // The minute selected must have ended at least THREE seconds before order
 // opened; latest forming minute cannot enter the historical feature.
 const t=Math.floor((at-MIN-3000)/MIN)*MIN;
 return t+MIN<=at-3000?t:null;
}
function signalAtEntry(row,bars,marker,asOf){
 const open=dateMs(row.opened_at),now=dateMs(asOf),since=dateMs(marker.activatedAt);
 if(!UUID.test(String(row.trade_id))||open==null||now==null||since==null||
  row.status!=='OPEN'||open<since||open>now||
  now-open>FROZEN_MAX_AGE||!PAIRS.includes(row.instrument)||
  !ALLOWED.has(row.route)||!['BUY','SELL'].includes(row.direction))
  return null;
 const t=entrySlot(row.opened_at);
 if(t==null)return null;
 const factor=factorAt(bars,row.instrument,t);
 if(!factor||factor.state==='INSUFFICIENT_INDEPENDENT_PEERS')
  return {tradeId:row.trade_id,openedAt:new Date(open).toISOString(),
   pair:row.instrument,side:row.direction,route:row.route,
   lot:round(numeric(row.lot_size),4),preEntryAsOf:new Date(t+MIN).toISOString(),
   factorState:'UNAVAILABLE',signalAligned:null,independentPeers:factor?.peerCount||0,
   independentQuoteEvidence:false};
 const signal=factor.consensusPairDirection;
 return {tradeId:row.trade_id,openedAt:new Date(open).toISOString(),
  pair:row.instrument,side:row.direction,route:row.route,
  lot:round(numeric(row.lot_size),4),preEntryAsOf:new Date(t+MIN).toISOString(),
  factorState:factor.state,signalAligned:signal?signal===row.direction:null,
  medianUsdStrengthBps:factor.usdMedianBps??null,
  consensusPairDirection:signal,independentPeers:factor.peerCount,
  agreement:factor.agreement??null,independentQuoteEvidence:true,
  targetExcluded:factor.targetExcluded===true,
  peerPairs:(factor.peer||[]).map(x=>x.pair),
  featureCreatedAt:new Date(now).toISOString(),
 };
}
function settledOutcome(row){
 const gross=numeric(row.realised_pnl),commission=numeric(row.commission),
  swap=numeric(row.swap),closedAt=dateMs(row.closed_at);
 if(row.status!=='CLOSED'||closedAt==null||
  ![gross,commission,swap].every(Number.isFinite))
  return null;
 return {closedAt:new Date(closedAt).toISOString(),
  netUsd:round(gross+commission+swap,2),
  brokerGross:round(gross,2),brokerCommission:round(commission,2),
  brokerSwap:round(swap,2),closeReason:row.close_reason||null,
  brokerSettled:true};
}
function plan(rows,bars,marker,state,asOf){
 const events=[];
 for(const row of rows){
  if(!UUID.test(String(row.trade_id)))continue;
  let rec=state.trades[row.trade_id];
  if(!rec){
   const entry=signalAtEntry(row,bars,marker,asOf);
   if(!entry)continue;
   rec={entry};
   state.trades[row.trade_id]=rec;
   events.push({kind:'FROZEN_PRE_ENTRY_FACTOR',tradeId:row.trade_id,
    feature:entry});
  }
  if(!rec.settled){
   const result=settledOutcome(row);
   if(result){rec.settled=result;
    events.push({kind:'BROKER_SETTLED_OUTCOME',
     tradeId:row.trade_id,route:rec.entry.route,
     alignment:rec.entry.signalAligned,result});}
  }
 }
 return {state,events:events.map(event=>({
  artifact:ARTIFACT,...event,recordedAt:new Date(asOf).toISOString(),
  researchOnly:true,brokerOrders:0,hasExecutionAuthority:false,
 }))};
}
function summarize(state,marker){
 const entries=Object.values(state.trades).filter(x=>x.entry),
  complete=entries.filter(x=>x.settled),
  pairGroup=(rows)=>({
   trades:rows.length,closed:rows.filter(x=>x.settled).length,
   wins:rows.filter(x=>x.settled?.netUsd>0).length,
   losses:rows.filter(x=>x.settled?.netUsd<0).length,
   settledNetUsd:round(rows.reduce((s,x)=>s+(x.settled?.netUsd||0),0),2),
   utcTradeDays:new Set(rows.map(x=>x.entry.openedAt.slice(0,10))).size,
  }),
  alignment={aligned:[],opposed:[],unavailable:[]},
  routes={};
 for(const x of entries){
  const key=x.entry.signalAligned==null?'unavailable':
   x.entry.signalAligned?'aligned':'opposed';
  alignment[key].push(x);
  const route=x.entry.route;
  if(!routes[route])routes[route]={aligned:[],opposed:[],unavailable:[]};
  routes[route][key].push(x);
 }
 return {artifact:ARTIFACT,generatedAt:new Date().toISOString(),
  activatedAt:marker.activatedAt,
  broker:'pepperstone-ctrader',account:'USD DEMO',
  researchOnly:true,brokerOrders:0,modifiesExecution:false,
  changesOrders:false,changesLots:false,changesRiskGates:false,
  changesStartStop:false,autoPromotion:false,
  all:pairGroup(entries),
  byAlignment:Object.fromEntries(Object.entries(alignment)
   .map(([k,v])=>[k,pairGroup(v)])),
  byRoute:Object.fromEntries(Object.entries(routes)
   .map(([k,v])=>[k,Object.fromEntries(Object.entries(v)
    .map(([b,z])=>[b,pairGroup(z)]))])),
  latestFrozens:entries.slice(-10).map(x=>({
   pair:x.entry.pair,side:x.entry.side,route:x.entry.route,
   openedAt:x.entry.openedAt,alignment:x.entry.signalAligned,
   usdState:x.entry.factorState,settledNetUsd:x.settled?.netUsd??null,
  })),
  caveat:'Small, correlated and trade-selected sample. A feature association is NOT causal and cannot justify automatic trade vetoes, stops, position sizing or LIVE promotion.',
 };
}
function atomic(file,obj){
 const tmp=file+'.'+process.pid+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(obj,null,2),{flag:'wx',mode:0o600});
 fs.renameSync(tmp,file);
}
async function snapshot(db,owner){
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='16000ms'");
  const scope=(await db.query(q.scope,[owner])).rows[0];
  if(!scope)throw Error('OWNER_ACTIVE_DEMO_SCOPE_MISSING');
  const now=dateMs(scope.snapshot_at);
  const since=new Date(now-70*MIN).toISOString();
  const [raw,tradeRows]=await Promise.all([
   db.query(q.candles,[scope.connection_id,PAIRS,since,scope.snapshot_at]),
   db.query(tradeSql,[owner,scope.connection_id,
    new Date(now-4*86400000).toISOString(),[...ALLOWED]]),
  ]);
  if(raw.rows.length>24000||tradeRows.rows.length>500)
   throw Error('SHADOW_SOURCE_TRUNCATED');
  await db.query('COMMIT');
  const parsed=toBars(raw.rows,scope.snapshot_at);
  return {scope,asOf:scope.snapshot_at,bars:parsed.bars,trades:tradeRows.rows,
   badQuotes:parsed.malformed+parsed.invalidTime};
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}
async function step(db,root,owner){
 const src=await snapshot(db,owner),at=dateMs(src.asOf);
 const {marker,state}=freeze(root,owner,src.scope.connection_id,at);
 const next=plan(src.trades,src.bars,marker,state,src.asOf);
 for(const evt of next.events){
  fs.appendFileSync(path.join(root,evt.recordedAt.slice(0,10)+'.jsonl'),
   JSON.stringify(evt)+'\n',{mode:0o600});
 }
 state.capturedAt=src.asOf;
 atomic(path.join(root,'state.json'),state);
 const report=summarize(state,marker);
 atomic(path.join(root,'latest-summary.json'),report);
 return {newEvents:next.events.length,report};
}
async function main(){
 if(!process.argv.includes('--watch'))throw Error('RESEARCH_WATCH_ONLY');
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('NO_CONFIGURED_OWNER');
 let busy=false;
 async function run(){
  if(busy)return;busy=true;let db;
  try{
   db=new Client({host:process.env.DB_HOST,
    port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    connectionTimeoutMillis:7000,statement_timeout:16000,
    application_name:'irexpro-owner-usd-trade-attribution-research'});
   await db.connect();
   const r=await step(db,ROOT,owner);
   if(r.newEvents)console.log('USD_TRADE_FACTOR_SHADOW_EVENTS '+JSON.stringify({
    at:r.report.generatedAt,count:r.newEvents,
    entries:r.report.all.trades,settled:r.report.all.closed,
    brokerOrders:0}));
  }catch(e){console.error('USD_TRADE_FACTOR_SHADOW_DEFERRED',
   String(e.message||e).slice(0,190));}
  finally{await db?.end().catch(()=>{});busy=false;}
 }
 await run();
 setInterval(()=>void run(),30000);
 console.log('USD_TRADE_FACTOR_SHADOW_READ_ONLY_READY');
}
module.exports={ARTIFACT,ROOT,tradeSql,freeze,entrySlot,
 signalAtEntry,settledOutcome,plan,summarize,snapshot,step};
if(require.main===module)main().catch(e=>{
 console.error('USD_TRADE_FACTOR_SHADOW_START_FAILED',
  String(e.message||e).slice(0,190));process.exitCode=1;
});
