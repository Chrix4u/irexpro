/**
 * READ-ONLY forensic check for owner Pepperstone USD DEMO entry starvation.
 * Usage: cd apps/api && node scripts/audit-owner-demo-entry-starvation.cjs 120
 *
 * Reports independent existing entry blockers and the configured Trend
 * Continuation pause AS PERSISTED in each candidate, not imagined API state.
 * Does not query LIVE, place orders, change risk or unpause a strategy.
 */
'use strict';
const path = require('node:path');
const asTime = x => {
  if (x == null || x === '') return null;
  const n = new Date(x).getTime();
  return Number.isFinite(n) ? n : null;
};
const asObject = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const countBy = (items, key) => {
  const result = new Map();
  for (const item of items) {
    const k = key(item) || 'UNKNOWN';
    result.set(k, (result.get(k) || 0) + 1);
  }
  return [...result].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({name, count}));
};
const minutesSince = (time, asOfMs) => {
  const t = asTime(time);
  return t == null ? null : Number(((asOfMs - t) / 60_000).toFixed(1));
};

function auditEntryStarvation(decisions, trades, asOf, lookbackMinutes = 120, limit = 4000) {
  const asOfMs = asTime(asOf);
  if (asOfMs == null || !Number.isInteger(lookbackMinutes) ||
      lookbackMinutes < 15 || lookbackMinutes > 360) throw Error('Invalid owner audit window');
  const earliest = asOfMs - lookbackMinutes * 60_000;
  const valid = decisions.filter(d => {
    const t = asTime(d.evaluated_at);
    return t != null && t <= asOfMs && t >= earliest;
  });
  // M1 tactical evidence records both sides. Do not call these unique
  // trade opportunities or confuse execution_authority with broker fills.
  const candidates = valid.filter(d => d.route !== 'ABSTAIN');
  const denied = candidates.filter(d => d.execution_authority !== 'BROKER_NATIVE');
  // A separately qualified Plan-B owner DEMO alternate may execute even
  // when the independent tactical M1 classifier is ABSTAIN. Count its
  // BROKER_NATIVE decision as authorized, but retain the M1-abstain
  // distinction so this is not mislabeled M1 confirmation.
  const authorizedAll = valid.filter(d => d.execution_authority === 'BROKER_NATIVE');
  const authorizedM1Abstain = authorizedAll.filter(d => d.route === 'ABSTAIN');
  const blocked = denied.flatMap(d => Array.isArray(d.blockers)
    ? [...new Set(d.blockers.filter(x => typeof x === 'string'))]
        .map(blocker => ({blocker}))
    : []);
  const paused = candidates.map(d => ({
    time: d.evaluated_at, instrument: d.instrument,
    decision: asObject(d.demo_continuation_pause),
  }));
  // The scheduler evaluates a separate continuation pause only AFTER a
  // preliminary executable route exists. A decision with enabled=false can
  // mean "check not reached", not "VPS environment flag disabled". Never infer
  // current configuration from a series of prior non-eligible decisions.
  const observedEngagedPause = paused
    .filter(d => d.decision.enabled === true)
    .sort((a,b) => asTime(b.time)-asTime(a.time))[0];
  const newestPauseState = [...paused]
    .sort((a,b) => asTime(b.time)-asTime(a.time))[0];
  const latestPrimary = candidates.map(d => asObject(d.primary_only_probation));
  const latestByPair = new Map();
  for (const d of valid) {
    const key = [d.instrument,d.direction].join('/');
    if (!latestByPair.has(key)) latestByPair.set(key,d);
  }
  const actual = trades.filter(t => {
    const opened = asTime(t.opened_at);
    return opened != null && opened <= asOfMs && opened >= earliest;
  });
  const lastTrade = trades.map(t => ({...t, t: asTime(t.opened_at)}))
    .filter(t => t.t != null && t.t <= asOfMs)
    .sort((a,b) => b.t - a.t)[0];
  const lastDecision = [...valid].sort(
    (a,b) => asTime(b.evaluated_at)-asTime(a.evaluated_at),
  )[0];
  const authorityCodes = countBy(candidates, d =>
    asObject(d.multimodel_authority).authorityPath || 'UNAVAILABLE');
  return {
    artifact:'owner-pepperstone-usd-demo-entry-starvation-forensic-v1',
    asOf:new Date(asOfMs).toISOString(),lookbackMinutes,
    accountScope:'EXACT_OWNER_PEPPERSTONE_USD_DEMO',
    readOnly:true,modifiesExecution:false,
    grantsTradeAuthority:false,
    sampledDecisions:valid.length,
    possibleRowTruncation:valid.length >= limit,
    latestDecisionAt:lastDecision?.evaluated_at || null,
    minutesSinceLatestDecision:minutesSince(lastDecision?.evaluated_at,asOfMs),
    m1Abstentions:valid.length-candidates.length,
    m1NonAbstainCandidates:candidates.length,
    nonAbstainNoBrokerAuthority:denied.length,
    brokerNativeAuthorizedDecisions:authorizedAll.length,
    brokerNativeAuthorizedM1AbstainDecisions:authorizedM1Abstain.length,
    brokerNativeAuthorizedNonAbstainDecisions:candidates.length-denied.length,
    ordersOpenedInWindow:actual.length,
    possibleTradeRowTruncation:trades.length>=4000,
    lastOrderOpenedAt:lastTrade?.opened_at || null,
    lastOrderInstrument:lastTrade?.instrument || null,
    minutesSinceLastOrder:minutesSince(lastTrade?.opened_at,asOfMs),
    continuationPause:{
      currentEnvironmentEnabled:null,
      configurationRequiresDirectVpsCheck:true,
      observedConfiguredEnabled:observedEngagedPause?.decision.enabled ?? null,
      latestEngagedAt:observedEngagedPause?.time ?? null,
      latestObservedReason:newestPauseState?.decision.reason || null,
      observedEnabledCandidates:paused.filter(x => x.decision.enabled===true).length,
      observedActuallyBlocked:paused.filter(x => x.decision.blocked===true).length,
    },
    primaryOnlyProbation:{
      enabledCandidates:latestPrimary.filter(x => x.enabled===true).length,
      blockedCandidates:latestPrimary.filter(x => x.blocked===true).length,
    },
    blockedReasonCountsNonExclusive:countBy(blocked,d=>d.blocker).slice(0,32),
    modelAuthorityPathCounts:authorityCodes,
    candidatePlanBRoutes:countBy(candidates,d=>d.plan_b_route),
    candidateDriftStates:countBy(candidates,d=>d.drift),
    candidateM1Routes:countBy(candidates,d=>d.route),
    recentPairSides:[...latestByPair].map(([pair,d])=>({
      pair,route:d.route,planB:d.plan_b_route,
      drift:d.drift,decisionAt:d.evaluated_at,
      brokerAuthority:d.execution_authority,
      blockers:Array.isArray(d.blockers)?d.blockers.slice(0,14):[],
      continuationPause:asObject(d.demo_continuation_pause).reason||null,
    })).sort((a,b)=>a.pair.localeCompare(b.pair)).slice(0,16),
    interpretation:[
      'M1 scanned opportunities and broker submissions are different measures.',
      'Blocker reasons overlap. Removing one blocker may still produce no trades.',
      'A recorded enabled continuation pause is independent of Start/Stop Trading.',
      'A stored enabled=false pause is ambiguous when no preliminary executable route reached the pause check; verify actual VPS config instead.',
      'A separate authenticated active FULL_AUTO session check is still required.',
      'A BROKER_NATIVE decision does not guarantee successful broker submission.',
      'A separately qualified DEMO Plan-B alternate may authorize a trade when its M1 tactical route is ABSTAIN; count that authorization separately.',
      'A full 4000-row trade sample means the window count is only a lower bound.',
      'This report does not infer broker availability, margin or actual current positions.',
    ],
  };
}

async function run() {
  const lookbackMinutes = Number(process.argv[2] || 120);
  if (!Number.isInteger(lookbackMinutes) ||
      lookbackMinutes < 15 || lookbackMinutes > 360)
    throw Error('Use an integer lookback of 15 to 360 minutes');
  require('dotenv').config({path:path.resolve(__dirname,'..','.env'),quiet:true});
  const {Client}=require('pg');
  const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  if (!owner) throw Error('Owner DEMO account not configured');
  const db = new Client({
    host:process.env.DB_HOST||'localhost',
    port:Number(process.env.DB_PORT||5432),
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    database:process.env.DB_NAME,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
    connectionTimeoutMillis:7000,statement_timeout:12000,
  });
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const asOf=new Date();
    const decisions = await db.query([
      'SELECT d.instrument,d.direction,d.route,d.evaluated_at,d.execution_authority,',
      'd.blockers,',
      "d.governance->'demoContinuationPause' AS demo_continuation_pause,",
      "d.governance->'demoPrimaryOnlyProbation' AS primary_only_probation,",
      "d.governance->'multimodelAuthority' AS multimodel_authority,",
      "d.governance->'multimodelEnsemble'->>'strategyRoute' AS plan_b_route,",
      "d.governance->'multimodelGovernance'->>'driftState' AS drift",
      'FROM trading.m1_tactical_decisions d',
      'JOIN broker.broker_connections bc ON bc.id=d.broker_connection_id',
      "AND bc.user_id=d.user_id",
      "WHERE d.user_id=$1 AND bc.user_id=$1",
      "AND bc.broker_id='pepperstone-ctrader'",
      "AND bc.account_type='DEMO' AND bc.account_currency='USD'",
      "AND d.evaluated_at>=$2::timestamptz-($3::int*interval '1 minute')",
      'AND d.evaluated_at<=$2::timestamptz',
      'ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 4000',
    ].join(' '),[owner,asOf.toISOString(),lookbackMinutes]);
    const trades = await db.query([
      'SELECT t.instrument,t.direction,t.status,t.opened_at',
      'FROM trading.trades t',
      'JOIN broker.broker_connections bc ON bc.id=t.broker_connection_id',
      'AND bc.user_id=t.user_id',
      "WHERE t.user_id=$1 AND bc.user_id=$1",
      "AND bc.broker_id='pepperstone-ctrader'",
      "AND bc.account_type='DEMO' AND bc.account_currency='USD'",
      'AND t.opened_at<=$2::timestamptz',
      'ORDER BY t.opened_at DESC LIMIT 4000',
    ].join(' '),[owner,asOf.toISOString()]);
    await db.query('ROLLBACK');
    console.log(JSON.stringify(
      auditEntryStarvation(decisions.rows,trades.rows,asOf,lookbackMinutes),null,2,
    ));
  } finally {await db.end();}
}
if (require.main===module) run().catch(e=>{
  process.stderr.write('READ_ONLY_OWNER_STARVATION_AUDIT_FAILED: '+e.message+'\n');
  process.exitCode=1;
});
module.exports={auditEntryStarvation};
