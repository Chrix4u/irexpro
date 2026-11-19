#!/usr/bin/env node
'use strict';
/**
 * Prospective broker-telemetry shadow, no broker/order/execution dependencies.
 * Only samples OPEN trades AFTER a frozen activation; a broker-net P&L crossing
 * is NOT a verified quote, executable stop, broker-close command or fill.
 */
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {peakGate}=require('./audit-owner-demo-reversal-entry-exits.cjs');
const ARTIFACT='owner-demo-025r-net-peak-crossing-forward-shadow-v1';
const ROOT='/home/lightworld/webapps/irexpro-research/reversal-low-peak-forward';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ms=x=>{const n=new Date(x).getTime();return Number.isFinite(n)?n:null;};
const n=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const rnd=(x,d=2)=>x==null||!Number.isFinite(x)?null:+x.toFixed(d);
const hash=x=>createHash('sha256').update(x).digest('hex');
const SQL=[
 "WITH active AS (SELECT s.broker_connection_id FROM trading.trading_sessions s",
 "JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id",
 "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
 "AND b.deleted_at IS NULL AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.account_currency='USD'",
 "AND b.status='CONNECTED' AND b.authorization_status='ACTIVE'",
 "ORDER BY s.started_at DESC LIMIT 1)",
 "SELECT t.id::text trade_id,t.opened_at,t.closed_at,t.instrument,t.direction,",
 "t.lot_size,t.status,t.path_last_observed_at,t.path_observation_count,",
 "t.max_favorable_pnl,t.profit_giveback,t.realised_pnl,t.commission,t.swap,",
 "t.close_reason,ti.metadata,ca.sizing_inputs FROM trading.trades t",
 "JOIN active a ON a.broker_connection_id=t.broker_connection_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id",
 "LEFT JOIN LATERAL (SELECT ca.sizing_inputs FROM trading.capital_allocations ca",
 "WHERE ca.user_id=t.user_id AND ca.trade_intent_id=t.trade_intent_id",
 "AND ca.created_at<=t.opened_at ORDER BY ca.created_at DESC,ca.id DESC LIMIT 1)ca ON TRUE",
 "WHERE t.user_id=$1 AND t.account_currency='USD'",
 "AND t.opened_at >= $2::timestamptz AND t.status IN ('OPEN','CLOSED')",
 "AND (t.status='OPEN' OR t.closed_at>=current_timestamp-interval '2 hours')",
 "AND ti.metadata->>'multimodel_plan_b_route' IN ('CONFIRMED_REVERSAL','EARLY_TRANSITION')",
 "ORDER BY t.opened_at DESC,t.id DESC LIMIT 151"
].join(' ');
function evaluateCrossing(input) {
 const {risk,fee,peak,current,previous,currentAt,previousAt,observations}=input;
 const old=peakGate({peak,risk,fee,fraction:.5});
 const lower=peakGate({peak,risk,fee,fraction:.25});
 const invalid=!Number.isFinite(current)||!Number.isFinite(previous)||
   !Number.isFinite(currentAt)||!Number.isFinite(previousAt)||
   !Number.isInteger(observations)||observations<3;
 if(invalid||!lower.reached||old.reached)
  return {eligible:false,reason:invalid?'MISSING_CAUSAL_MARKS':
    !lower.reached?'BELOW_RESEARCH_PEAK':'ORIGINAL_050R_RULE_ALREADY_REACHED'};
 const lag=currentAt-previousAt;
 if(lag<=0||lag>20000)return {eligible:false,reason:'UNRELIABLE_OBSERVATION_GAP'};
 const buffer=Math.max(.5,risk*.035,fee*.2),
   executionAllowance=Math.max(risk*.02,fee*.25);
 const floor=Math.max(fee+buffer+executionAllowance,peak*.55);
 if(peak-floor<Math.max(risk*.03,fee*.25))
  return {eligible:false,reason:'NO_MEANINGFUL_RETAINABLE_PEAK'};
 if(!(previous>floor&&current<=floor&&current>0&&previous>current))
  return {eligible:false,reason:'NO_OBSERVED_DESCENDING_CROSSING'};
 if(current-fee<Math.max(.5,fee*.2,risk*.02))
  return {eligible:false,reason:'NO_PROVEN_POSITIVE_EXTRA_RESERVE'};
 return {eligible:true,reason:'OBSERVED_PNL_CROSSING_SHADOW_ONLY',
  hypotheticalFloorBrokerNet:rnd(floor),
  currentBrokerNet:rnd(current),observedPeakBrokerNet:rnd(peak),
  afterExtraReserveNow:rnd(current-fee),
  cannotProveBrokerFill:true,brokerOrders:0};
}
function frozenEntry(row,activatedAt,now) {
 const opened=ms(row.opened_at);
 if(!uuid.test(String(row.trade_id))||opened==null||opened<activatedAt||
   opened>now||row.status!=='OPEN'||now-opened>90000)return null;
 const input=row.sizing_inputs||{},risk=n(input.finalRiskAtStop);
 const lots=n(row.lot_size),historicalFee=n(
   input.demoExecutionRiskEnvelope?.historicalFeePerLot);
 const fee=historicalFee>0&&lots>0?lots*historicalFee:null;
 const route=row.metadata?.multimodel_plan_b_route;
 if(!['CONFIRMED_REVERSAL','EARLY_TRANSITION'].includes(route)||risk<=0||
   !(fee>0)||!(lots>0))return null;
 return {
  tradeId:row.trade_id,route,pair:row.instrument,side:row.direction,
  lots:rnd(lots,4),openedAt:new Date(opened).toISOString(),
  frozenStopRisk:rnd(risk,5),frozenFeeReserve:rnd(fee,5),
  firstObservedAt:new Date(now).toISOString(),
 };
}
function observed(row,now) {
 const currentAt=ms(row.path_last_observed_at),peak=n(row.max_favorable_pnl),
  giveback=n(row.profit_giveback);
 if(currentAt==null||currentAt>now||now-currentAt>35000||
   peak==null||giveback==null||giveback<0)return null;
 return {at:currentAt,peak,current:peak-giveback,
  observations:Number(row.path_observation_count||0)};
}
function append(root,item) {
 const file=path.join(root,item.capturedAt.slice(0,10)+'.jsonl');
 fs.appendFileSync(file,JSON.stringify(item)+'\n',{mode:0o600});
}
function save(root,state) {
 const dest=path.join(root,'state.json'),temp=dest+'.'+process.pid+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(state),{flag:'wx',mode:0o600});
 fs.renameSync(temp,dest);
}
function setup(root,owner,now=Date.now()) {
 if(!uuid.test(owner))throw Error('INVALID_OWNER');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const dest=path.join(root,'activation.json');
 if(!fs.existsSync(dest))fs.writeFileSync(dest,JSON.stringify({
  artifact:ARTIFACT,activatedAt:new Date(now).toISOString(),
  ownerFingerprint:hash(owner),brokerOrderAuthority:'NONE',
  researchOnly:true,changesExecution:false,automaticPromotion:false
 },null,2),{flag:'wx',mode:0o600});
 const marker=JSON.parse(fs.readFileSync(dest,'utf8'));
 if(marker.artifact!==ARTIFACT||marker.ownerFingerprint!==hash(owner)||
   marker.brokerOrderAuthority!=='NONE'||!marker.researchOnly||
   ms(marker.activatedAt)==null||ms(marker.activatedAt)>now)
   throw Error('UNVERIFIED_OR_TAMPERED_SHADOW_ACTIVATION');
 const stateFile=path.join(root,'state.json');
 const state=fs.existsSync(stateFile)?
   JSON.parse(fs.readFileSync(stateFile,'utf8')):{artifact:ARTIFACT,trades:{}};
 if(state.artifact!==ARTIFACT||!state.trades||typeof state.trades!=='object')
   throw Error('INVALID_OBSERVER_STATE');
 return {marker,state};
}
function plan(row,previous,marker,now) {
 const tradeId=String(row.trade_id),events=[];
 const active=previous||{};
 const activatedAt=ms(marker.activatedAt);
 if(!active.entry) {
  const entry=frozenEntry(row,activatedAt,now);
  if(!entry)return {state:active,events};
  active.entry=entry;events.push({stage:'ENROLLED',entry});
 }
 const rawMark=observed(row,now),mark=rawMark&&rawMark.at>=ms(active.entry.openedAt)?rawMark:null,prior=active.mark;
 if(row.status==='OPEN'&&mark&&(!prior||mark.at>prior.at)){
  if(prior && !active.crossing){
   const crossing=evaluateCrossing({
    risk:active.entry.frozenStopRisk,fee:active.entry.frozenFeeReserve,
    peak:mark.peak,current:mark.current,previous:prior.current,
    currentAt:mark.at,previousAt:prior.at,observations:mark.observations,
   });
   if(crossing.eligible){
    active.crossing={...crossing,asOf:new Date(mark.at).toISOString()};
    events.push({stage:'LOW_PEAK_CROSSING_OBSERVED',crossing:active.crossing});
   }
  }
  active.mark=mark;
 }
 if(row.status==='CLOSED'&&!active.settled) {
  const gross=n(row.realised_pnl),commission=n(row.commission),swap=n(row.swap);
  if([gross,commission,swap].every(Number.isFinite)){
   active.settled={netUsd:rnd(gross+commission+swap),
    closeReason:row.close_reason,closedAt:new Date(row.closed_at).toISOString()};
   events.push({stage:'SETTLED',settlement:active.settled});
  }
 }
 return {state:active,events:events.map(e=>({
  artifact:ARTIFACT,tradeId,capturedAt:new Date(now).toISOString(),
  ...e,hasTradeAuthority:false,hasBrokerCloseAuthority:false,
 }))};
}
function summary(state,marker) {
 const trades=Object.values(state.trades).filter(x=>x.entry);
 const settled=trades.filter(x=>x.settled),cross=trades.filter(x=>x.crossing);
 return {artifact:ARTIFACT,generatedAt:new Date().toISOString(),
  activatedAt:marker.activatedAt,
  broker:'pepperstone-ctrader',accountType:'DEMO',currency:'USD',
  enrolled:trades.length,settled:settled.length,observedCrossings:cross.length,
  settledAfterObservedCrossing:cross.filter(x=>x.settled).length,
  crossedAndLaterLost:cross.filter(x=>x.settled?.netUsd<0).length,
  independentTradingDays:new Set(trades.map(x=>x.entry.openedAt.slice(0,10))).size,
  researchOnly:true,brokerOrders:0,modifiesExecution:false,
  lowPeakSignalsNotExecuted:true,estimatedSavedProfit:null,
  evidenceRequirement:'Repeated as-of broker-net crossings across independent market days, quoted broker fill tests, causal commission and real post-cost benefit before changing exits.'};
}
async function read(db,owner,activation){
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='12000ms'");
  const rows=(await db.query(SQL,[owner,activation])).rows;
  if(rows.length>150)throw Error('SHADOW_COHORT_TRUNCATED');
  await db.query('COMMIT');return rows;
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
async function tick(db,root,owner,marker,state,now=Date.now()){
 const rows=await read(db,owner,marker.activatedAt);
 let added=0;
 for(const row of rows){
  const id=String(row.trade_id);
  if(!uuid.test(id))continue;
  const result=plan(row,state.trades[id],marker,now);
  if(!result.state.entry)continue;
  state.trades[id]=result.state;
  for(const e of result.events){append(root,e);added++;}
 }
 save(root,state);
 const rpt=summary(state,marker);
 const file=path.join(root,'latest-summary.json'),temp=file+'.'+process.pid+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(rpt,null,2),{flag:'wx',mode:0o600});
 fs.renameSync(temp,file);
 return {added,...rpt};
}
async function main(){
 if(!process.argv.includes('--watch'))throw Error('RESEARCH_WATCH_FLAG_REQUIRED');
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 const {marker,state}=setup(ROOT,owner);
 const {Client}=require('pg');
 let busy=false;
 async function scan(){
  if(busy)return;busy=true;let db;
  try{
   db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    connectionTimeoutMillis:6000,statement_timeout:12000,
    application_name:'irexpro-owner-demo-low-peak-research-only'});
   await db.connect();
   const result=await tick(db,ROOT,owner,marker,state);
   if(result.added)console.log('LOW_PEAK_RESEARCH_EVENTS '+JSON.stringify({
    at:result.generatedAt,added:result.added,enrolled:result.enrolled,
    crossing:result.observedCrossings,settled:result.settled}));
  }catch(e){console.error('LOW_PEAK_RESEARCH_DEFERRED',
    String(e?.message||e).slice(0,180))}
  finally{await db?.end().catch(()=>{});busy=false;}
 }
 await scan();setInterval(()=>void scan(),8000);
 console.log('LOW_PEAK_RESEARCH_ONLY_READY '+marker.activatedAt);
}
module.exports={ARTIFACT,SQL,evaluateCrossing,frozenEntry,observed,setup,plan,summary,read,tick};
if(require.main===module)main().catch(e=>{
 console.error('LOW_PEAK_RESEARCH_START_FAILED',String(e?.message||e).slice(0,180));
 process.exitCode=1;
});
