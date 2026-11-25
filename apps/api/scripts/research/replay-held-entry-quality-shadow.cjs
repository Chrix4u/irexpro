'use strict';
/**
 * RESEARCH ONLY. Historical evidence and pre-entry feature comparisons.
 * No trade/order/connector mutations, no new model gate and NO live authority.
 * Decision.candidate is kept for descriptive study, but its ROW was updated
 * after entry to record the outcome; it is not immutable point-in-time proof.
 * In contrast, trade_intents.metadata updated_at must be <= the trade entry.
 * Do not learn a threshold or treat P&L-informed exploratory splits as live rules.
 */
const fs=require('node:fs');const path=require('node:path');
const compact=x=>Number(Number(x).toFixed(2));
const pnl=x=>Number(x.gross??0)+Number(x.fee??0)+Number(x.swap??0);
const cleanArr=x=>Array.isArray(x)?x:[];
function heldEntryWouldReject(row){
  const g=row.governance||{};
  return row.route==='ABSTAIN'&&g?.rolloutPhase==='DEMO_EARLY_TRANSITION_PROFESSIONAL'&&
    g?.professionalM1FallbackExecutionEnabled!==true&&
    g?.multimodelTrainedExpert?.state==='ABSTAIN'&&
    g?.expectancy?.evidenceSamples!==null && g?.expectancy?.evidenceSamples!==undefined &&
    Number(g.expectancy.evidenceSamples)===0&&
    cleanArr(g.blockers).includes('DRIFT_OUT_OF_DISTRIBUTION')&&
    cleanArr(g.blockers).includes('ENSEMBLE_NOT_PAPER_ADMITTED');
}
function tally(rows){const positive=rows.filter(x=>pnl(x)>0),negative=rows.filter(x=>pnl(x)<0);
  return {trades:rows.length,wins:positive.length,losses:negative.length,
    winningNet:compact(positive.reduce((s,x)=>s+pnl(x),0)),
    losingNet:compact(negative.reduce((s,x)=>s+pnl(x),0)),
    net:compact(rows.reduce((s,x)=>s+pnl(x),0))};}
function profile(rows,key){const positive=rows.filter(x=>pnl(x)>0),negative=rows.filter(x=>pnl(x)<0);
  const summarize=arr=>{const nums=arr.map(x=>Number(x.candidate?.[key])).filter(Number.isFinite).sort((a,b)=>a-b);
    return {n:nums.length,mean:nums.length?Number((nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(4)):null,
      median:nums.length?Number(((nums[Math.floor((nums.length-1)/2)] + nums[Math.floor(nums.length/2)])/2).toFixed(4)):null};};
  return {feature:key,winners:summarize(positive),losers:summarize(negative)};
}
function analyze(raw){const rows=[...raw].sort((a,b)=>new Date(a.opened_at)-new Date(b.opened_at));
  const blocked=rows.filter(heldEntryWouldReject),retained=rows.filter(x=>!heldEntryWouldReject(x));
  const sign=(x,key)=>Number.isFinite(Number(x.candidate?.[key]))&&x.candidate?.[key]!==null&&Number(x.candidate[key])>=0;
  const signs=blocked.filter(x=>sign(x,'alignedM5')&&sign(x,'alignedM30DirectionalEfficiency'));
  const byPair=Object.fromEntries([...new Set(blocked.map(x=>x.instrument))].sort().map(p=>[p,tally(blocked.filter(x=>x.instrument===p))]));
  const asOf={tradeIntentPreEntry:rows.filter(x=>new Date(x.intent_created)<=new Date(x.opened_at)).length,
    intentUnmodifiedBeforeEntry:rows.filter(x=>new Date(x.intent_updated)<=new Date(x.opened_at)).length,
    m1DecisionEvaluatedBeforeEntry:rows.filter(x=>new Date(x.decision_at)<=new Date(x.opened_at)).length,
    decisionRowUnmodifiedBeforeEntry:rows.filter(x=>new Date(x.decision_updated)<=new Date(x.opened_at)).length};
  return {mode:'RESEARCH_ONLY_NO_ORDER_AUTHORITY',historicalFixedOutcomes:true,
    sample:tally(rows),heldEntryMatch:tally(blocked),originalNonMatches:tally(retained),
    byInstrument:byPair,entryEvidenceTimestampAudit:asOf,
    descriptiveFeatures:['alignedM5','alignedM30DirectionalEfficiency','alignedHigherTimeframeAgreement','confidence','score','alignedH4']
      .map(key=>profile(blocked,key)),
    researchOnlySignCheck:{title:'NON_EXECUTABLE_POSTHOC_M5_AND_M30_SIGN_CHECK',
      meetsBoth:tally(signs),failsEither:tally(blocked.filter(x=>!signs.includes(x))),
      firstTenMatched:tally(blocked.slice(0,10)),laterNineMatched:tally(blocked.slice(10))},
    limitations:['One-day selected sample: no independent future-period validation',
      'M1 decision rows were later updated after entry; candidate fields not proven immutable',
      'Rejected trades would alter equity, concurrent exposure and subsequent signals',
      'No filter improvement is deployed or permitted to execute broker orders']};
}
async function main(){
  const day=process.argv[2]||'2026-11-23';
  if(!/^20\d\d-\d\d-\d\d$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z')))throw Error('INVALID_UTC_DAY');
  const dotenv=require('dotenv');const {Client}=require('pg');
  const root=path.resolve(__dirname,'../..');
  const env=dotenv.parse(fs.readFileSync(process.env.IREXPRO_RESEARCH_DOTENV_PATH||path.join(root,'.env')));
  const c=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),database:env.DB_NAME,
    user:env.DB_USER,password:env.DB_PASSWORD,
    ssl:env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
    connectionTimeoutMillis:5000,statement_timeout:13000,
    application_name:'irexpro_held_entry_shadow_research_readonly'});
  try{await c.connect();await c.query('BEGIN READ ONLY');
    const result=await c.query(`SELECT t.instrument,t.opened_at,
      t.realised_pnl::text gross,t.commission::text fee,t.swap::text swap,
      d.route,d.candidate,d.governance,d.evaluated_at decision_at,
      d.updated_at decision_updated,ti.created_at intent_created,
      ti.updated_at intent_updated
      FROM trading.trades t
      JOIN broker.broker_connections b ON b.id=t.broker_connection_id
      JOIN trading.m1_tactical_decisions d ON d.trade_intent_id=t.trade_intent_id
      JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
      WHERE b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
        AND t.status='CLOSED' AND t.opened_at >= $1::timestamptz
        AND t.opened_at < ($1::timestamptz + interval '1 day')
      ORDER BY t.opened_at`,[day+'T00:00:00Z']);
    console.log(JSON.stringify({dayUTC:day,...analyze(result.rows)},null,2));
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}
}
module.exports={heldEntryWouldReject,tally,analyze};
if(require.main===module)main().catch(err=>{
  console.error('READ_ONLY_REPLAY_FAILED',/^[A-Z0-9]{5}$/.test(err?.code)?err.code:'RESEARCH_UNAVAILABLE');process.exitCode=1;
});
