'use strict';

// Research-only recovery watch for DEMO M1 pair-side loss-streak brakes.
// Never reads or modifies trading-session controls, order dispatch, promotion
// state, reliability eligibility or live risk rules.
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { feeRiskSample, median } = require('./audit-wednesday-six-pair-policy-shadow.cjs');

const ARTIFACT = 'demo-m1-loss-brake-fresh-quote-recovery-v1';
const REPORT =
  '/home/lightworld/webapps/irexpro-research/m1-loss-brake-recovery/latest-report.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_EPISODES = 12,
  MIN_DAYS = 3,
  MIN_FEE_SAMPLES = 3,
  COOLDOWN_MS = 30 * 60_000;
const START_WINDOW_HOURS = 3,
  MAX_RECENT = 5000,
  MAX_SHADOW = 1200,
  MAX_FEES = 3000;

const RECENT_SQL = [
  'SELECT d.created_at AS "createdAt",d.instrument,d.direction,d.route,d.policy_version AS "policyVersion",',
  " d.governance->'reliability' AS reliability",
  'FROM trading.m1_tactical_decisions d',
  'WHERE d.user_id=$1 AND d.broker_connection_id=$2',
  ' AND d.created_at >= $3::timestamptz AND d.created_at <= $4::timestamptz',
  " AND d.route<>'ABSTAIN' AND d.governance->'reliability' IS NOT NULL",
  'ORDER BY d.created_at DESC,d.id DESC LIMIT $5::int',
].join('\n');

const LOSSES_SQL = [
  'SELECT DISTINCT ON(t.id) t.id,t.closed_at AS "closedAt",t.realised_pnl AS gross,',
  ' t.commission,t.swap',
  'FROM trading.trades t',
  'JOIN trading.m1_tactical_decisions d ON d.trade_intent_id=t.trade_intent_id',
  ' AND d.user_id=t.user_id AND d.broker_connection_id=t.broker_connection_id',
  'WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.instrument=$3 AND t.direction=$4',
  ' AND d.route=$5 AND d.policy_version=$6',
  " AND t.status='CLOSED' AND t.account_currency='EUR'",
  ' AND t.closed_at >= $7::timestamptz AND t.closed_at <= $8::timestamptz',
  ' AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL',
  'ORDER BY t.id,t.closed_at DESC LIMIT 101',
].join('\n');

const SHADOW_SQL = [
  'SELECT d.id,d.created_at AS "createdAt",d.governance->\'shadowOutcome15mV1\' AS outcome,',
  ' d.blockers',
  'FROM trading.m1_tactical_decisions d',
  'WHERE d.user_id=$1 AND d.broker_connection_id=$2 AND d.instrument=$3 AND d.direction=$4',
  ' AND d.route=$5 AND d.policy_version=$6',
  ' AND d.created_at > $7::timestamptz AND d.created_at <= $8::timestamptz',
  " AND d.governance->'reliability'->>'reason'='EARLY_LOSS_STREAK'",
  " AND d.governance->'shadowOutcome15mV1'->>'artifact'='m1-shadow-outcome-15m-v1'",
  'ORDER BY d.created_at ASC,d.id ASC LIMIT 1201',
].join('\n');

const FEES_SQL = [
  'SELECT t.instrument,t.closed_at AS "closedAt",t.fill_price AS "fillPrice",',
  ' t.exit_price AS "exitPrice",t.stop_loss AS "stopLoss",',
  ' t.realised_pnl AS gross,t.commission,t.swap,t.lot_size AS "lotSize"',
  'FROM trading.trades t',
  'WHERE t.user_id=$1 AND t.broker_connection_id=$2',
  " AND t.status='CLOSED' AND t.account_currency='EUR'",
  ' AND t.closed_at >= $3::timestamptz AND t.closed_at <= $4::timestamptz',
  'ORDER BY t.closed_at ASC LIMIT 3001',
].join('\n');

function finiteNumber(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function time(x) {
  if (!x) return null;
  const n = new Date(x).getTime();
  return Number.isFinite(n) ? n : null;
}
function historyStatus(rows, asOf) {
  const recent = [...rows].sort((a, b) => time(b.closedAt) - time(a.closedAt));
  const latest = recent.slice(0, 3);
  const allComplete = latest.every(
    (x) =>
      finiteNumber(x.gross) !== null &&
      finiteNumber(x.commission) !== null &&
      finiteNumber(x.swap) !== null &&
      time(x.closedAt) !== null &&
      time(x.closedAt) <= asOf,
  );
  if (
    latest.length < 3 ||
    !allComplete ||
    !latest.every(
      (x) =>
        finiteNumber(x.gross) < 0 &&
        finiteNumber(x.gross) + finiteNumber(x.commission) + finiteNumber(x.swap) < 0,
    )
  )
    return { confirmed: false, latestThreeNetEUR: null, lastLossAt: null, ageOutAt: null };
  const lastLossAt = time(latest[0].closedAt);
  const thirdOldest = time(latest[2].closedAt);
  return {
    confirmed: true,
    latestThreeNetEUR: Number(
      latest
        .reduce(
          (sum, x) =>
            sum + finiteNumber(x.gross) + finiteNumber(x.commission) + finiteNumber(x.swap),
          0,
        )
        .toFixed(2),
    ),
    lastLossAt: new Date(lastLossAt).toISOString(),
    ageOutAt: new Date(thirdOldest + 7 * 24 * 60 * 60_000).toISOString(),
  };
}

function validateMatureOutcome(row, asOf, after) {
  const d = time(row.createdAt),
    o = row.outcome;
  if (!o || !d || d <= after) return { reason: 'OUTSIDE_FRESH_AFTER_LOSS_WINDOW' };
  if (
    o.artifact !== 'm1-shadow-outcome-15m-v1' ||
    o.modifiesExecution !== false ||
    o.source !== 'COMPLETED_M1_OHLC' ||
    o.executionCostSource !== 'BROKER_OBSERVED_P90' ||
    o.episodeLeaderDecisionId !== row.id ||
    o.outcome === 'AMBIGUOUS' ||
    !['TP', 'SL', 'MTM'].includes(o.outcome)
  )
    return { reason: 'UNVERIFIED_OR_AMBIGUOUS_QUOTE_OUTCOME' };
  const observed = time(o.observedAt),
    entry = time(o.entryBarOpenTime),
    net = finiteNumber(o.netRMultiple);
  if (
    !observed ||
    !entry ||
    entry <= d ||
    observed < d + 15 * 60_000 ||
    observed > asOf ||
    net === null ||
    Math.abs(net) > 5 ||
    !Number.isFinite(finiteNumber(o.estimatedExecutionCostR)) ||
    finiteNumber(o.estimatedExecutionCostR) < 0
  )
    return { reason: 'INVALID_OR_NONCAUSAL_QUOTE_OUTCOME' };
  return { netRBeforeCommission: net, observedAt: observed, reason: null };
}

function summarizeFresh(rows, feeSamples, anchor, asOf) {
  const observedRows = [...rows].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  let prior = null,
    excludedOverlap = 0,
    invalidQuote = 0,
    missingAsOfCommission = 0,
    overlapWithOtherBlockers = 0;
  const priced = [],
    days = new Set();
  for (const row of observedRows) {
    const at = time(row.createdAt);
    if (at === null || at <= anchor || at > asOf) {
      invalidQuote++;
      continue;
    }
    if (prior !== null && at - prior < COOLDOWN_MS) {
      excludedOverlap++;
      continue;
    }
    prior = at; // Do not substitute a favorable later sample for the episode leader.
    const validated = validateMatureOutcome(row, asOf, anchor);
    if (validated.reason !== null) {
      invalidQuote++;
      continue;
    }
    const costs = feeSamples.filter((s) => s.closedAt < at).map((s) => s.commissionR);
    if (costs.length < MIN_FEE_SAMPLES) {
      missingAsOfCommission++;
      continue;
    }
    const cost = median(costs);
    const netR = validated.netRBeforeCommission - cost;
    priced.push({ netR, at, day: new Date(at).toISOString().slice(0, 10) });
    days.add(new Date(at).toISOString().slice(0, 10));
    if (
      Array.isArray(row.blockers) &&
      row.blockers.some(
        (b) =>
          b !== 'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK' && b !== 'M1_RELIABILITY_EARLY_LOSS_STREAK',
      )
    )
      overlapWithOtherBlockers++;
  }
  const grossPositive = priced.reduce((sum, x) => sum + Math.max(x.netR, 0), 0);
  const grossNegative = -priced.reduce((sum, x) => sum + Math.min(x.netR, 0), 0);
  const sumNetR = grossPositive - grossNegative;
  const profitFactor = grossNegative > 0 ? grossPositive / grossNegative : null;
  const positive = priced.filter((x) => x.netR > 0).length;
  const positiveFraction = priced.length ? positive / priced.length : null;
  const meanNetR = priced.length ? sumNetR / priced.length : null;
  const enough = priced.length >= MIN_EPISODES && days.size >= MIN_DAYS;
  const promising =
    enough &&
    sumNetR > 0 &&
    profitFactor !== null &&
    profitFactor >= 1.3 &&
    positiveFraction >= 0.52 &&
    meanNetR >= 0.1;
  const state = !enough
    ? 'COLLECTING_FRESH_EVIDENCE'
    : promising
      ? 'RESEARCH_RECOVERY_SIGNAL'
      : 'FRESH_EDGE_NOT_CONFIRMED';
  return {
    state,
    executionAuthority: 'NONE',
    canReactivate: false,
    checkedSettledDecisions: rows.length,
    independentPricedEpisodes: priced.length,
    distinctUtcDays: days.size,
    dayLabels: [...days].sort(),
    excludedOverlap,
    invalidQuote,
    missingAsOfCommission,
    otherBlockerOverlapAmongPriced: overlapWithOtherBlockers,
    quoteProxyNetRSum: Number(sumNetR.toFixed(3)),
    quoteProxyMeanNetR: meanNetR === null ? null : Number(meanNetR.toFixed(4)),
    quoteProxyProfitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(3)),
    quoteProxyPositiveFraction:
      positiveFraction === null ? null : Number(positiveFraction.toFixed(4)),
    required: {
      minIndependentEpisodes: MIN_EPISODES,
      minDistinctUtcDays: MIN_DAYS,
      minProfitFactor: 1.3,
      minPositiveFraction: 0.52,
      minMeanNetR: 0.1,
    },
  };
}

async function runAudit({ client, userId, connectionId, asOf = new Date() }) {
  if (!UUID.test(userId || '') || !UUID.test(connectionId || '') || time(asOf) === null)
    throw Error('INVALID_DEMO_OWNER_SCOPE_OR_TIME');
  const at = new Date(asOf),
    stamp = at.toISOString(),
    cutoff = new Date(at.getTime() - START_WINDOW_HOURS * 3600_000).toISOString();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='45s'");
    const scope = await client.query(
      "SELECT id FROM broker.broker_connections WHERE user_id=$1 AND id=$2 AND broker_id='ctrader' AND account_type='DEMO' AND deleted_at IS NULL",
      [userId, connectionId],
    );
    if (scope.rows.length !== 1) throw Error('EXACT_CTRADER_DEMO_SCOPE_NOT_FOUND');
    const recent = await client.query(RECENT_SQL, [
      userId,
      connectionId,
      cutoff,
      stamp,
      MAX_RECENT + 1,
    ]);
    if (recent.rows.length > MAX_RECENT) throw Error('TRUNCATED_RECENT_DECISIONS');
    const latestByKey = new Map();
    for (const r of recent.rows) {
      const key = [r.instrument, r.direction, r.route, r.policyVersion].join('/');
      if (!latestByKey.has(key)) latestByKey.set(key, r);
    }
    const paused = [...latestByKey.values()].filter(
      (r) => r.reliability?.reason === 'EARLY_LOSS_STREAK',
    );
    const feeRows = await client.query(FEES_SQL, [
      userId,
      connectionId,
      new Date(at.getTime() - 30 * 86400_000).toISOString(),
      stamp,
    ]);
    if (feeRows.rows.length > MAX_FEES) throw Error('TRUNCATED_COMMISSION_HISTORY');
    const allFees = feeRows.rows.map(feeRiskSample).filter(Boolean);
    const watchers = [];
    for (const watch of paused) {
      const args = [
        userId,
        connectionId,
        watch.instrument,
        watch.direction,
        watch.route,
        watch.policyVersion,
        new Date(at.getTime() - 7 * 86400_000).toISOString(),
        stamp,
      ];
      const trades = await client.query(LOSSES_SQL, args);
      if (trades.rows.length > 100) throw Error('TRUNCATED_ROUTE_TRADE_HISTORY');
      const losses = historyStatus(trades.rows, at.getTime());
      let fresh = null;
      if (losses.confirmed) {
        const obs = await client.query(SHADOW_SQL, [...args.slice(0, 6), losses.lastLossAt, stamp]);
        if (obs.rows.length > MAX_SHADOW) throw Error('TRUNCATED_SHADOW_OUTCOMES');
        fresh = summarizeFresh(
          obs.rows,
          allFees.filter((x) => x.instrument === watch.instrument),
          time(losses.lastLossAt),
          at.getTime(),
        );
      }
      watchers.push({
        instrument: watch.instrument,
        direction: watch.direction,
        route: watch.route,
        policyVersion: watch.policyVersion,
        lastDecisionAt: watch.createdAt,
        brakeReason: watch.reliability.reason,
        lossHistory: losses,
        shadowRecovery: fresh,
        note: losses.confirmed
          ? 'Loss brake remains in place; no shadow observation grants execution.'
          : 'Read-only loss-streak audit could not reproduce 3 complete negative broker trades; do not override reliability.',
      });
    }
    await client.query('COMMIT');
    return {
      artifact: ARTIFACT,
      asOf: stamp,
      scope: 'EXACT_CTRADER_DEMO_USER_BROKER',
      authority: 'RESEARCH_ONLY',
      modifiesExecution: false,
      canReactivate: false,
      modelFitted: false,
      brakedPairSideRoutes: watchers.length,
      watchers,
      methodology:
        'Only settled cTrader M1 shadow outcomes strictly after most recent executed route loss. De-duplicate 30m episodes, require historical same-pair commission before decision and multiple independent UTC dates.',
      caveats: [
        'A shadow recovery signal is NOT production qualification, an execution permission or proof of broker profit.',
        'M1 completed OHLC high/low touch sequence and fills are proxies; no order was submitted.',
        'The stored M1 net R already includes the observed quote execution-cost estimate; historic actual broker commissions are additional as-of risk-unit estimates. Swap/slippage on a hypothetical trade are not provable.',
        'The 7-day rolling loss brake is neither reset nor shortened. Account, portfolio, event, risk, Plan B and drift vetoes remain unchanged.',
        'Age-out times assume no newer fills modify the historical evidence window.',
        'Do not promote without separate forward broker DEMO net returns, drawdown, multi-day folds and independent approval.',
      ],
    };
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
  const db = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev',
    user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-m1-loss-brake-recovery-readonly',
  });
  try {
    await db.connect();
    const report = await runAudit({
      client: db,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
    });
    mkdirSync(resolve(REPORT, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      'M1_DEMO_LOSS_BRAKE_RECOVERY ' +
        JSON.stringify({
          asOf: report.asOf,
          watchers: report.watchers,
          modifiesExecution: report.modifiesExecution,
          canReactivate: report.canReactivate,
        }),
    );
  } finally {
    await db.end();
  }
}
module.exports = {
  ARTIFACT,
  RECENT_SQL,
  LOSSES_SQL,
  SHADOW_SQL,
  FEES_SQL,
  historyStatus,
  validateMatureOutcome,
  summarizeFresh,
  runAudit,
};
if (require.main === module)
  main().catch((e) => {
    console.error('M1_DEMO_LOSS_BRAKE_RECOVERY_FAILED ' + String(e.message).slice(0, 200));
    process.exitCode = 1;
  });
