#!/usr/bin/env node
'use strict';
/**
 * Owner Pepperstone USD DEMO. Prospective, read-only USD common factor.
 * A target never contributes to its own factor. No model/trading authority.
 *
 * Explicitly freeze new activation, log decision-time factor states before
 * future market bars, and attach 5m/15m outcomes later. Missing quote =>
 * unavailable, NEVER silently scored as a correct forecast.
 */
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {PAIRS,toBars,barsFor,factorAt,outcome,q}=require('./audit-owner-demo-usd-crosspair-factor.cjs');
const ROOT='/home/lightworld/webapps/irexpro-research/usd-common-factor/forward';
const ARTIFACT='owner-pepperstone-usd-common-factor-prospective-shadow-v1';
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN=60000, FIVE=300000;
const ms=x=>{const y=new Date(x).getTime();return Number.isFinite(y)?y:null;};
const fingerprint=s=>createHash('sha256').update(s).digest('hex');
const readableNumber=x=>Number.isFinite(x)?+x.toFixed(4):null;
const maxSignalAge=55*MIN;
function freeze(root,owner,connectionId,now){
 if(!idPattern.test(owner)||!idPattern.test(connectionId)||
    !Number.isFinite(now))throw Error('INVALID_OWNER_BROKER_OR_TIME');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const file=path.join(root,'activation.json'),
  binding=fingerprint(owner+'/'+connectionId);
 if(!fs.existsSync(file)){
  fs.writeFileSync(file,JSON.stringify({
   artifact:ARTIFACT,activatedAt:new Date(now).toISOString(),
   ownerBrokerBinding:binding,brokerOrderAuthority:'NONE',
   researchOnly:true,modifiesExecution:false,
   changesRiskGates:false,autoPromotionAllowed:false,
  },null,2),{mode:0o600,flag:'wx'});
 }
 const marker=JSON.parse(fs.readFileSync(file,'utf8'));
 if(marker.artifact!==ARTIFACT||marker.ownerBrokerBinding!==binding||
    marker.brokerOrderAuthority!=='NONE'||marker.researchOnly!==true||
    ms(marker.activatedAt)==null||ms(marker.activatedAt)>now)
    throw Error('RESEARCH_ACTIVATION_OR_BROKER_MISMATCH');
 const stateFile=path.join(root,'state.json');
 const state=fs.existsSync(stateFile)?
  JSON.parse(fs.readFileSync(stateFile,'utf8')):
  {artifact:ARTIFACT,slots:{},updatedAt:null};
 if(state.artifact!==ARTIFACT||!state.slots||
   typeof state.slots!=='object'||Array.isArray(state.slots))
   throw Error('INVALID_RESEARCH_STATE');
 return {marker,state};
}
function append(root,record){
 const file=path.join(root,record.recordedAt.slice(0,10)+'.jsonl');
 fs.appendFileSync(file,JSON.stringify(record)+'\n',{mode:0o600});
}
function atomicJson(file,obj){
 const tmp=file+'.'+process.pid+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(obj,null,2),{mode:0o600,flag:'wx'});
 fs.renameSync(tmp,file);
}
function signalAt(bars,target,t){
 const history=barsFor(t,bars.get(target));
 const f=factorAt(bars,target,t);
 if(!history||!f)return {
  state:'DATA_UNAVAILABLE',target,slotAt:new Date(t).toISOString(),
  noExecutionAuthority:true};
 const state=f.state;
 return {target,slotAt:new Date(t).toISOString(),
  state,rawUsdSide:f.rawSide??null,
  impliedDirection:f.consensusPairDirection??null,
  independentPeers:f.peerCount??0,
  independentAgreement:f.agreement??null,
  medianUsdStrengthBps:f.usdMedianBps??null,
  excludedOwnPair:f.targetExcluded===true,
  evidencePairs:(f.peer||[]).map(p=>p.pair),
  isActionableTradingInstruction:false,
  noExecutionAuthority:true};
}
function scoreSlot(record,bars,horizon){
 if(![5,15].includes(horizon)||!record||!record.impliedDirection||
    !['USD_STRONG','USD_WEAK'].includes(record.state)||
    record.noExecutionAuthority!==true)return null;
 const t=ms(record.slotAt);
 const f={
  state:record.state,
  consensusPairDirection:record.impliedDirection,
 };
 const label=outcome(bars,record.target,t,horizon,f);
 return label?{...label,horizon,verifiedAt:new Date().toISOString(),
  benchmarkOnly:true,brokerOrders:0}:null;
}
function summarize(state,marker){
 const slots=Object.values(state.slots);
 const eligible=slots.filter(s=>['USD_STRONG','USD_WEAK'].includes(s.state));
 const score=h=>{
  const results=eligible.flatMap(s=>s['outcome'+h]?[
   {slot:s,...s['outcome'+h]}]:[]);
  const wins=results.filter(x=>x.directionalCorrect).length;
  const gross=results.reduce((a,x)=>a+x.directionalChangeBps,0);
  const spread=results.reduce((a,x)=>a+x.afterIndicativeSpreadOnlyBps,0);
  return {matchedSignals:results.length,correct:wins,
   incorrect:results.length-wins,
   accuracy:results.length?readableNumber(wins/results.length):null,
   meanDirectionalBps:results.length?readableNumber(gross/results.length):null,
   meanAfterSpreadOnlyBps:results.length?readableNumber(spread/results.length):null,
   independentUtcDays:new Set(results.map(x=>x.slot.slotAt.slice(0,10))).size,
  };
 };
 return {artifact:ARTIFACT,generatedAt:new Date().toISOString(),
  activatedAt:marker.activatedAt,broker:'pepperstone-ctrader',
  accountType:'DEMO',currency:'USD',
  slotsObserved:slots.length,signalsWithStrongUsdConsensus:eligible.length,
  unavailable:slots.filter(x=>x.state==='DATA_UNAVAILABLE'||
    x.state==='INSUFFICIENT_INDEPENDENT_PEERS').length,
  noStrongConsensus:slots.filter(x=>x.state==='NO_STRONG_CONSENSUS').length,
  latestSignals:eligible.slice(-10).map(x=>({
   pair:x.target,at:x.slotAt,usdState:x.state,
   impliedDirection:x.impliedDirection,
   medianStrengthBps:x.medianUsdStrengthBps,
   peers:x.independentPeers,agreement:x.independentAgreement,
  })),
  forward5Minutes:score(5),forward15Minutes:score(15),
  researchOnly:true,brokerOrders:0,changesExecution:false,
  changesRiskGates:false,changesLots:false,autoPromote:false,
  profitFromSignals:null,
  note:'Independent pairs are excluded from their own predictions. Future labels are attached only after completed candles; quote-only direction is not a broker order or after-cost profitability.',
 };
}
async function snapshot(db,owner) {
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='16000ms'");
  const scope=(await db.query(q.scope,[owner])).rows[0];
  if(!scope)throw Error('OWNER_FULL_AUTO_USD_DEMO_UNAVAILABLE');
  const now=ms(scope.snapshot_at),from=new Date(now-48*MIN).toISOString();
  const rows=(await db.query(q.candles,[
   scope.connection_id,PAIRS,from,scope.snapshot_at])).rows;
  if(rows.length>700)throw Error('FORWARD_BROKER_CANDLES_TRUNCATED');
  await db.query('COMMIT');
  return {scope,asOf:scope.snapshot_at,...toBars(rows,scope.snapshot_at)};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
function plan({state,marker,asOf,bars}){
 const now=ms(asOf),activated=ms(marker.activatedAt),newEvents=[];
 if(now==null||activated==null||now<activated)throw Error('INVALID_ASOF');
 // Each target is sampled at most once per five-minute completed bar.
 // t is the latest five-minute-aligned bar that has actually completed.
 const t=Math.floor((now-MIN-3000)/FIVE)*FIVE;
 if(t>=activated&&now-(t+MIN)<=2*MIN){
  for(const target of PAIRS){
   const key=target+'_'+new Date(t).toISOString();
   if(state.slots[key])continue;
   const signal=signalAt(bars,target,t);
   state.slots[key]={...signal,recordedAt:new Date(now).toISOString()};
   newEvents.push({artifact:ARTIFACT,kind:'SIGNAL',
    ...state.slots[key],researchOnly:true,brokerOrders:0});
  }
 }
 for(const [key,rec] of Object.entries(state.slots)){
  const at=ms(rec.slotAt);
  if(at==null||!['USD_STRONG','USD_WEAK'].includes(rec.state))continue;
  for(const horizon of [5,15]){
   const field='outcome'+horizon;
   if(rec[field])continue;
   if(now<at+(horizon+1)*MIN+3000)continue;
   if(now-at>maxSignalAge){
    rec[field]={state:'MISSING_MATURE_CAUSAL_QUOTES',horizon,
     brokerOrders:0,directionalCorrect:null};
   }else{
    const label=scoreSlot(rec,bars,horizon);
    if(!label)continue;
    rec[field]=label;
   }
   newEvents.push({artifact:ARTIFACT,kind:'OUTCOME',
    target:rec.target,slotAt:rec.slotAt,
    horizon,result:rec[field],recordedAt:new Date(now).toISOString(),
    brokerOrders:0,researchOnly:true});
  }
 }
 return {state,newEvents,report:summarize(state,marker)};
}
async function step(db,root,owner,now=Date.now()){
 const snap=await snapshot(db,owner);
 // One causal clock source: the exact read-only DB snapshot timestamp.
 // Using a later process clock to activate would spuriously make the
 // first snapshot appear to predate activation.
 const {marker,state}=freeze(root,owner,snap.scope.connection_id,ms(snap.asOf));
 const result=plan({...snap,state,marker});
 // Never write research files inside the read-only database transaction.
 for(const rec of result.newEvents)append(root,rec);
 state.updatedAt=new Date(now).toISOString();
 atomicJson(path.join(root,'state.json'),state);
 atomicJson(path.join(root,'latest-summary.json'),result.report);
 return {count:result.newEvents.length,report:result.report};
}
async function main(){
 if(!process.argv.includes('--watch'))throw Error('RESEARCH_WATCH_FLAG_REQUIRED');
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg'),owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!idPattern.test(owner||''))throw Error('MISSING_CONFIGURED_OWNER');
 let busy=false;
 async function run(){
  if(busy)return;busy=true;
  let db=null;
  try{
   db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
    database:process.env.DB_NAME,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    connectionTimeoutMillis:7000,statement_timeout:16000,
    application_name:'irexpro-usd-factor-forward-shadow-readonly'});
   await db.connect();
   const r=await step(db,ROOT,owner);
   if(r.count)console.log('USD_FACTOR_SHADOW_EVENTS '+JSON.stringify({
    at:r.report.generatedAt,newEvents:r.count,
    observed:r.report.slotsObserved,signals:r.report.signalsWithStrongUsdConsensus,
    fiveMinuteOutcomes:r.report.forward5Minutes.matchedSignals,
    brokerOrders:0}));
  }catch(error){
   console.error('USD_FACTOR_SHADOW_DEFERRED',
    String(error?.message||error).slice(0,220));
  }finally{await db?.end().catch(()=>{});busy=false;}
 }
 await run();
 setInterval(()=>void run(),45000);
 console.log('USD_FACTOR_SHADOW_READ_ONLY_READY');
}
module.exports={ARTIFACT,ROOT,freeze,signalAt,scoreSlot,summarize,snapshot,plan,step};
if(require.main===module)main().catch(error=>{
 console.error('USD_FACTOR_SHADOW_START_FAILED',
  String(error?.message||error).slice(0,220));process.exitCode=1;
});
