'use strict';
// Read-only comparison of persisted DEMO decision gates against realized trade
// economics. This report cannot approve trades or alter execution controls.
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT =
  '/home/lightworld/webapps/irexpro-research/wednesday-policy-funnel/latest-report.json';
const START = '2026-11-04T00:00:00Z';
const DECISION_SQL = [
  "SELECT to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,",
  "coalesce(d.governance->>'rolloutPolicyVersion','UNKNOWN') AS version,d.instrument,",
  'count(*)::int AS evaluations,',
  "count(*) FILTER(WHERE d.route<>'ABSTAIN')::int AS routed,",
  "count(*) FILTER(WHERE d.governance #>> '{multimodelEnsemble,paperAdmitted}'='true')::int AS admitted,",
  "count(*) FILTER(WHERE d.execution_authority='BROKER_NATIVE')::int AS authorized,",
  'count(*) FILTER(WHERE d.trade_intent_id IS NOT NULL)::int AS intents,',
  "count(*) FILTER(WHERE d.blockers ? 'M1_DEMO_INSTRUMENT_RESEARCH_ONLY')::int AS pair_veto,",
  'count(*) FILTER(WHERE d.blockers=\'["M1_DEMO_INSTRUMENT_RESEARCH_ONLY"]\'::jsonb)::int AS sole_pair_veto,',
  "count(*) FILTER(WHERE d.blockers ? 'DRIFT_OUT_OF_DISTRIBUTION')::int AS drift_veto,",
  "count(*) FILTER(WHERE d.blockers ? 'M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION')::int AS probation_veto,",
  "count(*) FILTER(WHERE d.blockers ? 'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED')::int AS reversal_veto,",
  "count(*) FILTER(WHERE d.blockers ? 'MULTIMODEL_CONTINUATION_TIMING_NOT_READY')::int AS continuation_veto,",
  "count(*) FILTER(WHERE d.blockers ? 'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK')::int AS loss_streak_veto",
  'FROM trading.m1_tactical_decisions d',
  'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
  'AND d.created_at >= $3::timestamptz AND d.created_at < $4::timestamptz',
  'GROUP BY 1,2,3 ORDER BY 1,2,3',
].join('\n');
const SOLE_SQL = [
  'SELECT d.created_at AS at,d.instrument,d.direction,d.bar_time AS bar_time',
  'FROM trading.m1_tactical_decisions d',
  'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
  'AND d.created_at >= $3::timestamptz AND d.created_at < $4::timestamptz',
  'AND d.blockers=\'["M1_DEMO_INSTRUMENT_RESEARCH_ONLY"]\'::jsonb',
  "AND d.governance #>> '{multimodelEnsemble,paperAdmitted}'='true'",
  "AND d.governance #>> '{multimodelAuthority,authorityPath}'='PRIMARY_PLAN_B'",
  "AND d.route<>'ABSTAIN'",
  'ORDER BY d.created_at LIMIT 1001',
].join('\n');
const TRADES_SQL = [
  "SELECT to_char(t.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,t.instrument,",
  'count(*)::int AS closed,',
  'count(*) FILTER(WHERE t.realised_pnl IS NULL OR t.commission IS NULL OR t.swap IS NULL)::int AS incomplete,',
  'count(*) FILTER(WHERE t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL',
  ' AND t.realised_pnl+t.commission+t.swap>0)::int AS net_winners,',
  'round(sum(t.realised_pnl) FILTER(WHERE t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL)::numeric,2) AS gross,',
  'round(sum(t.commission) FILTER(WHERE t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL)::numeric,2) AS commission,',
  'round(sum(t.realised_pnl+t.commission+t.swap) FILTER(WHERE t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL)::numeric,2) AS net',
  'FROM trading.trades t',
  "WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.account_currency='EUR'",
  "AND t.status='CLOSED' AND t.opened_at >= $3::timestamptz AND t.opened_at < $4::timestamptz",
  'GROUP BY 1,2 ORDER BY 1,2',
].join('\n');

function phase(v, day) {
  if (v === 'm1-tactical-rollout-v8-demo-professional')
    return day === '2026-11-04' ? 'WEDNESDAY_SIX' : 'EARLIER_SIX';
  if (v.includes('six-pair-v2')) return 'RESTORED_SIX_SHADOW_COST';
  if (v.includes('focused3') && v.includes('fee-shadow')) return 'FOCUSED3_SHADOW_COST';
  if (v.includes('focused3')) return 'FOCUSED3_COMMISSION_CHECK';
  if (v.includes('primary-only')) return 'SIX_PRIMARY_ONLY_TRANSITION';
  return 'UNKNOWN';
}
function collapseEpisodes(rows) {
  const usedBars = new Set();
  const lastByInstrument = new Map();
  const byInstrument = {};
  let bars = 0,
    episodes = 0;
  for (const x of [...rows].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const at = new Date(x.at).getTime();
    if (!Number.isFinite(at)) throw Error('INVALID_EPISODE_TIME');
    const key = [x.instrument, x.direction, new Date(x.bar_time || x.at).toISOString()].join('/');
    if (usedBars.has(key)) continue;
    usedBars.add(key);
    bars++;
    const last = lastByInstrument.get(x.instrument);
    if (last !== undefined && at - last < 30 * 60_000) continue;
    lastByInstrument.set(x.instrument, at);
    episodes++;
    byInstrument[x.instrument] = (byInstrument[x.instrument] || 0) + 1;
  }
  return { evaluations: rows.length, distinctBars: bars, spacedEpisodes: episodes, byInstrument };
}
function summarizeRows(rows) {
  const byPhase = {};
  for (const x of rows) {
    const label = phase(x.version, x.day);
    const group = (byPhase[label] ??= {
      evaluations: 0,
      routed: 0,
      admitted: 0,
      authorized: 0,
      intents: 0,
      pairVeto: 0,
      solePairVeto: 0,
      drift: 0,
      probation: 0,
      reversal: 0,
      continuation: 0,
      lossStreak: 0,
      days: [],
      instruments: {},
    });
    for (const [key, col] of Object.entries({
      evaluations: 'evaluations',
      routed: 'routed',
      admitted: 'admitted',
      authorized: 'authorized',
      intents: 'intents',
      pairVeto: 'pair_veto',
      solePairVeto: 'sole_pair_veto',
      drift: 'drift_veto',
      probation: 'probation_veto',
      reversal: 'reversal_veto',
      continuation: 'continuation_veto',
      lossStreak: 'loss_streak_veto',
    }))
      group[key] += Number(x[col]);
    if (!group.days.includes(x.day)) group.days.push(x.day);
    group.instruments[x.instrument] ??= { evaluations: 0, authorized: 0, solePairVeto: 0 };
    group.instruments[x.instrument].evaluations += Number(x.evaluations);
    group.instruments[x.instrument].authorized += Number(x.authorized);
    group.instruments[x.instrument].solePairVeto += Number(x.sole_pair_veto);
  }
  return byPhase;
}
async function runAudit({ client, userId, connectionId, since = START, until = new Date() }) {
  if (!UUID.test(userId || '') || !UUID.test(connectionId || '')) throw Error('INVALID_SCOPE');
  const start = new Date(since),
    end = new Date(until);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    end - start > 14 * 86400_000
  )
    throw Error('INVALID_WINDOW');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='45s'");
    const params = [userId, connectionId, start.toISOString(), end.toISOString()];
    const scope = await client.query(
      "SELECT id FROM broker.broker_connections WHERE user_id=$1 AND id=$2 AND broker_id='ctrader' AND account_type='DEMO' AND deleted_at IS NULL",
      [userId, connectionId],
    );
    if (scope.rows.length !== 1) throw Error('SCOPED_CTRADER_DEMO_NOT_FOUND');
    // A single pg Client does not support concurrent query submission safely.
    // Await sequentially to avoid deprecated query-queue behavior in pg@9.
    const decisions = await client.query(DECISION_SQL, params);
    const sole = await client.query(SOLE_SQL, params);
    const trades = await client.query(TRADES_SQL, params);
    if (sole.rows.length > 1000) throw Error('TRUNCATED_SOLE_GATE_DECISIONS');
    const report = {
      artifact: 'demo-policy-funnel-wednesday-vs-six-restored-v1',
      generatedAt: new Date().toISOString(),
      since: start.toISOString(),
      through: end.toISOString(),
      authority: 'RESEARCH_ONLY',
      modifiesExecution: false,
      modelFitted: false,
      phaseFunnel: summarizeRows(decisions.rows),
      pairOnlyEpisodes: collapseEpisodes(sole.rows),
      actualClosedBrokerTrades: trades.rows,
      methods: [
        'Only saved decision-time model policies are compared; counts overlap and are not independent signals.',
        'Sole pair veto means no other blocker was recorded at M1 admission. Risk, margin and broker order acceptance were not replayed.',
        '30-minute per-instrument cooldown after deduplicating same instrument/direction/bar prevents repeated evaluation inflation.',
        'Closed EUR broker-trade amounts include commission and swap only when all financial fields are present.',
        'No inference of future profit or eligibility for LIVE trading; zero broker writes.',
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
    path: process.env.IREXPRO_API_ENV_PATH || resolve(__dirname, '../.env'),
    quiet: true,
  });
  const { Client } = require('pg'),
    { getDatabaseSslOptions } = require('../dist/config/database-tls');
  const c = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev',
    user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-wednesday-policy-funnel-readonly',
  });
  try {
    await c.connect();
    const report = await runAudit({
      client: c,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
    });
    mkdirSync(resolve(REPORT, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      'DEMO_POLICY_FUNNEL ' +
        JSON.stringify({
          generatedAt: report.generatedAt,
          phases: report.phaseFunnel,
          pairOnlyEpisodes: report.pairOnlyEpisodes,
          authority: report.authority,
        }),
    );
  } finally {
    await c.end();
  }
}
module.exports = {
  phase,
  collapseEpisodes,
  summarizeRows,
  runAudit,
  DECISION_SQL,
  SOLE_SQL,
  TRADES_SQL,
};
if (require.main === module)
  main().catch((e) => {
    console.error('DEMO_POLICY_FUNNEL_FAILED ' + String(e.message).slice(0, 180));
    process.exitCode = 1;
  });
