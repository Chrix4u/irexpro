'use strict';

// READ-ONLY research of cTrader DEMO OOD regime candidates. No trading imports,
// broker order writes, threshold tuning or promotion authority. All labels are
// derived from decision-time evidence and strictly later broker-native quotes.
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const {
  pathState,
  feeRiskSample,
  median,
} = require('./audit-wednesday-six-pair-policy-shadow.cjs');

const ARTIFACT = 'ctrader-ood-regime-independent-15m-shadow-v1';
const REPORT_PATH =
  '/home/lightworld/webapps/irexpro-research/ood-shadow/latest-regime-report.json';
const START = '2026-11-04T00:00:00.000Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = 1200;

const DECISIONS_SQL = [
  'WITH ranked AS MATERIALIZED (',
  ' SELECT d.id,d.instrument,d.direction,d.created_at,d.candidate,d.governance,d.blockers,d.route,',
  " row_number() OVER (PARTITION BY d.instrument,date_bin('30 minutes',d.created_at,'2000-01-01T00:00:00Z'::timestamptz)",
  ' ORDER BY d.created_at ASC,d.id ASC) AS position',
  ' FROM trading.m1_tactical_decisions d',
  ' WHERE d.user_id=$1 AND d.broker_connection_id=$2',
  ' AND d.created_at >= $3::timestamptz AND d.created_at < $4::timestamptz',
  " AND d.direction IN ('BUY','SELL') AND d.route<>'ABSTAIN'",
  " AND d.candidate->>'stopLoss' IS NOT NULL AND d.candidate->>'takeProfit' IS NOT NULL",
  " AND d.governance #>> '{genericGovernance,driftState}'='OUT_OF_DISTRIBUTION'",
  '), chosen AS MATERIALIZED (',
  ' SELECT * FROM ranked WHERE position=1 ORDER BY created_at ASC,id ASC LIMIT $5::int',
  ')',
  'SELECT d.instrument,d.direction,d.created_at AS "createdAt",d.route AS "m1Route",',
  " d.governance #>> '{multimodelEnsemble,regime}' AS regime,",
  ' d.governance #>> \'{multimodelEnsemble,paperAdmitted}\' AS "planBAdmitted",',
  " d.governance #> '{genericGovernance,driftDiagnostics}' AS diagnostics,",
  ' d.blockers AS blockers,',
  ' (d.candidate->>\'stopLoss\')::numeric AS "stopLoss",',
  ' (d.candidate->>\'takeProfit\')::numeric AS "takeProfit",',
  ' e.bid_close AS "entryBid",e.ask_close AS "entryAsk",e.last_quote_sample_at AS "entryAt",',
  ' f.bid_close AS "futureBid",f.ask_close AS "futureAsk",f.last_quote_sample_at AS "futureAt",',
  ' p.bars AS "pathBars",p.first_bar AS "firstPathBar",p.last_bar AS "lastPathBar",',
  ' p.first_possible_stop AS "firstPossibleStop",p.first_possible_target AS "firstPossibleTarget",',
  ' p.first_quote_stop AS "firstQuoteStop",p.first_quote_target AS "firstQuoteTarget"',
  'FROM chosen d',
  'LEFT JOIN LATERAL (',
  ' SELECT q.bid_close,q.ask_close,q.last_quote_sample_at,q.bucket_time',
  ' FROM market_data.provider_quote_candles q',
  " WHERE q.connection_id=$2 AND q.instrument=d.instrument AND q.timeframe='M1'",
  " AND q.source='ctrader-broker-native' AND q.positive_quote_sample_count>0",
  ' AND q.bid_close>0 AND q.ask_close>=q.bid_close',
  " AND q.last_quote_sample_at>=d.created_at AND q.last_quote_sample_at<=d.created_at+interval '150 seconds'",
  " AND q.bucket_time>=date_trunc('minute',d.created_at)",
  " AND q.bucket_time<=date_trunc('minute',d.created_at)+interval '2 minutes'",
  " AND q.last_quote_sample_at>=q.bucket_time AND q.last_quote_sample_at<q.bucket_time+interval '1 minute'",
  ' ORDER BY q.last_quote_sample_at ASC LIMIT 1',
  ') e ON TRUE',
  'LEFT JOIN LATERAL (',
  ' SELECT q.bid_close,q.ask_close,q.last_quote_sample_at,q.bucket_time',
  ' FROM market_data.provider_quote_candles q',
  " WHERE q.connection_id=$2 AND q.instrument=d.instrument AND q.timeframe='M1'",
  " AND q.source='ctrader-broker-native' AND q.positive_quote_sample_count>0",
  ' AND q.bid_close>0 AND q.ask_close>=q.bid_close',
  ' AND e.last_quote_sample_at IS NOT NULL',
  " AND q.last_quote_sample_at>=e.last_quote_sample_at+interval '15 minutes'",
  " AND q.last_quote_sample_at<=e.last_quote_sample_at+interval '18 minutes'",
  " AND q.bucket_time>=date_trunc('minute',e.last_quote_sample_at+interval '15 minutes')-interval '1 minute'",
  " AND q.bucket_time<=date_trunc('minute',e.last_quote_sample_at+interval '18 minutes')",
  " AND q.last_quote_sample_at>=q.bucket_time AND q.last_quote_sample_at<q.bucket_time+interval '1 minute'",
  ' ORDER BY q.last_quote_sample_at ASC LIMIT 1',
  ') f ON TRUE',
  'LEFT JOIN LATERAL (',
  ' SELECT count(*)::int AS bars,min(q.bucket_time) AS first_bar,max(q.bucket_time) AS last_bar,',
  ' min(q.bucket_time) FILTER(WHERE',
  "   (d.direction='BUY' AND q.low-greatest(coalesce(q.spread_close,0),q.ask_close-q.bid_close) <= (d.candidate->>'stopLoss')::numeric) OR",
  "   (d.direction='SELL' AND q.high+greatest(coalesce(q.spread_close,0),q.ask_close-q.bid_close) >= (d.candidate->>'stopLoss')::numeric)) AS first_possible_stop,",
  ' min(q.bucket_time) FILTER(WHERE',
  "   (d.direction='BUY' AND q.high >= (d.candidate->>'takeProfit')::numeric) OR",
  "   (d.direction='SELL' AND q.low <= (d.candidate->>'takeProfit')::numeric)) AS first_possible_target,",
  ' min(q.bucket_time) FILTER(WHERE',
  "   (d.direction='BUY' AND q.bid_close <= (d.candidate->>'stopLoss')::numeric) OR",
  "   (d.direction='SELL' AND q.ask_close >= (d.candidate->>'stopLoss')::numeric)) AS first_quote_stop,",
  ' min(q.bucket_time) FILTER(WHERE',
  "   (d.direction='BUY' AND q.bid_close >= (d.candidate->>'takeProfit')::numeric) OR",
  "   (d.direction='SELL' AND q.ask_close <= (d.candidate->>'takeProfit')::numeric)) AS first_quote_target",
  ' FROM market_data.provider_quote_candles q',
  " WHERE q.connection_id=$2 AND q.instrument=d.instrument AND q.timeframe='M1'",
  " AND q.source='ctrader-broker-native' AND q.positive_quote_sample_count>0",
  ' AND q.bid_close>0 AND q.ask_close>=q.bid_close',
  ' AND e.bucket_time IS NOT NULL AND f.bucket_time IS NOT NULL',
  ' AND q.bucket_time>e.bucket_time AND q.bucket_time<=f.bucket_time',
  " AND q.last_quote_sample_at>=q.bucket_time AND q.last_quote_sample_at<q.bucket_time+interval '1 minute'",
  ' AND q.last_quote_sample_at<=f.last_quote_sample_at',
  ') p ON TRUE',
  'ORDER BY d.created_at ASC,d.instrument',
].join('\n');

const FEES_SQL = [
  'SELECT t.instrument,t.closed_at AS "closedAt",t.fill_price AS "fillPrice",',
  't.exit_price AS "exitPrice",t.stop_loss AS "stopLoss",',
  't.realised_pnl AS gross,t.commission,t.swap,t.lot_size AS "lotSize"',
  'FROM trading.trades t',
  "WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.status='CLOSED'",
  "AND t.account_currency='EUR' AND t.closed_at>=$3::timestamptz",
  'AND t.closed_at < $4::timestamptz',
  'ORDER BY t.closed_at ASC LIMIT 3001',
].join('\n');

function laneOf(record) {
  const d = new Set(Array.isArray(record.diagnostics) ? record.diagnostics : []);
  const regime = record.regime;
  if (regime === 'TREND_EXTENDED' && d.has('extensionAtr:HARD_HIGH'))
    return 'EXTENDED_TREND_EXCESS_EXTENSION';
  if (d.has('volatilityScore:HARD_LOW') && d.has('emaSeparation:HARD_LOW'))
    return 'LOW_VOLATILITY_RANGE';
  if (regime === 'TREND_WEAK' || d.has('mtfStrength:HARD_LOW')) return 'WEAK_OR_UNALIGNED_TREND';
  return 'MIXED_OTHER_OOD';
}

function aggregate(records) {
  const summary = {
    independentEpisodes: records.length,
    observed: 0,
    unobservable: 0,
    possibleStop: 0,
    possibleTarget: 0,
    unresolvedBarriers: 0,
    holdNoBarrier: 0,
    costCalibrated: 0,
    afterCostWinners: 0,
    netProxyRSum: 0,
    meanNetProxyR: null,
    positiveAfterCostFraction: null,
    utcDays: [],
  };
  const days = new Set();
  for (const x of records) {
    days.add(x.day);
    if (x.outcome.state === 'UNOBSERVABLE') {
      summary.unobservable++;
      continue;
    }
    summary.observed++;
    if (x.outcome.stopPossible) summary.possibleStop++;
    if (x.outcome.targetPossible) summary.possibleTarget++;
    if (x.outcome.state === 'NO_BARRIER_TOUCH') summary.holdNoBarrier++;
    else summary.unresolvedBarriers++;
    if (x.netR === null) continue;
    summary.costCalibrated++;
    summary.netProxyRSum += x.netR;
    if (x.netR > 0) summary.afterCostWinners++;
  }
  summary.netProxyRSum = Number(summary.netProxyRSum.toFixed(3));
  if (summary.costCalibrated) {
    summary.meanNetProxyR = Number((summary.netProxyRSum / summary.costCalibrated).toFixed(4));
    summary.positiveAfterCostFraction = Number(
      (summary.afterCostWinners / summary.costCalibrated).toFixed(4),
    );
  }
  summary.utcDays = [...days].sort();
  return summary;
}

function analyze(rows, feeRows, since, until) {
  const commissionSamples = feeRows.map(feeRiskSample).filter(Boolean);
  // Fixed 30-minute SQL buckets may be adjacent by a few seconds at their
  // boundary. Apply a second chronological 30-minute instrument-level
  // cooldown to avoid labeling overlapping positions as independent episodes.
  const independent = [];
  const lastByInstrument = new Map();
  let excludedAdjacentWindowOverlap = 0;
  for (const row of [...rows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    const at = new Date(row.createdAt).getTime();
    if (!Number.isFinite(at)) throw Error('INVALID_DECISION_TIME');
    const last = lastByInstrument.get(row.instrument);
    if (last !== undefined && at - last < 30 * 60_000) {
      excludedAdjacentWindowOverlap++;
      continue;
    }
    lastByInstrument.set(row.instrument, at);
    independent.push(row);
  }
  const items = independent.map((row) => {
    const outcome = pathState(row);
    const at = new Date(row.createdAt).getTime();
    const history = commissionSamples.filter(
      (s) => s.instrument === row.instrument && s.closedAt < at,
    );
    const fee = history.length >= 3 ? median(history.map((s) => s.commissionR)) : null;
    const validHold = outcome.state === 'NO_BARRIER_TOUCH' && fee !== null;
    return {
      lane: laneOf(row),
      instrument: row.instrument,
      day: new Date(row.createdAt).toISOString().slice(0, 10),
      planBAdmitted: row.planBAdmitted === 'true',
      hasNonDriftBlockers: (row.blockers || []).some(
        (b) => b !== 'DRIFT_OUT_OF_DISTRIBUTION' && b !== 'DRIFT_STRESSED',
      ),
      outcome,
      feeSamples: history.length,
      netR: validHold ? outcome.grossR - fee : null,
    };
  });
  const groupBy = (getKey) => {
    const groups = {};
    for (const x of items) (groups[getKey(x)] ??= []).push(x);
    return Object.fromEntries(
      Object.entries(groups)
        .sort()
        .map(([k, v]) => [k, aggregate(v)]),
    );
  };
  return {
    artifact: ARTIFACT,
    snapshotAt: new Date().toISOString(),
    since,
    through: until,
    mode: 'SHADOW_RESEARCH',
    modifiesExecution: false,
    modelFitted: false,
    promotionAllowed: false,
    sample: {
      selectedOnePerInstrumentPer30MinuteWindow: rows.length,
      spacedIndependentEpisodes: items.length,
      excludedAdjacentWindowOverlap,
      requiresContiguousQuotePath: true,
      primaryMarketSource: 'ctrader-broker-native-quoted-M1',
    },
    byLane: groupBy((x) => x.lane),
    byInstrumentLane: groupBy((x) => x.instrument + '/' + x.lane),
    byDayLane: groupBy((x) => x.day + '/' + x.lane),
    blockerOverlap: {
      total: items.length,
      notPlanBAdmitted: items.filter((x) => !x.planBAdmitted).length,
      additionalNonDriftBlockers: items.filter((x) => x.hasNonDriftBlockers).length,
    },
    cautions: [
      'This is not a retrained or promoted model. Existing market classification, Plan B and account risk checks remain untouched.',
      'Each 30-minute instrument window retains its first saved routed OOD decision; different FX pairs remain correlated.',
      'Only contiguous quote-side broker M1 paths with no possible intraminute stop/target touch are eligible for estimated 15m mark-to-market after historical as-of commission.',
      'Quote OHLC does not identify intraminute bid/ask high/low ordering; ambiguous paths are censored rather than assumed winners.',
      'Fees are estimated from strictly previous closed same-instrument DEMO trades; no hypothetical order was sent.',
      'Multiple OOD diagnostics can apply to one setup; lane assignment uses explicit precedence, not predictive model fitting.',
      'Use separate future chronological dates, minimum independent samples and actual broker net returns before considering promotion.',
    ],
  };
}
async function runAudit({ client, userId, connectionId, since = START, until = new Date() }) {
  if (!UUID.test(userId || '') || !UUID.test(connectionId || ''))
    throw Error('INVALID_EXACT_OWNER_SCOPE');
  const start = new Date(since),
    end = new Date(until);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    end - start > 14 * 86400000
  )
    throw Error('INVALID_BOUNDED_WINDOW');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='60000ms'");
    const sc = await client.query(
      "SELECT id FROM broker.broker_connections WHERE user_id=$1 AND id=$2 AND broker_id='ctrader' AND account_type='DEMO' AND deleted_at IS NULL",
      [userId, connectionId],
    );
    if (sc.rows.length !== 1) throw Error('CTRADER_DEMO_SCOPE_NOT_FOUND');
    const endForLabels = new Date(end.getTime() - 20 * 60000).toISOString();
    const sampled = await client.query(DECISIONS_SQL, [
      userId,
      connectionId,
      start.toISOString(),
      endForLabels,
      LIMIT + 1,
    ]);
    if (sampled.rows.length > LIMIT) throw Error('TOO_MANY_OOD_WINDOWS_INCREASE_DAY_SCOPING');
    const fees = await client.query(FEES_SQL, [
      userId,
      connectionId,
      new Date(start.getTime() - 30 * 86400000).toISOString(),
      end.toISOString(),
    ]);
    if (fees.rows.length > 3000) throw Error('TOO_MANY_FEE_ROWS');
    const report = analyze(sampled.rows, fees.rows, start.toISOString(), endForLabels);
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
  const db = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev',
    user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-ood-independent-regimes-readonly',
  });
  try {
    await db.connect();
    const report = await runAudit({
      client: db,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
      since: process.env.OOD_SHADOW_SINCE || START,
    });
    mkdirSync(resolve(REPORT_PATH, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      'OOD_REGIME_SHADOW ' +
        JSON.stringify({
          sample: report.sample,
          byLane: report.byLane,
          blockerOverlap: report.blockerOverlap,
          modifiesExecution: report.modifiesExecution,
          promotionAllowed: report.promotionAllowed,
        }),
    );
  } finally {
    await db.end();
  }
}
module.exports = { ARTIFACT, DECISIONS_SQL, FEES_SQL, laneOf, aggregate, analyze, runAudit };
if (require.main === module)
  main().catch((e) => {
    console.error('OOD_REGIME_SHADOW_FAILED ' + String(e.message).slice(0, 200));
    process.exitCode = 1;
  });
