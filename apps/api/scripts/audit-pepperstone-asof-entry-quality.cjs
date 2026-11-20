'use strict';
// Pepperstone DEMO owner-scoped, time-causal pair/side entry quality.
// Pure diagnostic: no trade veto, broker mutation, or model promotion.
const path=require('node:path'),fs=require('node:fs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACT='pepperstone-pair-side-asof-entry-quality-v1';
const OUT='/home/lightworld/webapps/irexpro-research/pair-side-asof-entry-quality/latest-report.json';
const MIN_HISTORY=8,MIN_DAYS=3;
const lookbackMs=14*86400000;
const amount=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const day=time=>new Date(time).toISOString().slice(0,10);
function classifyHistory(history){
  // A pair-side losing streak can be known causally with fewer trades
  // than the minimum needed to claim a statistically useful "edge".
  const paid=history.filter(r=>amount(r.net)!==null&&amount(r.risk)>0);
  const sequence=[...paid].sort((a,b)=>
    new Date(a.closedAt)-new Date(b.closedAt));
  let recentConsecutiveLosses=0;
  for(let i=sequence.length-1;i>=0;i--){
    if(sequence[i].net>=0)break;
    recentConsecutiveLosses++;
  }
  const n=paid.length,days=new Set(paid.map(x=>day(x.closedAt))).size;
  const pos=paid.filter(x=>x.net>0),neg=paid.filter(x=>x.net<0);
  const winRate=n?pos.length/n:null;
  const profit=pos.reduce((s,r)=>s+r.net,0);
  const loss=-neg.reduce((s,r)=>s+r.net,0);
  const pf=loss>0?profit/loss:null;
  const sumR=paid.reduce((s,r)=>s+r.net/r.risk,0);
  const meanR=n?sumR/n:null;
  // Missing evidence means UNKNOWN, never inferred NOT profitable.
  const qualified=n>=MIN_HISTORY&&days>=MIN_DAYS;
  const supportive=qualified&&pf!==null&&pf>=1.25&&
    winRate>=0.55&&meanR>0.1;
  return {n,days,wins:pos.length,losses:neg.length,
    recentConsecutiveLosses,
    lossStreakCaution:recentConsecutiveLosses>=3,
    winRate:winRate===null?null:+winRate.toFixed(4),
    profitFactor:pf===null?null:+pf.toFixed(3),
    meanNetR:meanR===null?null:+meanR.toFixed(3),
    evidence:qualified?'MIN_HISTORY_AND_DAYS_MET':'INSUFFICIENT_INDEPENDENT_HISTORY',
    shadowAssessment:qualified?(supportive?'SUPPORTIVE_HISTORICAL_EDGE':'EDGE_NOT_ESTABLISHED'):'UNKNOWN'};
}
function replayAsOf(trades){
  const ordered=[...trades].sort((a,b)=>new Date(a.openedAt)-new Date(b.openedAt)||
    String(a.id).localeCompare(String(b.id)));
  const results=[],byAssessment={},byLossStreakCaution={};
  for(const item of ordered){
    const at=new Date(item.openedAt).getTime();
    const closed=new Date(item.closedAt).getTime();
    if(!Number.isFinite(at)||!Number.isFinite(closed)||closed<at)
      throw Error('INVALID_TRADE_TIMESTAMPS');
    const historical=ordered.filter(p=>{
      const close=new Date(p.closedAt).getTime();
      return p.id!==item.id&&p.instrument===item.instrument&&
        p.direction===item.direction&&close<at&&close>=at-lookbackMs;
    });
    const c=classifyHistory(historical);
    const observation={id:item.id,day:day(item.openedAt),
      instrument:item.instrument,direction:item.direction,
      historical:c,actualNet:item.net,actualRisk:item.risk};
    results.push(observation);
    for(const [table,k] of [
      [byAssessment,c.shadowAssessment],
      [byLossStreakCaution,c.lossStreakCaution?'CAUTION_3_PLUS':'NO_STREAK_CAUTION'],
    ]){
      const b=table[k]??={trades:0,priced:0,wins:0,losses:0,
        actualNet:0};
      b.trades++;
      if(item.net!==null&&item.risk!==null&&item.risk>0){
        b.priced++;
        if(item.net>0)b.wins++;
        else if(item.net<0)b.losses++;
        b.actualNet+=item.net;
      }
    }
  }
  for(const group of [byAssessment,byLossStreakCaution])
    for(const v of Object.values(group))v.actualNet=+v.actualNet.toFixed(2);
  return {totalTrades:results.length,byAssessment,byLossStreakCaution,
    recentExamples:results.slice(-15),allAsOfDecisions:results};
}
const SQL=[
 'SELECT t.id,t.instrument,t.direction,t.opened_at AS "openedAt",t.closed_at AS "closedAt",',
 't.realised_pnl,t.commission,t.swap,',
 "COALESCE(NULLIF(ca.sizing_inputs->>'finalRiskAtStop','')::numeric,",
 "NULLIF(ca.sizing_inputs->>'riskAmount','')::numeric) risk",
 'FROM trading.trades t JOIN broker.broker_connections b ON b.id=t.broker_connection_id',
 'LEFT JOIN LATERAL (SELECT sizing_inputs FROM trading.capital_allocations c0',
 'WHERE c0.trade_intent_id=t.trade_intent_id AND c0.created_at<=t.opened_at',
 'ORDER BY c0.created_at DESC LIMIT 1) ca ON true',
 "WHERE t.user_id=$1 AND b.user_id=$1 AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.deleted_at IS NULL",
 "AND t.account_currency='USD' AND t.status='CLOSED'",
 'AND t.closed_at>=$2::timestamptz AND t.closed_at<$3::timestamptz',
 'ORDER BY t.opened_at,t.id LIMIT 3001'].join(' ');
async function audit(client,userId,from,to){
  if(!UUID.test(userId||''))throw Error('INVALID_OWNER_SCOPE');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='30000ms'");
    const rows=(await client.query(SQL,[userId,from,to])).rows;
    if(rows.length>3000)throw Error('TRUNCATED_AUDIT_COHORT');
    const data=rows.map(t=>{
      const gross=amount(t.realised_pnl),fee=amount(t.commission);
      const swap=t.swap===null?0:amount(t.swap);
      return {id:t.id,instrument:t.instrument,direction:t.direction,
        openedAt:t.openedAt,closedAt:t.closedAt,
        net:gross===null||fee===null||swap===null?null:gross+fee+swap,
        risk:amount(t.risk)};
    });
    const replay=replayAsOf(data);
    await client.query('COMMIT');
    return {artifact:ARTIFACT,generatedAt:new Date().toISOString(),
      windowUTC:{from,to},scope:'OWNER_PEPPERSTONE_DEMO_USD_CLOSED',
      authority:'RESEARCH_ONLY',modifiesExecution:false,
      ...replay,
      limitations:[
        'Historical training uses exclusively positions closed before each entry timestamp.',
        'No overlap leakage: concurrent trades cannot appear in another position’s prior outcomes.',
        'History count and distinct day requirements are deliberately conservative.',
        'The shadow assessment is a diagnostic label, NOT a profitable strategy or executable trade veto.',
        'No causal predictive model is trained by this audit; evaluate independent future out-of-sample episodes.',
      ]};
  }catch(e){await client.query('ROLLBACK');throw e;}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const to=new Date(),from=new Date(to.getTime()-30*86400000);
 const c=new Client({host:process.env.DB_HOST||'localhost',
   port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME||'irexpro_dev',
   user:process.env.DB_USER||'irexpro',password:process.env.DB_PASSWORD,
   ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
   application_name:'irexpro-asof-pairside-readonly'});
 try{
   await c.connect();
   const report=await audit(c,process.env.VPS_FOREX_SCANNER_USER_ID,
     from.toISOString(),to.toISOString());
   fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
   fs.writeFileSync(OUT,JSON.stringify(report,null,2),{mode:0o600});
   const {allAsOfDecisions,...brief}=report;
   console.log('PAIR_SIDE_ASOF_ENTRY_QUALITY',JSON.stringify(brief));
 }finally{await c.end()}
}
module.exports={amount,classifyHistory,replayAsOf,SQL,audit};
if(require.main===module)main().catch(e=>{
 console.error('PAIR_SIDE_ASOF_AUDIT_FAILED',e.message);process.exitCode=1;
});
