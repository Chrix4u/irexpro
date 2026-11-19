'use strict';
/**
 * User-owned Pepperstone USD DEMO no-trade forensics, no execution authority.
 * Classifies the scanner's original decision records as recorded. Does not
 * equate a research blocker with the actual effective order-dispatch gate.
 * Does not change any feature flag or write to the trading DB.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='owner-pepperstone-demo-entry-blockade-diagnostic-v1';
const OUT='/home/lightworld/webapps/irexpro-research/entry-blockade/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[89ab0-9a-f]{12}$/i;
const LIMIT=2400,AGE_MS=3*3600000,TWO_HOURS=120*60000;
const DECISIONS_SQL=[
 "SELECT d.evaluated_at,d.instrument,d.direction,d.route,d.blockers,",
 "d.governance->'multimodelEnsemble' AS ensemble,",
 "d.governance->'multimodelGovernance' AS governance,",
 "d.governance->'multimodelAuthority' AS authority,",
 "d.governance->'demoAlternativeTrial' AS alternative,",
 "d.governance->'portfolioNetLossBrake' AS portfolio_brake,",
 "d.governance->'multimodelLossStreakBrake' AS strategy_brake,",
 "d.governance->'ownerLossPausePolicy' AS owner_pause_policy,",
 "d.governance->'demoContinuationPause' AS continuation_pause,",
 "d.governance->'demoBrokerCommissionGate' AS commission_gate",
 "FROM trading.m1_tactical_decisions d",
 "JOIN broker.broker_connections b ON b.id=d.broker_connection_id",
 "AND b.user_id=d.user_id",
 "WHERE d.user_id=$1 AND b.user_id=$1",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND d.evaluated_at>=$2::timestamptz AND d.evaluated_at<=$3::timestamptz",
 "ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 2401",
].join(' ');
const SETTLEMENTS_SQL=[
 "SELECT t.opened_at,t.closed_at,t.instrument,t.direction,t.close_reason,",
 "t.realised_pnl,t.commission,t.swap,t.status",
 "FROM trading.trades t",
 "JOIN broker.broker_connections b ON b.id=t.broker_connection_id",
 "AND b.user_id=t.user_id",
 "JOIN trading.trading_sessions s ON s.id=t.trading_session_id",
 "AND s.user_id=t.user_id AND s.broker_connection_id=t.broker_connection_id",
 "WHERE t.user_id=$1 AND b.user_id=$1",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD'",
 "AND s.execution_mode='FULL_AUTO' AND t.status='CLOSED'",
 "AND t.closed_at <= $2::timestamptz",
 "AND t.closed_at >= $2::timestamptz-interval '6 hours'",
 "ORDER BY t.closed_at DESC,t.id DESC LIMIT 6",
].join(' ');
const ORDERS_SQL=[
 "SELECT COUNT(*)::int n,MAX(ti.created_at) latest,",
 "COUNT(*) FILTER(WHERE ti.created_at > $4::timestamptz)::int since_latest_close",
 "FROM trading.trade_intents ti",
 "JOIN broker.broker_connections b ON b.id=ti.broker_connection_id",
 "AND b.user_id=ti.user_id",
 "WHERE ti.user_id=$1 AND b.user_id=$1",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND ti.created_at >= $2::timestamptz AND ti.created_at <= $3::timestamptz",
].join(' ');
const ts=v=>v==null?NaN:new Date(v).getTime();
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const money=v=>Math.round(v*100)/100;
const pct=v=>Math.round(v*10000)/100;
const infoList=a=>Array.isArray(a)?a.filter(x=>typeof x==='string'):[];
function eligiblePath(row){
 const model=row.ensemble||{},governance=row.governance||{},
  authority=row.authority||{},alt=row.alternative||{};
 const route=model.strategyRoute??null;
 const altEligible=alt.eligible===true&&alt.continuousEvidence===true&&
  alt.artifact==='pepperstone-demo-advisory-alternate-bridge-v1'&&
  ['EARLY_TRANSITION','CONFIRMED_REVERSAL'].includes(route);
 const primaryEligible=authority.executable===true&&
  authority.authorityPath==='PRIMARY_PLAN_B';
 return {
  route,altEligible,primaryEligible,
  modelPaperAdmitted:model.paperAdmitted===true,
  governancePaperEligible:governance.paperExecutionEligible===true,
  // A second authority's M1 route-label mismatch may be informational
  // when the separately verified continuous alternate is eligible.
  duplicateLabelMismatchAdvisory:
   altEligible&&infoList(row.blockers).some(x=>
    x==='MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED'||
    x==='MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED'),
  // A recorded model loss is not an effective veto when the verified owner
  // DEMO session has opted into advisory-only loss-pause policy.
  portfolioBrakeActive:row.portfolio_brake?.active===true,
  strategyBrakeActive:row.strategy_brake?.active===true,
  portfolioBrakeBlocks:infoList(row.blockers).includes('M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE'),
  strategyBrakeBlocks:infoList(row.blockers).includes('M1_MULTIMODEL_LOSS_STREAK_BRAKE'),
  ownerAdvisoryOnly:row.owner_pause_policy?.advisoryOnly===true,
 };
}
function settled(row){
 const a=num(row.realised_pnl),b=num(row.commission),c=num(row.swap);
 if(a===null||b===null||c===null)return null;
 return money(a+b+c);
}
function inferPortfolioBrake(closes,at){
 const sorted=[...closes].sort((a,b)=>ts(b.closed_at)-ts(a.closed_at));
 const latest=sorted[0],latestAt=ts(latest?.closed_at);
 const last3=sorted.slice(0,3),net=last3.map(settled);
 if(!Number.isFinite(latestAt))return {
  state:'NO_RECENT_FULL_AUTO_SETTLEMENT',latestClosedAt:null,
  potentialBrakeEndsAt:null,remainingSeconds:null,
  latestThreeNegative:null,
 };
 const negative=last3.length>=3&&net.every(x=>x!==null&&x<0);
 const in6h=at-latestAt<=6*3600000&&at>=latestAt;
 const ends=latestAt+TWO_HOURS;
 const active=negative&&in6h&&at<ends;
 return {
  state:active?'CONFIRMED_THREE_LOSSES_120M_GUARD':
   negative?'THREE_LOSSES_BUT_TIME_GATE_EXPIRED':'LAST_THREE_NOT_ALL_LOSSES',
  latestClosedAt:new Date(latestAt).toISOString(),
  latestThreeNegative:negative,
  lastThreeNetUsd:net,
  lastThreeNetSumUsd:net.every(x=>x!==null)?money(net.slice(0,3).reduce((s,x)=>s+x,0)):null,
  potentialBrakeEndsAt:negative?new Date(ends).toISOString():null,
  remainingSeconds:active?Math.ceil((ends-at)/1000):0,
  sixHourLookbackRequired:true,
 };
}
function summarize(decisions,closes,orders,now=new Date()){
 const current=ts(now);
 if(!Number.isFinite(current))throw Error('INVALID_CURRENT_TIME');
 const blocking={};
 const byModelRoute={};
 const bySelectedAlternateReason={};
 const byActiveSafety={portfolioBrake:0,strategyBrake:0};
 const byEffectiveSafety={portfolioBrake:0,strategyBrake:0};
 let observed=0,eligibleAlternative=0,eligiblePrimary=0,eligibleRoute=0,
  altBlockedByPortfolio=0,altBlockedByStrategy=0,
  altEffectivelyBlockedByPortfolio=0,altEffectivelyBlockedByStrategy=0,
  ownerAdvisoryDecisions=0;
 let latestDecision=null,latestEligible=null,latestPortfolioBrake=null,
  latestOwnerPausePolicy=null;
 let decisionsSinceLatestClose=0,alternateEligibleSinceLatestClose=0,
  alternateBrakeSinceLatestClose=0;
 const lastClosedAt=closes.reduce((best,r)=>{
  const at=ts(r.closed_at);return Number.isFinite(at)&&at>best?at:best;
 },-Infinity);
 for(const row of decisions){
  const d=ts(row.evaluated_at);
  if(!Number.isFinite(d)||d>current||d<current-AGE_MS)continue;
  observed++;
  if(!latestDecision||d>ts(latestDecision))latestDecision=row.evaluated_at;
  const state=eligiblePath(row),route=state.route||'UNVERIFIED';
  byModelRoute[route]=(byModelRoute[route]||0)+1;
  if(d>lastClosedAt){
   decisionsSinceLatestClose++;
   if(state.altEligible)alternateEligibleSinceLatestClose++;
   if(state.altEligible&&state.portfolioBrakeBlocks)
    alternateBrakeSinceLatestClose++;
  }
  const reason=row.alternative?.reason||'NOT_EVALUATED';
  bySelectedAlternateReason[reason]=(bySelectedAlternateReason[reason]||0)+1;
  if(state.altEligible)eligibleAlternative++;
  if(state.primaryEligible)eligiblePrimary++;
  if(state.altEligible||state.primaryEligible){
   eligibleRoute++;
   if(!latestEligible||d>ts(latestEligible))latestEligible=row.evaluated_at;
  }
  if(state.altEligible&&state.portfolioBrakeActive)altBlockedByPortfolio++;
  if(state.altEligible&&state.strategyBrakeActive)altBlockedByStrategy++;
  if(state.altEligible&&state.portfolioBrakeBlocks)altEffectivelyBlockedByPortfolio++;
  if(state.altEligible&&state.strategyBrakeBlocks)altEffectivelyBlockedByStrategy++;
  if(state.portfolioBrakeBlocks)byEffectiveSafety.portfolioBrake++;
  if(state.strategyBrakeBlocks)byEffectiveSafety.strategyBrake++;
  if(state.ownerAdvisoryOnly)ownerAdvisoryDecisions++;
  if(row.owner_pause_policy&&
     (!latestOwnerPausePolicy||d>ts(latestOwnerPausePolicy.evaluatedAt)))
    latestOwnerPausePolicy={evaluatedAt:row.evaluated_at,
     advisoryOnly:state.ownerAdvisoryOnly,
     modelLossStreakBlocks:row.owner_pause_policy.modelLossStreakBlocks===true,
     portfolioLossStreakBlocks:row.owner_pause_policy.portfolioLossStreakBlocks===true,
     fastStopCooldownBlocks:row.owner_pause_policy.fastStopCooldownBlocks===true};
  if(state.portfolioBrakeActive){
   byActiveSafety.portfolioBrake++;
   if(!latestPortfolioBrake||d>ts(latestPortfolioBrake.evaluatedAt))
    latestPortfolioBrake={evaluatedAt:row.evaluated_at,...row.portfolio_brake};
  }
  if(state.strategyBrakeActive)byActiveSafety.strategyBrake++;
  for(const b of infoList(row.blockers))
   blocking[b]=(blocking[b]||0)+1;
 }
 const recent=closes.map(r=>({
  closedAt:r.closed_at,
  instrument:r.instrument,direction:r.direction,
  netUsd:settled(r),
 })).sort((a,b)=>ts(b.closedAt)-ts(a.closedAt)).slice(0,6);
 const risk=inferPortfolioBrake(closes,current);
 return {
  artifact:ARTIFACT,generatedAt:now.toISOString(),
  userScope:'OWNER_PEPPERSTONE_USD_FULL_AUTO_DEMO',
  lastHours:AGE_MS/3600000,
  scannerDecisionsObserved:observed,
  latestDecisionAt:latestDecision,
  lastAlternateEligibleDecisionAt:latestEligible,
  newTradeIntentsInWindow:num(orders?.n)??null,
  latestIntentAt:orders?.latest??null,
  newTradeIntentsSinceLastClose:num(orders?.since_latest_close)??null,
  decisionsSinceLatestClosedTrade:decisionsSinceLatestClose,
  selectedAlternativeEligibleSinceLastClose:alternateEligibleSinceLatestClose,
  selectedAlternativeBrakedSinceLastClose:alternateBrakeSinceLatestClose,
  selectedContinuousAlternativeEligible:eligibleAlternative,
  selectedPrimaryAuthorityEligible:eligiblePrimary,
  eitherModelPathEligibleCount:eligibleRoute,
  // 'With*Brake' counters below are raw observation counts, NOT proof
  // that the corresponding cooldown prevented an order.
  eligibleAlternativeWithPortfolioBrake:altBlockedByPortfolio,
  eligibleAlternativeWithStrategyBrake:altBlockedByStrategy,
  eligibleAlternativeWithEffectivePortfolioVeto:altEffectivelyBlockedByPortfolio,
  eligibleAlternativeWithEffectiveStrategyVeto:altEffectivelyBlockedByStrategy,
  ownerDemoAdvisoryOnlyDecisions:ownerAdvisoryDecisions,
  latestOwnerPausePolicy,
  latestScannerPortfolioBrake:latestPortfolioBrake,
  independentlyComputedAccountBrake:risk,
  recentFullAutoSettlements:recent,
  lastDecisionModelRouteCounts:byModelRoute,
  selectedAlternativeReasonCounts:bySelectedAlternateReason,
  activeSafetyObservations:byActiveSafety,
  effectiveSafetyVetoes:byEffectiveSafety,
  diagnosticBlockersRanked:Object.entries(blocking).sort((a,b)=>b[1]-a[1])
   .slice(0,25).map(([reason,count])=>({reason,count})),
  caveats:[
   'Scanner blockers are diagnostic model-level labels, not an exhaustive exact replica of the final canExecute broker-dispatch predicate.',
   'When continuous alternative eligibility is true, an authority M1 timing-label mismatch may be an overridden diagnostic rather than a standalone effective execution veto.',
   'The 120-minute portfolio brake is a RAW independently computed loss observation. When latestOwnerPausePolicy.advisoryOnly=true, it is not itself an effective execution veto.',
   'Only blocker codes recorded by the scheduler represent effective portfolio/strategy brakes; even an eligible path can still fail other broker, risk, or freshness checks.',
   'The definitive broker entry also requires fresh signal, session, risk, commission and provider confirmation, which this script neither grants nor bypasses.',
   'This is an owner-only bounded read-only analysis, not a script capable of placing orders, changing lots, shortening risk cooldown or promoting LIVE.',
  ],
  modes:{databaseAccess:'REPEATABLE_READ_READ_ONLY',
   executionAuthority:'NONE',modifiesOrders:false,
   modifiesLotSizing:false,changesBrakes:false,liveEligible:false},
 };
}
async function audit(client,user,now=new Date()){
 if(!UUID.test(user||'')||!Number.isFinite(ts(now)))
  throw Error('UNVERIFIED_OWNER_OR_NOW');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='20000ms'");
  const start=new Date(ts(now)-AGE_MS).toISOString(),end=now.toISOString();
  const rows=(await client.query(DECISIONS_SQL,[user,start,end])).rows;
  if(rows.length>LIMIT)throw Error('UNBOUNDED_DECISION_RESULT');
  const settlements=(await client.query(SETTLEMENTS_SQL,[user,end])).rows;
  const latestClosed=settlements.reduce((best,r)=>{
   const t=ts(r.closed_at);return Number.isFinite(t)&&t>best?t:best;
  },-Infinity);
  const orders=(await client.query(ORDERS_SQL,[user,start,end,
   Number.isFinite(latestClosed)?new Date(latestClosed).toISOString():start])).rows[0];
  await client.query('COMMIT');
  return summarize(rows,settlements,orders,now);
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
}
function persist(report,file=OUT){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.'+process.pid+'.tmp',fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(report,null,2))}
 finally{fs.closeSync(fd)}
 fs.renameSync(tmp,file);
 return file;
}
async function main(){
 require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||
  path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg');
 const{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const client=new Client({
  host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-demo-entry-blockade-owner-readonly',
 });
 try{
  await client.connect();
  const r=await audit(client,process.env.VPS_FOREX_SCANNER_USER_ID);
  persist(r);
  console.log('OWNER_DEMO_ENTRY_BLOCKADE',JSON.stringify({
   at:r.generatedAt,observed:r.scannerDecisionsObserved,
   latestDecisionAt:r.latestDecisionAt,
   newIntents:r.newTradeIntentsInWindow,
   newIntentsSinceLastClose:r.newTradeIntentsSinceLastClose,
   decisionsSinceLastClose:r.decisionsSinceLatestClosedTrade,
   eligibleSinceLastClose:r.selectedAlternativeEligibleSinceLastClose,
   brakedSinceLastClose:r.selectedAlternativeBrakedSinceLastClose,
   alternativeEligible:r.selectedContinuousAlternativeEligible,
   alternativeWithBrake:r.eligibleAlternativeWithPortfolioBrake,
   alternativeWithEffectiveBrake:r.eligibleAlternativeWithEffectivePortfolioVeto,
   advisoryOnly:r.latestOwnerPausePolicy?.advisoryOnly??null,
   brake:r.independentlyComputedAccountBrake,
   topBlockers:r.diagnosticBlockersRanked.slice(0,12),
   source:'PRIVATE_OWNER_DEMO_RESEARCH_ONLY',
  }));
 }finally{await client.end()}
}
module.exports={ARTIFACT,DECISIONS_SQL,SETTLEMENTS_SQL,ORDERS_SQL,
 eligiblePath,settled,inferPortfolioBrake,summarize,audit,persist};
if(require.main===module)main().catch(e=>{
 console.error('OWNER_DEMO_ENTRY_BLOCKADE_AUDIT_FAILED',e.message);
 process.exitCode=1;
});
