/**
 * READ-ONLY: owner Pepperstone USD DEMO fixed-envelope drift vs completed
 * broker-native M1 shadow labels. Hypothetical quote returns are not fills.
 * Usage from apps/api: node scripts/audit-owner-demo-drift-outcomes.cjs [days]
 */
'use strict';
const path = require('node:path');
const {compareMatchedDriftDays} = require('./owner-demo-drift-cohort-comparison.cjs');
const {summarizeRejectedDriftCounterfactuals} = require('./owner-demo-rejected-drift-counterfactual.cjs');
const ARTIFACT = 'owner-pepperstone-demo-drift-shadow-cohort-v1';
const OUTCOME_ARTIFACT = 'm1-shadow-outcome-15m-v1';
const STATUSES = new Set(['TP','SL','MTM']);
const DRIFT = new Set(['NORMAL','STRESSED','OUT_OF_DISTRIBUTION']);
const toMs = x => { if(x==null||x==='') return null; const n = new Date(x).getTime(); return Number.isFinite(n) ? n : null; };
const asNum = x => x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null;

function settledLabel(row, asOfMs) {
  const o=row.outcome;
  if (!o || o.artifact!==OUTCOME_ARTIFACT || o.modifiesExecution!==false ||
      o.source!=='COMPLETED_M1_OHLC' || !STATUSES.has(o.outcome)) return null;
  const observed=toMs(o.observedAt), started=toMs(row.bar_time);
  const net=asNum(o.netRMultiple);
  if (observed==null || started==null || observed<=started ||
      observed>asOfMs || net==null || Math.abs(net)>1000) return null;
  return {netR:net,status:o.outcome,costSource:o.executionCostSource??null};
}
function aggregate(rows, asOfMs) {
  const observations=rows.map(r=>settledLabel(r,asOfMs)).filter(Boolean);
  const plus=observations.reduce((a,x)=>a+Math.max(0,x.netR),0);
  const minus=observations.reduce((a,x)=>a+Math.max(0,-x.netR),0);
  const total=observations.reduce((a,x)=>a+x.netR,0);
  return {
    episodeCount:rows.length, observedCompletedM1:observations.length,
    missingOrIneligibleOutcomes:rows.length-observations.length,
    positiveNetR:observations.filter(x=>x.netR>0).length,
    negativeNetR:observations.filter(x=>x.netR<0).length,
    sumEstimatedNetR:Number(total.toFixed(4)),
    averageEstimatedNetR:observations.length?Number((total/observations.length).toFixed(4)):null,
    estimatedProfitFactor:minus?Number((plus/minus).toFixed(4)):null,
    brokerObservedCostRows:observations.filter(x=>x.costSource==='BROKER_OBSERVED_P90').length,
    simulatedCostRows:observations.filter(x=>x.costSource==='PAPER_SIMULATION_SPREAD').length,
  };
}
function buildDriftCohort(rows,asOf,sourceLimit=10000) {
  const asOfMs=toMs(asOf);
  if (asOfMs==null) throw new Error('Valid as-of timestamp required');
  // Do not count adjacent one-minute repeated scans as independent trades.
  const sorted=[...rows].filter(r=>toMs(r.bar_time)!=null)
    .sort((a,b)=>toMs(a.bar_time)-toMs(b.bar_time)||String(a.id).localeCompare(String(b.id)));
  const lastEpisodeByPairSideRoute=new Map(),selected=[];
  for(const row of sorted) {
    if(row.m1_route==='ABSTAIN') continue;
    const timestamp=toMs(row.bar_time);
    if(timestamp>asOfMs-16*60000) continue;
    const key=[row.instrument,row.direction,row.m1_route].join('|');
    const last=lastEpisodeByPairSideRoute.get(key);
    if(last!=null&&timestamp-last<20*60000) continue;
    lastEpisodeByPairSideRoute.set(key,timestamp);
    selected.push({
      ...row,
      drift:DRIFT.has(row.drift)?row.drift:'UNKNOWN',
      strategy_route:row.strategy_route||'UNKNOWN',
    });
  }
  const groups=keyFn=>{
    const by=new Map();
    for(const row of selected) {
      const key=keyFn(row);
      if(!by.has(key)) by.set(key,[]);
      by.get(key).push(row);
    }
    return [...by].map(([key,entries])=>({key,...aggregate(entries,asOfMs)}))
      .sort((a,b)=>b.episodeCount-a.episodeCount||a.key.localeCompare(b.key));
  };
  const days=[...new Set(selected.map(r=>new Date(r.bar_time).toISOString().slice(0,10)))].sort();
  const split=days.length>=4?days[Math.min(days.length-1,Math.ceil(days.length*.7))]:null;
  const before=selected.filter(r=>!split||new Date(r.bar_time).toISOString().slice(0,10)<split);
  const after=selected.filter(r=>split&&new Date(r.bar_time).toISOString().slice(0,10)>=split);
  return {
    artifact:ARTIFACT,asOf:new Date(asOfMs).toISOString(),researchOnly:true,
    modelTrainingStatus:'NOT_TRAINED',modifiesExecution:false,grantsTradeAuthority:false,
    accountScope:'OWNER_PEPPERSTONE_USD_DEMO_ONLY',
    measurement:'completed-M1-quote-hypothetical-15m-netR-not-broker-PnL',
    rawRowsReturned:sorted.length,sourceLimit,possiblyTruncated:sorted.length>=sourceLimit,
    deduplicatedEpisodeCount:selected.length,observedMarketDays:days.length,
    chronologicalSplitDay:split,earlierPeriod:aggregate(before,asOfMs),
    laterPeriod:aggregate(after,asOfMs),
    byPlanBRouteAndDrift:groups(r=>[r.strategy_route,r.drift].join(' / ')),
    byInstrumentRouteAndDrift:groups(r=>[r.instrument,r.strategy_route,r.drift].join(' / ')),
    // Different worker with a different sampling rule. This must never be
    // silently combined with the ordinary 15m M1 shadow labels above.
    rejectedDriftCounterfactuals:summarizeRejectedDriftCounterfactuals(sorted,asOfMs),
    matchedDriftDays:compareMatchedDriftDays(selected,settledLabel,asOfMs,{
      sourceTruncated:sorted.length>=sourceLimit,
    }),
    chronologicalMatchedDriftDays:{
      splitDay:split,
      earlier:compareMatchedDriftDays(before,settledLabel,asOfMs,{
        sourceTruncated:sorted.length>=sourceLimit,
      }),
      later:split?compareMatchedDriftDays(after,settledLabel,asOfMs,{
        sourceTruncated:sorted.length>=sourceLimit,
      }):null,
      status:split?'RETROSPECTIVE_TIME_SPLIT_ONLY':'NO_SEPARATE_DAY_HOLDOUT',
      retrained:false,
      promoteThresholds:false,
      grantsTradeAuthority:false,
      qualificationRequiresIndependentProspectiveEvidence:true,
    },
    topDriftDiagnostics:groups(r=>[
      r.strategy_route,r.drift,
      Array.isArray(r.diagnostics)?r.diagnostics.join(',')||'NONE':'MISSING'
    ].join(' / ')).slice(0,30),
    limitations:[
      'Quote scenarios are not broker fills or realized DEMO P&L.',
      'Shadow outcomes are selective and missing labels cannot count as wins or losses.',
      '20-minute episode spacing reduces overlap but does not make trades independent.',
      'A same-data threshold adjustment would be lookahead-biased.',
      'The day split is descriptive; no model was retrained or promoted.',
      'Same-day matched drift differences still reflect observational confounding and variable label coverage.',
      'Earlier/later day cohorts are retrospective reports, not sealed training and holdout sets.',
      'Ordinary shadow episodes exclude many blocked OOD candidates; the existing rejected-drift worker instead uses one earliest per-instrument fixed 16-minute bucket. These are different selection policies; their apparent returns must not be directly compared.',
    ],
  };
}
async function run() {
  const days=Number(process.argv[2]||3);
  if(!Number.isInteger(days)||days<1||days>7) throw Error('Lookback must be an integer from 1 to 7');
  require('dotenv').config({path:path.resolve(__dirname,'..','.env'),quiet:true});
  const {Client}=require('pg'), owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  if(!owner) throw Error('Owner DEMO identity is not configured');
  const db=new Client({
    host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
    connectionTimeoutMillis:7000,statement_timeout:15000,
  });
  const asOf=new Date();
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const sql=[
      'SELECT d.id,d.instrument,d.direction,d.route AS m1_route,d.bar_time,',
      "d.governance->'multimodelEnsemble'->>'strategyRoute' AS strategy_route,",
      "d.governance->'multimodelGovernance'->>'driftState' AS drift,",
      "d.governance->'multimodelGovernance'->'driftDiagnostics' AS diagnostics,",
      "d.governance->'shadowOutcome15mV1' AS outcome,",
      "d.governance->'driftCounterfactual15m' AS drift_outcome,",
      "d.governance->'multimodelGovernance'->>'executionCostSource' AS multimodel_cost_source,",
      "d.governance->'genericGovernance'->>'executionCostSource' AS generic_cost_source",
      'FROM trading.m1_tactical_decisions d',
      'JOIN broker.broker_connections bc ON bc.id=d.broker_connection_id AND bc.user_id=d.user_id',
      "WHERE d.user_id=$1 AND bc.user_id=$1 AND bc.broker_id='pepperstone-ctrader'",
      "AND bc.account_type='DEMO' AND bc.account_currency='USD' AND d.route<>'ABSTAIN'",
      "AND d.bar_time >= $2::timestamptz - ($3::int * interval '1 day')",
      "AND d.bar_time < $2::timestamptz - interval '16 minutes'",
      'ORDER BY d.bar_time DESC,d.id DESC LIMIT 10000',
    ].join(' ');
    const result=await db.query(sql,[owner,asOf.toISOString(),days]);
    await db.query('ROLLBACK');
    console.log(JSON.stringify({...buildDriftCohort(result.rows,asOf,10000),lookbackDays:days},null,2));
  } finally {await db.end();}
}
if(require.main===module) run().catch(e=>{
  console.error('READ_ONLY_DRIFT_RESEARCH_FAILED:',e.message);process.exitCode=1;
});
module.exports={buildDriftCohort,settledLabel,aggregate};
