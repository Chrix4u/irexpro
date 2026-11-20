'use strict';
/**
 * Independent expert-opposite challenger, research only. A native expert's
 * direction is NOT itself a trade. Match the other side's own *same-bar*
 * decision, then apply its own model, expected-value and timing gates.
 *
 * No broker order, no risk override, no claim of retrospective fills.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='irexpro-independent-expert-counter-challenger-v1';
const OUTPUT='/home/lightworld/webapps/irexpro-research/expert-opposite-challenger/latest-report.json';
const START='2026-11-16T20:00:00.000Z',END='2026-11-16T21:00:00.000Z';
const OWNER=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const numeric=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const timestamp=v=>v==null?NaN:new Date(v).getTime();
const fullVotes=(side,expert)=>side==='BUY'?
  Number(expert?.longVotes)===3&&Number(expert?.shortVotes)===0:
  Number(expert?.shortVotes)===3&&Number(expert?.longVotes)===0;
const supported=new Set(['EARLY_TRANSITION','CONFIRMED_REVERSAL']);
function evaluateProposal(source,opposite){
 const reject=(reason)=>({eligible:false,reason});
 const originalSide=source?.direction;
 const expert=source?.governance?.multimodelTrainedExpert;
 const baseline=source?.governance?.multimodelEnsemble;
 const requested=originalSide==='BUY'?'SELL':'BUY';
 if(!['BUY','SELL'].includes(originalSide))return reject('INVALID_ORIGINAL_SIDE');
 if(!supported.has(baseline?.strategyRoute) || baseline?.paperAdmitted!==true)
  return reject('ORIGINAL_NOT_QUALIFIED_ALTERNATE_ROUTE');
 if(expert?.direction!==requested)return reject('NO_OPPOSING_EXPERT_DIRECTION');
 const at=timestamp(source.evaluated_at),exTime=timestamp(expert?.decisionTime);
 if(!Number.isFinite(at)||at<Date.parse(START)||at>=Date.parse(END)||
    !Number.isFinite(exTime)||exTime>at||at-exTime>300000)
  return reject('EXPERT_OUTSIDE_DECISION_WINDOW');
 if(expert?.allBrokerNative!==true)return reject('EXPERT_NOT_NATIVE');
 if(expert?.state!=='CONFIRM'||expert?.admitted!==true)
  return reject('EXPERT_VOTED_BUT_ABSTAINED');
 if(numeric(expert?.ensembleConfidence)===null||
    numeric(expert.ensembleConfidence)<0.65||!fullVotes(requested,expert))
  return reject('EXPERT_NOT_UNANIMOUS_AND_CONFIDENT');
 if(!opposite||opposite.instrument!==source.instrument||
    opposite.direction!==requested||
    timestamp(opposite.bar_time)!==timestamp(source.bar_time))
  return reject('OPPOSITE_SAME_BAR_CANDIDATE_MISSING');
 const otherAt=timestamp(opposite.evaluated_at);
 if(!Number.isFinite(otherAt)||otherAt>at+5000||otherAt<at-90000)
  return reject('OPPOSITE_CANDIDATE_NOT_ASOF');
 const ens=opposite.governance?.multimodelEnsemble||{};
 const gov=opposite.governance?.multimodelGovernance||{};
 if(!supported.has(ens.strategyRoute))
  return reject('OPPOSITE_ROUTE_IS_NOT_REVERSAL_OR_EARLY');
 if(ens.paperAdmitted!==true||gov.paperExecutionEligible!==true)
  return reject('OPPOSITE_MODEL_OR_GOVERNANCE_REJECTED');
 if(numeric(ens.ensembleScore)===null||numeric(ens.ensembleScore)<0.6||
    numeric(ens.directionQuality)===null||numeric(ens.directionQuality)<0.54)
  return reject('OPPOSITE_DIRECTIONAL_QUALITY_LOW');
 if(numeric(gov.netExpectedR)===null||numeric(gov.netExpectedR)<0.12||
    gov.paperExecutionCostUsable!==true||
    gov.executionSpreadEvidenceValid!==true||
    gov.eventRisk!=='CLEAR'||gov.driftState==='OUT_OF_DISTRIBUTION')
  return reject('OPPOSITE_NET_EXPECTANCY_OR_MARKET_RISK');
 const m1q=numeric(opposite.candidate?.directionQuality);
 const m1c=numeric(opposite.candidate?.confidence);
 if(m1q===null||m1q<0.55||m1c===null||m1c<0.67)
  return reject('OPPOSITE_M1_TIMING_NOT_READY');
 const risk=numeric(opposite.candidate?.stopDistance);
 const target=numeric(opposite.candidate?.targetDistance);
 if(!(risk>0&&target>risk))
  return reject('OPPOSITE_OWN_STOP_TARGET_NOT_VALID');
 return {
  eligible:true,reason:'RESEARCH_QUALIFIED_NO_BROKER_AUTHORITY',
  proposedSide:requested,oppositeRoute:ens.strategyRoute,
  netExpectedR:gov.netExpectedR,
  // Never dispatch or substitute the source BUY stops for the SELL risk.
  stopDistance:risk,targetDistance:target,
 };
}
function compare(rows){
 const byBar=new Map(),sources=[];
 for(const d of rows){
  const key=[d.instrument,timestamp(d.bar_time)].join('|');
  if(!byBar.has(key))byBar.set(key,new Map());
  byBar.get(key).set(d.direction,d);
  const m=d.governance?.multimodelEnsemble;
  const e=d.governance?.multimodelTrainedExpert;
  if(supported.has(m?.strategyRoute)&&m?.paperAdmitted===true&&
     e?.direction&&e.direction!==d.direction)
    sources.push(d);
 }
 const reasons={},cases=[];
 for(const d of sources){
  const alternate=byBar.get([d.instrument,timestamp(d.bar_time)].join('|'))
    ?.get(d.direction==='BUY'?'SELL':'BUY');
  const result=evaluateProposal(d,alternate);
  reasons[result.reason]=(reasons[result.reason]??0)+1;
  cases.push({
   instrument:d.instrument,originalSide:d.direction,
   proposedSide:d.direction==='BUY'?'SELL':'BUY',
   decisionAt:d.evaluated_at,originalRoute:d.governance.multimodelEnsemble.strategyRoute,
   expertState:d.governance?.multimodelTrainedExpert?.state??null,
   expertProbability:d.governance?.multimodelTrainedExpert?.meanOpportunityProbability??null,
   oppositeRoute:alternate?.governance?.multimodelEnsemble?.strategyRoute??null,
   oppositeNetExpectedR:alternate?.governance?.multimodelGovernance?.netExpectedR??null,
   ...result,
  });
 }
 return {totalOpposedAlternates:sources.length,reasons,cases};
}
const SQL_SESSION=[
 'SELECT s.broker_connection_id AS id FROM trading.trading_sessions s',
 'JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id',
 "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.account_currency='USD'",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 'AND b.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 1',
].join(' ');
const SQL=[
 'SELECT d.instrument,d.direction,d.evaluated_at,d.bar_time,d.route,',
 'd.governance,d.candidate',
 'FROM trading.m1_tactical_decisions d',
 'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
 'AND d.evaluated_at >= $3::timestamptz',
 'AND d.evaluated_at < $4::timestamptz',
 "AND d.instrument IN ('AUDUSD','EURUSD','USDJPY','USDCAD','GBPUSD','USDCHF')",
 'ORDER BY d.evaluated_at ASC LIMIT 4001',
].join(' ');
async function run(db,owner,asOf=new Date()){
 if(!OWNER.test(owner||''))throw Error('INVALID_OWNER');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='20000ms'");
  const session=(await db.query(SQL_SESSION,[owner])).rows[0];
  if(!session)throw Error('OWNER_DEMO_NOT_VERIFIED');
  const until=new Date(Math.min(asOf.getTime(),Date.parse(END))).toISOString();
  const rows=(await db.query(SQL,[owner,session.id,START,until])).rows;
  if(rows.length>4000)throw Error('SCANS_TRUNCATED');
  await db.query('COMMIT');
  return {
   artifact:ARTIFACT,at:asOf.toISOString(),start:START,end:END,
   brokerScope:'OWNER_PEPPERSTONE_USD_DEMO',
   executionAuthority:'NONE',placesOrders:false,modifiesTrading:false,
   ...compare(rows),
   limitations:[
    'Expert votes alone do not authorize counter trades; a final expert ABSTAIN stays ABSTAIN.',
    'Opposite side must independently pass its own alternative route, after-cost, timing and stop/target gates.',
    'As-of paired decisions only; rejected or expired candidate snapshots cannot be replayed into new orders.',
    'This is a decision forensic audit, not a fill simulation or permission to resume paused continuation.',
   ],
  };
 }catch(e){try{await db.query('ROLLBACK')}catch{}throw e;}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
  password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-opposite-challenger-readonly',
  connectionTimeoutMillis:10000,query_timeout:30000});
 try{
  await db.connect();
  const r=await run(db,process.env.VPS_FOREX_SCANNER_USER_ID);
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
  const tmp=OUTPUT+'.tmp';fs.writeFileSync(tmp,JSON.stringify(r,null,2),{mode:0o600});
  fs.renameSync(tmp,OUTPUT);
  console.log('OPPOSITE_CHALLENGER_AUDIT',JSON.stringify({
   at:r.at,total:r.totalOpposedAlternates,reasons:r.reasons,
   cases:r.cases.slice(-5),
  }));
 }finally{await db.end()}
}
module.exports={ARTIFACT,START,END,SQL,SQL_SESSION,evaluateProposal,compare,run};
if(require.main===module)main().catch(e=>{
 console.error('OPPOSITE_CHALLENGER_AUDIT_FAILED',String(e.message).slice(0,250));process.exitCode=1;
});
