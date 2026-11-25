'use strict';
// Read-only owner Pepperstone USD DEMO exact strategy brake diagnoses; no orders.
const fs=require('node:fs'),path=require('node:path');
const OUT='/home/lightworld/webapps/irexpro-research/route-brake-diagnostics';
const QUERY=[
 "SELECT d.evaluated_at,d.instrument,d.direction,",
 "d.governance->'multimodelEnsemble'->>'strategyRoute' strategy,",
 "d.governance->'multimodelLossStreakBrake' brake,",
 "d.governance->'demoAlternativeTrial' trial,",
 "d.governance->'multimodelAuthority' authority,",
 "d.blockers",
 "FROM trading.m1_tactical_decisions d",
 "JOIN broker.broker_connections b ON b.id=d.broker_connection_id AND b.user_id=d.user_id",
 "WHERE d.user_id=$1 AND b.user_id=$1",
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND d.evaluated_at>=$2::timestamptz AND d.evaluated_at<=$3::timestamptz",
 "ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 2501"
].join(' ');
function analyze(rows,at){
 const match=rows.filter(x=>x.brake?.active===true && Array.isArray(x.blockers) &&
  x.blockers.includes('M1_MULTIMODEL_LOSS_STREAK_BRAKE'));
 const map=new Map();
 for(const r of match){
  const key=[r.strategy,r.instrument,r.direction,r.brake.reason].join(' | ');
  const g=map.get(key)||{
   key,strategy:r.strategy,instrument:r.instrument,direction:r.direction,
   reason:r.brake.reason,observations:0,latestAt:null,
   latestClosedAt:null,reportedCooldownRemainingSeconds:null,
   persistentNegativePayoff:null,recentLosses:null,recentWins:null,
   cumulativeNetUsd:null,profitFactor:null,payoffClosedTrades:null,
  };
  g.observations++;
  if(!g.latestAt||new Date(r.evaluated_at)>new Date(g.latestAt)){
   g.latestAt=r.evaluated_at;
   g.latestClosedAt=r.brake.latestClosedAt??null;
   g.reportedCooldownRemainingSeconds=r.brake.cooldownRemainingSeconds??null;
   g.persistentNegativePayoff=r.brake.persistentNegativePayoff??null;
   g.recentLosses=r.brake.recentLosses??null;
   g.recentWins=r.brake.recentWins??null;
   g.cumulativeNetUsd=r.brake.cumulativeRealisedPnl??null;
   g.profitFactor=r.brake.profitFactor??null;
   g.payoffClosedTrades=r.brake.payoffClosedTrades??null;
  }
  map.set(key,g);
 }
 const brakes=[...map.values()].sort((a,b)=>b.observations-a.observations);
 return {
  artifact:'owner-demo-executable-route-brake-status-v1',
  generatedAt:at.toISOString(),windowHours:3,
  researchOnly:true,modifiesExecution:false,brokerOrders:0,
  scanDecisions:rows.length,blockedModelDecisions:match.length,
  distinctBlockedPairSideRoutes:brakes.length,
  brakes,
  limitations:[
   'These are stored scanner observations of individual model routes, not an independently reconstructed final broker dispatch.',
   'The route brake has a 12-hour cooldown and can remain active with persistent negative payoff while historical evidence is recent.',
   'Do not treat a paused route as a reason to execute opposite direction or bypass existing risk controls.',
  ],
 };
}
async function run(c,owner,at=new Date()){
 if(!/^[a-f0-9-]{36}$/i.test(owner||''))throw Error('INVALID_OWNER_ID');
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await c.query("SET LOCAL statement_timeout='18000ms'");
  const from=new Date(at.getTime()-3*3600000);
  const rows=(await c.query(QUERY,[owner,from.toISOString(),at.toISOString()])).rows;
  if(rows.length>2500)throw Error('TOO_MANY_MODEL_DECISIONS');
  const summary=analyze(rows,at);
  await c.query('COMMIT');return summary;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
}
async function main(){
 require('dotenv').config({path:path.join(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const c=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  application_name:'irexpro-model-brake-readonly-diagnostic'});
 try{
  await c.connect();
  const report=await run(c,process.env.VPS_FOREX_SCANNER_USER_ID);
  fs.mkdirSync(OUT,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(OUT,'latest.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log('MODEL_BRAKE_SCOPED_READONLY',JSON.stringify(report).slice(0,8000));
 }finally{await c.end()}
}
module.exports={QUERY,analyze,run};
if(require.main===module)main().catch(e=>{console.error('BRAKE_AUDIT_FAILED',String(e.message).slice(0,170));process.exitCode=1});
