'use strict';

// Broker-scoped, read-only half-hour admission and fill diagnostics.
// All displayed times use UTC, which is Ghana local time.
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAIRS = Object.freeze(['AUDUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY']);
const BROKER_IDS = Object.freeze(['ctrader', 'pepperstone-ctrader']);
const POLICY = 'm1-tactical-v8-demo-primary-fee-shadow-six-pair-v2';
const REPORT = '/home/lightworld/webapps/irexpro-research/intraday-funnel/latest-report.json';

const ACTIVE_SQL = [
  'SELECT s.broker_connection_id AS id',
  'FROM trading.trading_sessions s',
  'JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id',
  "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
  "AND b.broker_id=ANY($2::text[]) AND b.account_type='DEMO' AND b.deleted_at IS NULL",
  'ORDER BY s.authority_generation DESC,s.started_at DESC LIMIT 1',
].join('\n');

const HALF_HOUR =
  "date_trunc('hour', evaluated_at) + ((extract(minute from evaluated_at)::int / 30) * interval '30 minutes')";
const TRADE_HALF_HOUR =
  "date_trunc('hour', opened_at) + ((extract(minute from opened_at)::int / 30) * interval '30 minutes')";
const DECISIONS_SQL = [
  `SELECT ${HALF_HOUR} AS bucket, instrument,`,
  'count(*)::int AS evaluations,',
  "count(*) FILTER (WHERE execution_authority='BROKER_NATIVE')::int AS authorized,",
  "count(*) FILTER (WHERE blockers ? 'MULTIMODEL_PLAN_B_NOT_ADMITTED')::int AS planb,",
  "count(*) FILTER (WHERE blockers ? 'DRIFT_OUT_OF_DISTRIBUTION')::int AS ood,",
  "count(*) FILTER (WHERE blockers ? 'MULTIMODEL_CONTINUATION_TIMING_NOT_READY')::int AS timing,",
  "count(*) FILTER (WHERE blockers ? 'EVENT_RISK_HIGH_IMPACT_BLOCK')::int AS news,",
  "count(*) FILTER (WHERE blockers ? 'M1_DEMO_INSTRUMENT_RESEARCH_ONLY')::int AS old_pair_veto",
  'FROM trading.m1_tactical_decisions',
  'WHERE user_id=$1 AND broker_connection_id=$2',
  'AND evaluated_at >= $3::timestamptz AND evaluated_at < $4::timestamptz',
  "AND governance->>'rolloutPolicyVersion'=$5 AND instrument=ANY($6::text[])",
  'GROUP BY 1,2 ORDER BY 1,2',
].join('\n');

const TRADES_SQL = [
  `SELECT ${TRADE_HALF_HOUR} AS bucket, count(*)::int AS opened`,
  'FROM trading.trades',
  'WHERE user_id=$1 AND broker_connection_id=$2',
  'AND opened_at >= $3::timestamptz AND opened_at < $4::timestamptz',
  'AND instrument=ANY($5::text[])',
  'GROUP BY 1 ORDER BY 1',
].join('\n');

function validCount(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw Error('INVALID_COUNT');
  return value;
}
function timeKey(raw, start, end) {
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms) || ms < start || ms >= end || ms % 1800000 !== 0)
    throw Error('INVALID_HALF_HOUR_BUCKET');
  return new Date(ms).toISOString();
}
function periodForBucket(bucket) {
  const when = new Date(bucket);
  return when.getUTCHours() > 13 || (when.getUTCHours() === 13 && when.getUTCMinutes() >= 30)
    ? 'AFTER_1330_GHANA'
    : 'BEFORE_1330_GHANA';
}
function emptyTotals() {
  return {
    evaluations: 0,
    authorized: 0,
    opened: 0,
    planb: 0,
    ood: 0,
    timing: 0,
    news: 0,
    oldPairVeto: 0,
  };
}
function add(to, from) {
  for (const k of Object.keys(emptyTotals())) to[k] += from[k] || 0;
}
function summarize(decisions, trades, since, through) {
  const start = new Date(since).getTime();
  const end = new Date(through).getTime();
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    start % 1800000 !== 0 ||
    end % 1800000 !== 0 ||
    end - start > 3 * 86400000
  )
    throw Error('INVALID_WINDOW');
  const buckets = new Map();
  const observedPairs = new Set();
  function getBucket(key) {
    if (!buckets.has(key))
      buckets.set(key, {
        bucket: key,
        period: periodForBucket(key),
        ...emptyTotals(),
        byPair: {},
      });
    return buckets.get(key);
  }
  for (const row of decisions) {
    if (!PAIRS.includes(row.instrument)) throw Error('UNEXPECTED_INSTRUMENT');
    const key = timeKey(row.bucket, start, end);
    const b = getBucket(key);
    if (b.byPair[row.instrument]) throw Error('DUPLICATE_PAIR_BUCKET');
    const counts = {
      evaluations: validCount(row.evaluations),
      authorized: validCount(row.authorized),
      opened: 0,
      planb: validCount(row.planb),
      ood: validCount(row.ood),
      timing: validCount(row.timing),
      news: validCount(row.news),
      oldPairVeto: validCount(row.old_pair_veto),
    };
    if (Object.keys(counts).some((k) => counts[k] > counts.evaluations))
      throw Error('INVALID_AGGREGATE');
    b.byPair[row.instrument] = counts;
    add(b, counts);
    observedPairs.add(row.instrument);
  }
  for (const row of trades) {
    const key = timeKey(row.bucket, start, end);
    getBucket(key).opened += validCount(row.opened);
  }
  const halfHours = [...buckets.values()]
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((b) => ({ ...b, missingPairs: PAIRS.filter((p) => !b.byPair[p]) }));
  const byDay = {};
  for (const b of halfHours) {
    const day = b.bucket.slice(0, 10);
    if (!byDay[day])
      byDay[day] = {
        BEFORE_1330_GHANA: emptyTotals(),
        AFTER_1330_GHANA: emptyTotals(),
      };
    add(byDay[day][b.period], b);
  }
  const afternoonZeroAuthorization = Object.entries(byDay)
    .filter(([, d]) => d.AFTER_1330_GHANA.evaluations >= 100 && d.AFTER_1330_GHANA.authorized === 0)
    .map(([date]) => date);
  return {
    timezone: 'Africa/Accra (UTC+00:00)',
    policyVersion: POLICY,
    since: new Date(start).toISOString(),
    through: new Date(end).toISOString(),
    observedPairs: [...observedPairs].sort(),
    byDay,
    halfHours,
    observations: {
      afternoonZeroAuthorizationDates: afternoonZeroAuthorization,
      afternoonNoAuthorizationIsNotEvidenceOfAClockBan: true,
    },
    authority: 'RESEARCH_ONLY',
    modifiesExecution: false,
    limitations: [
      'Persisted M1 decisions are evaluations, not unique market opportunities.',
      'Blocked reasons overlap; sums of blocker counts are not distinct opportunities.',
      'BROKER_NATIVE is an authorization decision; opened counts come separately from recorded trades.',
      'Missing pair buckets are not proof of lost broker market data; inspect feed and session logs.',
      'Time boundaries are Ghana local for November 2026; they are not immutable global market session definitions.',
      'No trading authority, model parameters, order routing, risk gates or broker settings are altered.',
    ],
  };
}

async function runAudit(client, userId, since, through) {
  if (!UUID.test(userId || '')) throw Error('INVALID_OWNER_SCOPE');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='45s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const active = await client.query(ACTIVE_SQL, [userId, [...BROKER_IDS]]);
    if (active.rows.length !== 1 || !UUID.test(active.rows[0].id || ''))
      throw Error('NO_ACTIVE_OWNED_CTRADER_DEMO_SESSION');
    const connectionId = active.rows[0].id;
    const [decisions, trades] = await Promise.all([
      client.query(DECISIONS_SQL, [userId, connectionId, since, through, POLICY, [...PAIRS]]),
      client.query(TRADES_SQL, [userId, connectionId, since, through, [...PAIRS]]),
    ]);
    if (decisions.rows.length > 900 || trades.rows.length > 150)
      throw Error('UNBOUNDED_AUDIT_RESULTS');
    const report = summarize(decisions.rows, trades.rows, since, through);
    await client.query('COMMIT');
    return report;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function main() {
  require('dotenv').config({
    path: process.env.IREXPRO_API_ENV_PATH || resolve(__dirname, '../.env'),
    quiet: true,
  });
  const { Client } = require('pg');
  const { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const now = new Date();
  // Include yesterday and today, ending at the last complete half-hour.
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const through = new Date(Math.floor(now.getTime() / 1800000) * 1800000);
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev',
    user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-intraday-funnel-readonly',
  });
  try {
    await client.connect();
    const report = await runAudit(
      client,
      process.env.VPS_FOREX_SCANNER_USER_ID,
      since.toISOString(),
      through.toISOString(),
    );
    mkdirSync(resolve(REPORT, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(
      REPORT,
      JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2),
      { mode: 0o600 },
    );
    console.log(
      'INTRADAY_DEMO_FUNNEL ' +
        JSON.stringify({
          since: report.since,
          through: report.through,
          byDay: report.byDay,
          observations: report.observations,
          authority: report.authority,
        }),
    );
  } finally {
    await client.end();
  }
}
module.exports = {
  PAIRS,
  POLICY,
  ACTIVE_SQL,
  DECISIONS_SQL,
  TRADES_SQL,
  periodForBucket,
  summarize,
  runAudit,
};
if (require.main === module)
  main().catch((e) => {
    console.error('INTRADAY_DEMO_FUNNEL_FAILED ' + String(e.message).slice(0, 160));
    process.exitCode = 1;
  });
