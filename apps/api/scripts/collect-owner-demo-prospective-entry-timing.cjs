'use strict';
/**
 * Append-only, research-only prospective Pepperstone USD DEMO entry tracker.
 *
 * Enrolls ONLY owner trades observed OPEN within 90 seconds of execution
 * AFTER this collector's own immutable activation timestamp. Freezes the
 * original trade-intent and causal pre-intent quote context, followed by
 * on-time +60s shadow decision and +1/+3/+5/+10/+20/+30m market observations.
 * Missed stages stay MISSED, never reconstructed later using hindsight.
 *
 * No broker adapter, order, model, risk-gate or trade-execution imports.
 */
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {writeSummary}=require('./audit-owner-demo-prospective-entry-outcomes.cjs');
const {
 parseLine,asOfFeatures,afterOpenMark,
}=require('./audit-pepperstone-asof-entry-context-net.cjs');
const {evaluateFrozenCheckpoint,evaluateCheckpointMark}=require('./owner-demo-entry-timing-checkpoint-shadow.cjs');
const {latestTail}=require('./collect-owner-demo-forming-candle-snapshots.cjs');
const ARTIFACT='irexpro-prospective-owner-demo-frozen-entry-timing-v1';
const ROOT='/home/lightworld/webapps/irexpro-research/prospective-entry-timing';
const QUOTE_ROOT='/home/lightworld/webapps/irexpro-research/native-quote-snapshots';
const MS=60000;
const TAIL_BYTES=512*1024;
const MAX_ROWS=250;
const SCOPE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES=[
 ['CHECKPOINT_60S',60000,40000],
 ['MARK_1M',60000,40000],
 ['MARK_3M',180000,40000],
 ['MARK_5M',300000,40000],
 ['MARK_10M',600000,40000],
 ['MARK_20M',1200000,40000],
 ['MARK_30M',1800000,40000],
];
const SQL=[
 "SELECT t.id::text trade_key,t.instrument,t.direction,t.opened_at,t.closed_at,",
 "t.status,t.fill_price,t.stop_loss,t.take_profit,t.lot_size,t.realised_pnl,",
 "t.commission,t.swap,ti.created_at intent_at,ti.metadata metadata,",
 "ca.created_at allocation_at,",
 "ca.sizing_inputs->>'finalRiskAtStop' as risk_at_stop",
 "FROM trading.trades t",
 "JOIN broker.broker_connections b ON b.id=t.broker_connection_id",
 "AND b.user_id=t.user_id",
 "JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id",
 "AND ti.user_id=t.user_id AND ti.broker_connection_id=t.broker_connection_id",
 "LEFT JOIN LATERAL (SELECT c.created_at,c.sizing_inputs",
 "FROM trading.capital_allocations c WHERE c.trade_intent_id=ti.id",
 "AND c.created_at<=t.opened_at ORDER BY c.created_at DESC LIMIT 1) ca ON true",
 "WHERE t.user_id=$1 AND b.user_id=$1",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.deleted_at IS NULL AND t.account_currency='USD'",
 "AND t.opened_at >= $2::timestamptz",
 "AND t.opened_at >= $3::timestamptz - interval '18 hours'",
 "AND t.opened_at <= $3::timestamptz",
 "AND ti.metadata->>'multimodel_plan_b_route' IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
 "AND t.instrument IN ('EURUSD','AUDUSD','USDJPY','USDCAD')",
 "ORDER BY t.opened_at DESC LIMIT 251",
].join(' ');
const num=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ts=x=>x==null?NaN:new Date(x).getTime();
const name=x=>new Date(x).toISOString().slice(0,10);
const round=(v,k=4)=>Number(v.toFixed(k));
const sign=x=>x==='BUY'?1:x==='SELL'?-1:0;
function normalize(row){
 const m=row.metadata||{},sgn=sign(row.direction);
 const openedAt=ts(row.opened_at),intentAt=ts(row.intent_at),
  closed=ts(row.closed_at),entry=num(row.fill_price),
  stop=num(row.stop_loss),tp=num(row.take_profit);
 if(!SCOPE.test(String(row.trade_key))||!sgn||
  !Number.isFinite(openedAt)||!Number.isFinite(intentAt)||
  intentAt>openedAt||openedAt-intentAt>120000||
  entry===null||stop===null||tp===null||
  !(entry>0&&stop>0&&tp>0)||
  sgn*(entry-stop)<=0||sgn*(tp-entry)<=0)
  return {valid:false,reason:'INVALID_OR_INCOMPLETE_ENTRY_PROVENANCE'};
 return {
  valid:true,tradeKey:String(row.trade_key),
  instrument:row.instrument,direction:row.direction,sgn,
  openedAt,intentAt,closedAt:Number.isFinite(closed)?closed:Infinity,
  entry,stop,tp,lotSize:num(row.lot_size),
  route:m.multimodel_plan_b_route,plannedEntry:num(m.signal_suggested_entry_price),
  expectedNetR:num(m.multimodel_governance_net_expected_r),
  m1TacticalRoute:m.m1_tactical_route||null,
  expertState:m.multimodel_trained_expert_state||null,
  expertVotesFor:num(row.direction==='BUY'?
   m.multimodel_trained_expert_long_votes:m.multimodel_trained_expert_short_votes),
  expertVotesAgainst:num(row.direction==='BUY'?
   m.multimodel_trained_expert_short_votes:m.multimodel_trained_expert_long_votes),
  authority:m.multimodel_execution_authority_path||null,
  riskAtStop:num(row.risk_at_stop),
  modelPolicy:m.m1_policy_version||null,
 };
}
function readQuotesAt(now,dir=QUOTE_ROOT){
 const days=new Set([name(now),name(now-6*MS)]);
 const map={EURUSD:[],AUDUSD:[],USDJPY:[],USDCAD:[]};
 for(const day of days){
  const file=path.join(dir,day+'.jsonl');
  for(const line of latestTail(file,TAIL_BYTES).split('\n')){
   if(!line||line.length>280)continue;
   let raw;try{raw=JSON.parse(line)}catch{continue;}
   const q=parseLine(raw);if(q)map[raw[2]].push(q);
  }
 }
 for(const pair of Object.keys(map)){
  map[pair].sort((a,b)=>a.at-b.at||a.observed-b.observed);
  const dedup=[];
  for(const q of map[pair]){
   if(dedup.length&&dedup.at(-1).at===q.at)continue;
   dedup.push(q);
  }
  map[pair]=dedup;
 }
 return map;
}
function stageKey(tradeKey,stage){return tradeKey+'|'+stage}
function event(tradeKey,stage,at,data={}){
 return {artifact:ARTIFACT,tradeKey,stage,
  capturedAt:new Date(at).toISOString(),researchOnly:true,
  noTradeAuthority:true,modifiesExecution:false,modifiesLotSize:false,...data};
}
function plan(row,seen,now){
 const key=String(row.trade_key),opened=ts(row.opened_at);
 if(!SCOPE.test(key)||!Number.isFinite(opened))return [];
 const enrolled=seen.has(stageKey(key,'ENTRY'));
 const rejected=seen.has(stageKey(key,'ENTRY_REJECTED'))||
  seen.has(stageKey(key,'ENTRY_MISSED'));
 if(!enrolled){
  if(rejected)return [];
  if(now-opened<0)return [];
  if(now-opened>90000||row.status!=='OPEN')
   return [event(key,'ENTRY_MISSED',now,
    {reason:now-opened>90000?'LATE_FIRST_CAPTURE':'NOT_OPEN_AT_FIRST_CAPTURE'})];
  const t=normalize(row);
  if(!t.valid)return [event(key,'ENTRY_REJECTED',now,{reason:t.reason})];
  return [{kind:'ENTRY',trade:t}];
 }
 const actions=[];
 for(const [stage,age,window] of STAGES){
  if(seen.has(stageKey(key,stage))||
     seen.has(stageKey(key,stage+'_MISSED')))continue;
  // Both evaluators require +10s maturity: never irreversibly record NOT_MATURED.
  if(now<opened+age+10000)continue;
  if(now>opened+age+window){
   actions.push(event(key,stage+'_MISSED',now,{reason:'CAPTURE_DEADLINE_EXCEEDED'}));
   continue;
  }
  actions.push({kind:stage});
 }
 if(row.status==='CLOSED'&&!seen.has(stageKey(key,'SETTLED'))){
  const gross=num(row.realised_pnl),fee=num(row.commission),swap=num(row.swap);
  if(gross!==null&&fee!==null&&swap!==null){
   actions.push(event(key,'SETTLED',now,{
    settledNetUsd:round(gross+fee+swap,2),grossUsd:round(gross,2),
    commissionUsd:round(fee,2),swapUsd:round(swap,2),
    actualCloseAt:row.closed_at,
    eventualOutcomeOnly:true,source:'CLOSED_SETTLED_BROKER_TRADE',
   }));
  }
 }
 return actions;
}
function derive(row,action,quotes,now){
 const key=String(row.trade_key);
 if(!action.kind)return action;
 const t=normalize(row);
 if(!t.valid)return event(key,action.kind+'_MISSED',now,{reason:t.reason});
 const qs=quotes[t.instrument]??[];
 if(action.kind==='ENTRY'){
  return event(key,'ENTRY',now,{
   openedAt:new Date(t.openedAt).toISOString(),
   intentAt:new Date(t.intentAt).toISOString(),
   instrument:t.instrument,direction:t.direction,route:t.route,
   originalPlannedEntry:t.plannedEntry,actualBrokerEntry:t.entry,
   originalStop:t.stop,originalTakeProfit:t.tp,
   lots:t.lotSize,expectedNetR:t.expectedNetR,
   capitalAllocationRiskUsd:t.riskAtStop,
   m1TacticalRoute:t.m1TacticalRoute,
   trainedExpertState:t.expertState,trainedExpertVotesFor:t.expertVotesFor,
   trainedExpertVotesAgainst:t.expertVotesAgainst,
   originalExecutionAuthority:t.authority,modelPolicy:t.modelPolicy,
   causalPreIntentQuote:asOfFeatures(t,qs),
   onlyOriginalPreOrderFeatures:true,
   noOutcomeAtEntryCaptured:true,
  });
 }
 if(action.kind==='CHECKPOINT_60S'){
  const checkpoint=evaluateFrozenCheckpoint(t,qs,asOfFeatures,now);
  return event(key,action.kind,now,{
   checkpoint,decidedAt:new Date(t.openedAt+MS).toISOString(),
   cannotClaimBrokerAmendOrFill:true,
  });
 }
 const minute=Number(action.kind.match(/^MARK_(\d+)M$/)?.[1]);
 if(![1,3,5,10,20,30].includes(minute))throw Error('UNEXPECTED_RESEARCH_STAGE');
 const observation=afterOpenMark(t,qs,minute,now);
 return event(key,action.kind,now,{
  checkpointOffsetMinutes:minute,
  actualTradeWasClosedBeforeMarketMark:
   Number.isFinite(t.closedAt)&&t.closedAt<=t.openedAt+minute*MS,
  observation,onlyBrokerSideMarketMark:true,
  noHypotheticalBrokerFill:true,
 });
}
function loadActivation(root,owner,now){
 if(!SCOPE.test(owner))throw Error('INVALID_OWNER_SCOPE');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const file=path.join(root,'activation.json');
 const expected=createHash('sha256').update(owner).digest('hex');
 let marker;
 try{
  const fd=fs.openSync(file,'wx',0o600);
  marker={artifact:ARTIFACT,activatedAt:new Date(now).toISOString(),
   ownerFingerprint:expected,executionAuthority:'NONE',
   originalModelAndLotPermissionsUnchanged:true};
  try{fs.writeFileSync(fd,JSON.stringify(marker,null,2))}
  finally{fs.closeSync(fd)}
 }catch(e){
  if(e.code!=='EEXIST')throw e;
  marker=JSON.parse(fs.readFileSync(file,'utf8'));
 }
 if(marker.artifact!==ARTIFACT||marker.ownerFingerprint!==expected||
  !Number.isFinite(ts(marker.activatedAt))||ts(marker.activatedAt)>now)
  throw Error('UNTRUSTED_OR_MISMATCHED_PROSPECTIVE_ACTIVATION');
 return marker;
}
function recover(root,now){
 const seen=new Set();
 for(const offset of [1,0]){
  const day=name(now-offset*86400000);
  const file=path.join(root,day+'.jsonl');
  if(!fs.existsSync(file))continue;
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>12*1024*1024)
   throw Error('INVALID_RESTART_RECOVERY_JOURNAL');
  // Restart dedup must scan the WHOLE bounded day: tail-only scanning
  // could silently forget stages earlier in a busy trading session.
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
   if(!line.trim())continue;
   let r;try{r=JSON.parse(line)}catch{continue}
   if(r.artifact===ARTIFACT&&SCOPE.test(String(r.tradeKey))&&
    typeof r.stage==='string')seen.add(stageKey(r.tradeKey,r.stage));
  }
 }
 return seen;
}
function append(root,e,seen){
 const key=stageKey(e.tradeKey,e.stage);
 if(seen.has(key))return false;
 const file=path.join(root,name(e.capturedAt)+'.jsonl');
 if(fs.existsSync(file)&&fs.statSync(file).size>12*1024*1024)
  throw Error('PROSPECTIVE_DAILY_LOG_SIZE_CAP');
 fs.appendFileSync(file,JSON.stringify(e)+'\n',{encoding:'utf8',mode:0o600,flag:'a'});
 seen.add(key);
 return true;
}
function prune(root,now,retainDays=45){
 for(const entry of fs.readdirSync(root)){
  if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))continue;
  if(ts(entry.slice(0,10)+'T00:00:00Z')<now-retainDays*86400000)
   fs.unlinkSync(path.join(root,entry));
 }
}
async function readCandidates(client,owner,activatedAt,now){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='12000ms'");
  const rows=(await client.query(SQL,[owner,activatedAt,
   new Date(now).toISOString()])).rows;
  if(rows.length>MAX_ROWS)throw Error('PROSPECTIVE_COHORT_ROW_LIMIT');
  await client.query('COMMIT');
  return rows;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
}
async function tick({client,owner,marker,root,seen,now=Date.now(),
 quoteLoader=readQuotesAt}){
 const rows=await readCandidates(client,owner,marker.activatedAt,now);
 const tasks=[];
 for(const row of rows){
  const actions=plan(row,seen,now);
  for(const action of actions)tasks.push({row,action});
 }
 if(!tasks.length)return {observed:rows.length,events:0,states:{}};
 const needsQuotes=tasks.some(t=>!!t.action.kind);
 const quotes=needsQuotes?quoteLoader(now):{};
 const stats={};
 let added=0;
 for(const {row,action} of tasks){
  const e=derive(row,action,quotes,now);
  if(append(root,e,seen)){added++;stats[e.stage]=(stats[e.stage]||0)+1;}
 }
 return {observed:rows.length,events:added,states:stats};
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const {getDatabaseSslOptions}=require('../dist/config/database-tls');
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 const marker=loadActivation(ROOT,owner,Date.now());
 const seen=recover(ROOT,Date.now());
 const c=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-prospective-entry-observational-readonly',
  statement_timeout:12000});
 await c.connect();
 writeSummary(ROOT,Date.now());
 let busy=false,stopped=false,ticks=0,totals=0;
 const step=async()=>{
  if(stopped||busy)return;
  busy=true;try{
   const r=await tick({client:c,owner,marker,root:ROOT,seen});
   ticks++;totals+=r.events;
   if(r.events||ticks%20===0)writeSummary(ROOT,Date.now());
   if(r.events||ticks%20===0)console.log('PROSPECTIVE_ENTRY_TRACKER',
    JSON.stringify({at:new Date().toISOString(),
     tradesObserved:r.observed,newEvents:r.events,
     stages:r.states,totalNewEvents:totals,
     researchOnly:true,brokerOrders:0,sqlWrites:0}));
   if(ticks%240===0)prune(ROOT,Date.now());
  }catch(e){console.error('PROSPECTIVE_ENTRY_RESEARCH_DEFERRED',
    String(e.message).slice(0,160))}
  finally{busy=false}
 };
 console.log('PROSPECTIVE_ENTRY_STUDY_ACTIVATED',
  JSON.stringify({activatedAt:marker.activatedAt,previousSeen:seen.size,
   researchOnly:true,modifiesExecution:false,brokerOrders:0}));
 await step();
 if(!process.argv.includes('--watch')){await c.end();return}
 const timer=setInterval(step,12000);
 const stop=async()=>{
  stopped=true;clearInterval(timer);
  while(busy)await new Promise(r=>setTimeout(r,100));
  await c.end().catch(()=>{});process.exit(0);
 };
 process.once('SIGTERM',()=>void stop());
 process.once('SIGINT',()=>void stop());
}
module.exports={ARTIFACT,SQL,STAGES,normalize,readQuotesAt,stageKey,event,
 plan,derive,loadActivation,recover,append,prune,readCandidates,tick};
if(require.main===module)main().catch(e=>{
 console.error('PROSPECTIVE_ENTRY_TRACKER_FATAL',String(e.message).slice(0,190));
 process.exitCode=1;
});
