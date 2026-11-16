'use strict';
// Read-only retrospective comparison of the *actual* Pepperstone DEMO
// directional-quality scores and the opposite M1 candidate at the SAME bar.
// Never authorize orders or use post-entry scores to invent an as-of rule.
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='pepperstone-directional-consensus-readonly-v1';
const FILE='/home/lightworld/webapps/irexpro-research/directional-consensus/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const numeric=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const millis=v=>v==null?NaN:new Date(v).getTime();
const usd=n=>Math.round((n+Number.EPSILON)*100)/100;
const SQL=[
 'SELECT t.id,t.instrument,t.direction,t.opened_at,t.closed_at,t.realised_pnl,t.commission,t.swap,',
 'ti.created_at AS intent_at,ti.direction AS intent_side,',
 'd.direction AS m1_side,d.evaluated_at AS decision_at,d.route AS m1_route,',
 "d.candidate->>'score' AS selected_m1_score,",
 "d.candidate->>'directionQuality' AS selected_m1_quality,",
 "d.governance #>> '{multimodelEnsemble,strategyRoute}' AS route,",
 "d.governance #>> '{multimodelEnsemble,directionQuality}' AS planb_quality,",
 'o.direction AS order_side,',
 "sig.material_fields->>'direction' AS signal_side,",
 'other.direction AS other_side,other.evaluated_at AS other_at,',
 "other.candidate->>'score' AS other_m1_score",
 'FROM trading.trades t',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO' AND b.deleted_at IS NULL",
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
 'JOIN trading.m1_tactical_decisions d ON d.trade_intent_id=ti.id AND d.user_id=t.user_id',
 'AND d.broker_connection_id=t.broker_connection_id',
 'JOIN trading.orders o ON o.id=t.order_id AND o.user_id=t.user_id',
 'JOIN trading.ai_signal_identities sig ON sig.signal_id=t.signal_id::text AND sig.user_id=t.user_id',
 'LEFT JOIN LATERAL (SELECT k.direction,k.evaluated_at,k.candidate',
 'FROM trading.m1_tactical_decisions k WHERE k.user_id=t.user_id',
 'AND k.broker_connection_id=t.broker_connection_id',
 'AND k.instrument=t.instrument AND k.bar_time=d.bar_time AND k.direction<>d.direction',
 "AND k.evaluated_at BETWEEN d.evaluated_at-interval '90 seconds'",
 "AND d.evaluated_at+interval '90 seconds'",
 'ORDER BY abs(extract(epoch from(k.evaluated_at-d.evaluated_at))) ASC,k.id LIMIT 1)',
 'other ON true WHERE t.user_id=$1 AND t.account_currency=$2',
 "AND t.status='CLOSED' AND t.opened_at>=$3::timestamptz AND t.opened_at<$4::timestamptz",
 'ORDER BY t.opened_at,t.id LIMIT 2001'
].join(' ');
function normalize(r){
 const times=[millis(r.opened_at),millis(r.closed_at),millis(r.intent_at),millis(r.decision_at)];
 const [opened,closed,intent,decision]=times;
 const sides=[r.direction,r.signal_side,r.intent_side,r.m1_side,r.order_side];
 if(times.some(t=>!Number.isFinite(t))||closed<opened||intent>opened||decision>intent||
  !sides.every(s=>s==='BUY'||s==='SELL'))throw Error('UNVERIFIED_TRADE_PROVENANCE');
 if(sides.some(s=>s!==sides[0]))throw Error('DIRECTION_INVERSION_DETECTED');
 const gross=numeric(r.realised_pnl),comm=numeric(r.commission);
 const swap=r.swap===null?0:numeric(r.swap);
 const net=gross===null||comm===null||swap===null?null:usd(gross+comm+swap);
 const selectedScore=numeric(r.selected_m1_score),otherScore=numeric(r.other_m1_score);
 const otherAt=millis(r.other_at);
 const otherRecorded=(r.other_side==='BUY'||r.other_side==='SELL')&&
  r.other_side!==r.direction&&Number.isFinite(otherAt)&&otherScore!==null;
 // A score written later than the original intent is NOT entry-time evidence.
 const otherKnownAtIntent=otherRecorded&&otherAt<=intent;
 return {
  id:r.id,instrument:r.instrument,side:r.direction,
  day:new Date(opened).toISOString().slice(0,10),route:r.route||'UNKNOWN',
  m1Route:r.m1_route,realizedNetUsd:net,
  planbQuality:numeric(r.planb_quality),
  m1Quality:numeric(r.selected_m1_quality),
  selectedM1Score:selectedScore,
  oppositeWasRecorded:otherRecorded,
  oppositeAvailableAsOfIntent:otherKnownAtIntent,
  oppositeScoreMargin:otherKnownAtIntent&&selectedScore!==null?
   +(selectedScore-otherScore).toFixed(6):null,
 };
}
function aggregate(rows){
 let gain=0,loss=0,net=0,win=0,lose=0,unpriced=0;
 const days=new Set();
 for(const r of rows){
  days.add(r.day);
  if(r.realizedNetUsd===null){unpriced++;continue;}
  net+=r.realizedNetUsd;
  if(r.realizedNetUsd>0){win++;gain+=r.realizedNetUsd;}
  if(r.realizedNetUsd<0){lose++;loss-=r.realizedNetUsd;}
 }
 const priced=rows.length-unpriced;
 return {trades:rows.length,priced,unpriced,days:[...days].sort(),
  wins:win,losses:lose,winRate:priced?+(win/priced).toFixed(3):null,
  netUsd:priced?usd(net):null,profitFactor:loss?+(gain/loss).toFixed(3):null};
}
function study(rows){
 const byDay={},byRoute={},byDayRoute={};
 for(const r of rows){
  (byDay[r.day]??=[]).push(r);
  (byRoute[r.route]??=[]).push(r);
  (byDayRoute[r.day+'|'+r.route]??=[]).push(r);
 }
 const group=table=>Object.fromEntries(
  Object.entries(table).sort(([a],[b])=>a.localeCompare(b))
   .map(([key,items])=>[key,aggregate(items)]));
 const rules={
  ALL:()=>true,
  PLANB_055:r=>r.planbQuality!==null&&r.planbQuality>=0.55,
  BOTH_PLANB_AND_M1_055:r=>r.planbQuality!==null&&r.planbQuality>=0.55&&
   r.m1Quality!==null&&r.m1Quality>=0.55,
  ASOF_M1_SCORE_PREFERRED:r=>r.oppositeScoreMargin!==null&&r.oppositeScoreMargin>=0,
 };
 const scenarios={};
 for(const [name,fn] of Object.entries(rules)){
  scenarios[name]={
   included:aggregate(rows.filter(fn)),
   excluded:aggregate(rows.filter(r=>!fn(r))),
   byDay:Object.fromEntries(Object.entries(byDay).map(([day,group])=>
    [day,{included:aggregate(group.filter(fn)),excluded:aggregate(group.filter(r=>!fn(r)))}]))
  };
 }
 const thresholds={};
 for(const floor of [0.5,0.55,0.6,0.65]){
  const eligible=r=>r.planbQuality!==null&&r.planbQuality>=floor;
  thresholds[String(floor)]={
   included:aggregate(rows.filter(eligible)),
   excluded:aggregate(rows.filter(r=>!eligible(r))),
   continuationIncluded:aggregate(rows.filter(r=>r.route==='TREND_CONTINUATION'&&eligible(r))),
   continuationExcluded:aggregate(rows.filter(r=>r.route==='TREND_CONTINUATION'&&!eligible(r))),
  };
 }
 return {total:aggregate(rows),byDay:group(byDay),byRoute:group(byRoute),
  byDayRoute:group(byDayRoute),scenarios,thresholds,
  pairedOpposite:{
   recorded:rows.filter(r=>r.oppositeWasRecorded).length,
   availableAtIntent:rows.filter(r=>r.oppositeAvailableAsOfIntent).length,
   selectedPreferred:aggregate(rows.filter(r=>r.oppositeScoreMargin!==null&&r.oppositeScoreMargin>=0)),
   oppositePreferred:aggregate(rows.filter(r=>r.oppositeScoreMargin!==null&&r.oppositeScoreMargin<0)),
  },
  cases:rows.slice(-120),
 };
}
async function audit(db,userId,now=new Date()){
 if(!UUID.test(userId||''))throw Error('OWNER_SCOPE_INVALID');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='25000ms'");
  const from=new Date(now.getTime()-21*86400000).toISOString();
  const result=await db.query(SQL,[userId,'USD',from,now.toISOString()]);
  if(result.rows.length>2000)throw Error('TRUNCATED_DATA');
  const report=study(result.rows.map(normalize));
  await db.query('COMMIT');
  return {artifact:ARTIFACT,generatedAt:now.toISOString(),from,
   executionAuthority:'NONE',modifiesTrading:false,
   scope:'OWNER_PEPPERSTONE_DEMO_USD_CLOSED',
   warnings:[
    'All directional thresholds are retrospectively selected exploratory comparisons, NOT proven prospective policies.',
    'Excluded trades are historical booked outcomes, NOT profits that an actual alternative account would necessarily save.',
    'M1 opposite direction observed after the original intent is never considered available at entry time.',
    'Directional quality is a feature score, not a calibrated probability of success.',
    'No training, broker order, model promotion, or risk-control change occurs here.'
   ],...report};
 }catch(e){try{await db.query('ROLLBACK')}catch{}throw e;}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME||'irexpro_dev',
  user:process.env.DB_USER||'irexpro',password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  connectionTimeoutMillis:10000,query_timeout:30000,
  application_name:'irexpro-directional-consensus-owner-readonly'});
 try{
  await db.connect();
  const report=await audit(db,process.env.VPS_FOREX_SCANNER_USER_ID);
  fs.mkdirSync(path.dirname(FILE),{recursive:true,mode:0o700});
  const tmp=FILE+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(report,null,2),{mode:0o600});
  fs.renameSync(tmp,FILE);
  const {cases,...summary}=report;
  console.log('DIRECTION_CONSENSUS_AUDIT',JSON.stringify(summary));
 }finally{await db.end();}
}
module.exports={SQL,ARTIFACT,normalize,aggregate,study,audit};
if(require.main===module)main().catch(e=>{
 console.error('DIRECTION_CONSENSUS_AUDIT_FAILED',String(e.message).slice(0,230));
 process.exitCode=1;
});
