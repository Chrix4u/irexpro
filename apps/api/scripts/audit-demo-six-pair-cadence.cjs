'use strict';

// Owner-scoped, read-only DEMO scan-cadence evidence. A missing persisted M1
// decision is NOT proof of a missed broker order or a broken data feed.
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAIRS = Object.freeze(['AUDUSD', 'GBPUSD', 'EURUSD', 'USDCAD', 'USDCHF', 'USDJPY']);
const V2 = 'm1-tactical-v8-demo-primary-fee-shadow-six-pair-v2';
const BROKER_IDS = Object.freeze(['ctrader', 'pepperstone-ctrader']);
const REPORT = '/home/lightworld/webapps/irexpro-research/six-pair-cadence/latest-report.json';
const RECENT_WINDOW_MINUTES = 10;

function parseWindowMinutes(raw) {
  if (raw === undefined || raw === '') return 60;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,2}$/.test(raw))
    throw Error('INVALID_CADENCE_WINDOW_MINUTES');
  const minutes = Number(raw);
  if (minutes < 5 || minutes > 180) throw Error('INVALID_CADENCE_WINDOW_MINUTES');
  return minutes;
}

// Each run first discovers the CURRENT owned ACTIVE FULL_AUTO cTrader-family
// DEMO session inside the SAME read-only transaction. A stale fixed
// M1_TACTICAL_MARKET_DATA_CONNECTION_ID silently reported zero scans after the
// user switched to Pepperstone; it must never select the diagnostic scope.
const ACTIVE_SCOPE_SQL = [
  'SELECT s.broker_connection_id AS id',
  'FROM trading.trading_sessions s',
  'JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id',
  "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
  "AND b.broker_id = ANY($2::text[]) AND b.account_type='DEMO' AND b.deleted_at IS NULL",
  'ORDER BY s.authority_generation DESC,s.started_at DESC LIMIT 1',
].join('\n');

// Only decision-time stored evidence. The exact policy pin excludes old
// focused-three decisions even if they were persisted late after a rollout.
const COVERAGE_SQL = [
  "SELECT date_trunc('minute', d.evaluated_at) AS slot, d.instrument,",
  "count(*)::int AS evaluations, count(DISTINCT d.direction)::int AS directions,",
  "count(*) FILTER (WHERE d.execution_authority = 'BROKER_NATIVE')::int AS authorized,",
  "count(*) FILTER (WHERE d.blockers ? 'DRIFT_OUT_OF_DISTRIBUTION')::int AS ood,",
  "count(*) FILTER (WHERE d.blockers ? 'MULTIMODEL_PLAN_B_NOT_ADMITTED')::int AS planb_not_admitted,",
  "count(*) FILTER (WHERE d.blockers ? 'M1_DEMO_INSTRUMENT_RESEARCH_ONLY')::int AS old_pair_veto,",
  "round(extract(epoch FROM (min(d.created_at) - date_trunc('minute', d.evaluated_at)))::numeric, 3) AS first_persist_lag_sec",
  'FROM trading.m1_tactical_decisions d',
  'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
  'AND d.evaluated_at >= $3::timestamptz AND d.evaluated_at < $4::timestamptz',
  "AND d.governance->>'rolloutPolicyVersion'=$5",
  'AND d.instrument = ANY($6::text[])',
  'GROUP BY 1,2 ORDER BY 1,2',
].join('\n');

function finiteCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw Error('INVALID_AGGREGATE_COUNT');
  return n;
}
function nearestRank95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 1000) / 1000;
}
function summarize(rows, since, until) {
  const slots = new Map();
  const byPair = Object.fromEntries(
    PAIRS.map((pair) => [pair, { observedSlots: 0, twoSidedSlots: 0, evaluations: 0, authorized: 0, ood: 0, planBNotAdmitted: 0, unexpectedOldPairVeto: 0, persistLagP95Seconds: null }]),
  );
  const lags = Object.fromEntries(PAIRS.map((pair) => [pair, []]));
  let observedEvaluations = 0;
  const start = new Date(since).getTime();
  const end = new Date(until).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Error('INVALID_WINDOW');
  for (const row of rows) {
    if (!PAIRS.includes(row.instrument)) throw Error('UNAPPROVED_PAIR');
    const when = new Date(row.slot).getTime();
    if (!Number.isFinite(when) || when < start || when >= end || when % 60000 !== 0)
      throw Error('INVALID_OBSERVED_SLOT');
    const key = new Date(when).toISOString();
    const slotPairs = slots.get(key) || new Set();
    if (slotPairs.has(row.instrument)) throw Error('DUPLICATE_PAIR_SLOT');
    slotPairs.add(row.instrument);
    slots.set(key, slotPairs);
    const s = byPair[row.instrument];
    const evaluations = finiteCount(row.evaluations);
    const directions = finiteCount(row.directions);
    if (directions > 2 || directions > evaluations) throw Error('INVALID_DIRECTION_COUNT');
    s.observedSlots++;
    if (directions === 2) s.twoSidedSlots++;
    s.evaluations += evaluations;
    observedEvaluations += evaluations;
    for (const [destination, source] of [
      ['authorized', 'authorized'], ['ood', 'ood'],
      ['planBNotAdmitted', 'planb_not_admitted'],
      ['unexpectedOldPairVeto', 'old_pair_veto'],
    ]) {
      const n = finiteCount(row[source]);
      if (n > evaluations) throw Error('INVALID_BLOCKER_AGGREGATE');
      s[destination] += n;
    }
    if (row.first_persist_lag_sec !== null && row.first_persist_lag_sec !== undefined) {
      const lag = Number(row.first_persist_lag_sec);
      if (!Number.isFinite(lag) || Math.abs(lag) > 86400) throw Error('INVALID_PERSIST_LAG');
      lags[row.instrument].push(lag);
    }
  }
  for (const pair of PAIRS) byPair[pair].persistLagP95Seconds = nearestRank95(lags[pair]);
  const incompleteSlots = [...slots.entries()]
    .filter(([, pairs]) => pairs.size !== PAIRS.length)
    .map(([slot, pairs]) => ({ slot, absentPairs: PAIRS.filter((pair) => !pairs.has(pair)) }));
  return {
    windowMinutes: (end - start) / 60000,
    observedSlots: slots.size,
    slotsWithAllSix: slots.size - incompleteSlots.length,
    slotsMissingSomePairs: incompleteSlots.length,
    observedEvaluations,
    incompleteSlots: incompleteSlots.slice(0, 120),
    byPair,
    // Absence is only a persisted-evidence gap. Market session, readiness,
    // process restart and broker connection must be checked separately.
    interpretation: 'PERSISTED_M1_DECISION_COVERAGE_ONLY_NOT_ORDER_ELIGIBILITY',
  };
}

async function runAudit({ client, userId, since, until }) {
  if (!UUID.test(userId || '')) throw Error('INVALID_OWNER_SCOPE');
  const start = new Date(since);
  const end = new Date(until);
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms < 5 * 60000 || ms > 180 * 60000 ||
      start.getTime() % 60000 !== 0 || end.getTime() % 60000 !== 0)
    throw Error('INVALID_WINDOW');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='45s'");
    const owner = await client.query(ACTIVE_SCOPE_SQL, [userId, [...BROKER_IDS]]);
    if (owner.rows.length !== 1 || !UUID.test(owner.rows[0]?.id || ''))
      throw Error('NO_ACTIVE_OWNED_CTRADER_DEMO_SESSION');
    const activeConnectionId = owner.rows[0].id;
    const found = await client.query(COVERAGE_SQL, [
      userId, activeConnectionId, start.toISOString(), end.toISOString(), V2, [...PAIRS],
    ]);
    if (found.rows.length > 1086) throw Error('TRUNCATED_OR_UNBOUNDED_COVERAGE');
    // The headline hour can contain deploy/restart minutes. Also show a short,
    // same-snapshot tail so operators can distinguish pre-release from recent
    // scanning without claiming persistence delay is runtime latency.
    const recentStart = new Date(end.getTime() - Math.min(RECENT_WINDOW_MINUTES * 60000, ms));
    const recentRows = found.rows.filter((row) => new Date(row.slot).getTime() >= recentStart.getTime());
    const recent = summarize(recentRows, recentStart, end);
    const report = {
      artifact: 'ctrader-demo-six-pair-cadence-observation-v1',
      generatedAt: new Date().toISOString(),
      since: start.toISOString(),
      through: end.toISOString(),
      rolloutPolicyVersion: V2,
      authority: 'RESEARCH_ONLY',
      modifiesExecution: false,
      ...summarize(found.rows, start, end),
      recentWindow: {
        since: recentStart.toISOString(),
        through: end.toISOString(),
        windowMinutes: recent.windowMinutes,
        observedSlots: recent.observedSlots,
        slotsWithAllSix: recent.slotsWithAllSix,
        slotsMissingSomePairs: recent.slotsMissingSomePairs,
        byPair: recent.byPair,
      },
      limitations: [
        'A missing persisted decision may reflect restart, market closure, missing broker bars or an inactive session; it is not proof of a slow or missed scan.',
        'Persistence lag is from the saved M1 evaluated minute to the first database write; it is NOT the scheduler start lag or a broker fill latency.',
        'OOD, Plan B and pair-restriction counts overlap and may repeat across a market episode; do not add them as independent opportunities.',
        'No orders, risk limits, model thresholds, broker permissions or API cadence are changed.',
      ],
    };
    await client.query('COMMIT');
    return report;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function main() {
  require('dotenv').config({
    path: process.env.IREXPRO_API_ENV_PATH || resolve(__dirname, '../.env'), quiet: true,
  });
  const { Client } = require('pg');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const end = new Date(Math.floor(Date.now() / 60000) * 60000);
  const start = new Date(end.getTime() - parseWindowMinutes(process.env.IREXPRO_CADENCE_WINDOW_MINUTES) * 60000);
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev',
    user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-six-pair-cadence-readonly',
  });
  try {
    await client.connect();
    const report = await runAudit({
      client,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      since: start,
      until: end,
    });
    mkdirSync(resolve(REPORT, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log('DEMO_CADENCE_RESEARCH ' + JSON.stringify({
      policy: report.rolloutPolicyVersion, since: report.since, through: report.through,
      recentWindow: report.recentWindow, observedSlots: report.observedSlots,
      slotsWithAllSix: report.slotsWithAllSix,
      slotsMissingSomePairs: report.slotsMissingSomePairs,
      byPair: report.byPair,
      authority: report.authority,
    }));
  } finally {
    await client.end();
  }
}
module.exports = {
  PAIRS, V2, BROKER_IDS, ACTIVE_SCOPE_SQL, COVERAGE_SQL,
  summarize, runAudit, parseWindowMinutes,
};
if (require.main === module)
  main().catch((e) => {
    console.error('DEMO_CADENCE_RESEARCH_FAILED ' + String(e.message).slice(0, 160));
    process.exitCode = 1;
  });
