'use strict';

// Read-only research only; do not import into execution services or schedule it.
const { resolve } = require('node:path');
const ARTIFACT = 'cross-engine-reentry-churn-observation-v1';
const HORIZONS_MINUTES = Object.freeze([5, 10, 15, 30]);
const MAX_TRADES = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGINES = new Set(['external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble']);
const SCOPE_SQL = `
  SELECT current_timestamp AS "snapshotAt"
  FROM broker.broker_connections
  WHERE id = $1 AND user_id = $2 AND broker_id = 'ctrader'
    AND account_type = 'DEMO' AND deleted_at IS NULL
`;
const TRADES_SQL = `
  SELECT t.id AS "tradeId", t.instrument, t.direction, t.status,
    t.opened_at AS "openedAt", t.closed_at AS "closedAt", t.close_reason AS "closeReason",
    t.realised_pnl AS "realisedPnl", t.commission, t.swap,
    t.account_currency AS "currency",
    ti.strategy_code AS "strategyCode",
    COALESCE(NULLIF(ti.metadata->>'multimodel_plan_b_route', ''), 'UNKNOWN') AS "strategyRoute"
  FROM trading.trades t
  JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
    AND ti.user_id = $1 AND ti.broker_connection_id = $2
  WHERE t.user_id = $1 AND t.broker_connection_id = $2
    AND t.opened_at >= ($3::timestamptz - interval '60 minutes')
    AND t.opened_at <= $4::timestamptz
    AND t.status IN ('CLOSED','OPEN')
    AND ti.strategy_code IN ('external-irexpro-m1-tactical',
                             'external-irexpro-multimodel-ensemble')
  ORDER BY t.opened_at ASC, t.id ASC
  LIMIT $5::int
`;
const timed = (t) => {
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
};
function num(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function round(x, places = 2) {
  return Number(x.toFixed(places));
}
function normalizeTrade(row) {
  const opened = timed(row.openedAt);
  const closed = timed(row.closedAt);
  const direction = row.direction;
  const instrument = String(row.instrument ?? '')
    .trim()
    .toUpperCase();
  const route = String(row.strategyRoute ?? 'UNKNOWN').trim() || 'UNKNOWN';
  const currency =
    String(row.currency ?? 'UNKNOWN')
      .trim()
      .toUpperCase() || 'UNKNOWN';
  const pnl = num(row.realisedPnl),
    commission = num(row.commission),
    swap = num(row.swap);
  const closedValid =
    row.status === 'CLOSED' && closed !== null && opened !== null && closed >= opened;
  const costsComplete = closedValid && pnl !== null && commission !== null && swap !== null;
  const net = costsComplete ? round(pnl - Math.abs(commission) + swap, 8) : null;
  return {
    tradeId: String(row.tradeId ?? ''),
    instrument,
    direction,
    currency,
    route,
    engine: row.strategyCode,
    opened,
    closed,
    status: row.status,
    closeReason: String(row.closeReason ?? 'UNKNOWN'),
    gross: costsComplete ? pnl : null,
    commission: costsComplete ? Math.abs(commission) : null,
    swap: costsComplete ? swap : null,
    net,
    valid: Boolean(
      opened !== null &&
      ['BUY', 'SELL'].includes(direction) &&
      instrument.length > 0 &&
      ENGINES.has(row.strategyCode) &&
      closedValid,
    ),
  };
}
function summary(events) {
  const count = events.length;
  const observed = events.filter((x) => x.net !== null);
  const complete = observed.length;
  const sum = (name) => round(observed.reduce((s, x) => s + (x[name] ?? 0), 0));
  return {
    entries: count,
    withCompleteCosts: complete,
    missingCostsOrOutcome: count - complete,
    afterCostWinners: observed.filter((x) => x.net > 0).length,
    afterCostLosers: observed.filter((x) => x.net < 0).length,
    afterCostFlat: observed.filter((x) => x.net === 0).length,
    grossWinnersNonPositiveNet: observed.filter((x) => x.gross > 0 && x.net <= 0).length,
    grossPnl: sum('gross'),
    commissions: sum('commission'),
    swap: sum('swap'),
    netAfterRecordedCosts: sum('net'),
  };
}
function group(events, key) {
  return Object.fromEntries(
    [...Map.groupBy(events, (x) => x.currency + ' | ' + key(x))]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, rows]) => [k, summary(rows)]),
  );
}
function previousClosed(sortedCloses, beforeMs) {
  let lo = 0,
    hi = sortedCloses.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedCloses[mid].closed < beforeMs) lo = mid + 1;
    else hi = mid;
  }
  // Full bounded history needed so other strategy routes cannot hide an older
  // same-route loss sequence. The SQL query is capped at MAX_TRADES.
  return sortedCloses.slice(0, lo);
}
function analyzeReentries(raw, from, snapshotAt) {
  const fromMs = timed(from),
    now = timed(snapshotAt);
  if (fromMs === null || now === null || fromMs > now || now - fromMs > 14 * 864e5) {
    throw Error('INVALID_RESEARCH_WINDOW');
  }
  if (!Array.isArray(raw) || raw.length > MAX_TRADES) throw Error('TOO_MANY_TRADES');
  const trades = raw.map(normalizeTrade);
  const ignoredInvalid = trades.filter((x) => !x.valid).length;
  // Closed history is read across BOTH M1 and Plan-B engines. Sorted by actual
  // closure, not by entry, so overlapping trades cannot produce false re-entries.
  const closes = new Map();
  for (const t of trades) {
    if (!t.valid || t.closed > now || t.closed < fromMs - 60 * 60000) continue;
    const key = [t.instrument, t.direction].join('|');
    const entries = closes.get(key) ?? [];
    entries.push(t);
    closes.set(key, entries);
  }
  for (const list of closes.values()) list.sort((a, b) => a.closed - b.closed);
  const candidates = trades.filter(
    (t) => t.opened !== null && t.opened >= fromMs && t.opened <= now && t.valid,
  );
  const seen = new Set();
  const annotated = [];
  for (const t of candidates) {
    if (seen.has(t.tradeId)) continue;
    seen.add(t.tradeId);
    const prior = previousClosed(closes.get([t.instrument, t.direction].join('|')) ?? [], t.opened);
    const previous = prior.at(-1) ?? null;
    const gap = previous ? (t.opened - previous.closed) / 60_000 : null;
    const past60 = prior.filter((x) => x.closed >= t.opened - 60 * 60000);
    const last4 = past60.filter((x) => x.route === t.route).slice(-4);
    const last4NetKnown = last4.length === 4 && last4.every((x) => x.net !== null);
    const last4Net = last4NetKnown ? round(last4.reduce((s, x) => s + x.net, 0)) : null;
    annotated.push({
      ...t,
      gapMinutes: gap === null ? null : round(gap, 4),
      priorReason: previous?.closeReason ?? null,
      priorEngine: previous?.engine ?? null,
      crossEngine: previous !== null && previous.engine !== t.engine,
      last4SameRouteNet: last4Net,
      last4SameRouteEngines: last4NetKnown ? new Set(last4.map((x) => x.engine)).size : null,
    });
  }
  const reentries = annotated.filter(
    (x) => x.gapMinutes !== null && x.gapMinutes >= 0 && x.gapMinutes <= 30,
  );
  const results = {};
  for (const horizon of HORIZONS_MINUTES) {
    const subset = reentries.filter((x) => x.gapMinutes <= horizon);
    results[horizon + 'm'] = {
      byCurrency: group(subset, () => 'ALL'),
      byRoute: group(subset, (x) => x.route),
      byPairSide: group(subset, (x) => x.instrument + '/' + x.direction),
      bySleeve: group(subset, (x) => x.instrument + '/' + x.direction + '/' + x.route),
      byPriorExit: group(subset, (x) => x.priorReason),
      byPriorExitAndRoute: group(subset, (x) => x.priorReason + '/' + x.route),
      byPriorExitAndSleeve: group(
        subset,
        (x) => x.priorReason + '/' + x.instrument + '/' + x.direction + '/' + x.route,
      ),
      byEngineTransition: group(subset, (x) => (x.crossEngine ? 'CROSS_ENGINE' : 'SAME_ENGINE')),
    };
  }
  const bins = [
    [0, 5],
    [5, 10],
    [10, 15],
    [15, 30],
  ];
  const sleeveGroups = Map.groupBy(
    trades.filter((x) => x.valid && x.net !== null && x.closed >= fromMs && x.closed <= now),
    (x) => [x.currency, x.instrument, x.direction, x.route].join('|'),
  );
  const clusters = [];
  for (const [sleeve, list] of sleeveGroups) {
    list.sort((a, b) => a.closed - b.closed);
    let streak = [];
    const finish = () => {
      if (streak.length < 3) return;
      const stats = summary(streak);
      clusters.push({
        currency: sleeve.split('|')[0],
        instrument: streak[0].instrument,
        direction: streak[0].direction,
        route: streak[0].route,
        firstCloseAt: new Date(streak[0].closed).toISOString(),
        lastCloseAt: new Date(streak.at(-1).closed).toISOString(),
        engineCount: new Set(streak.map((x) => x.engine)).size,
        ...stats,
      });
    };
    for (const trade of list) {
      if (streak.length && trade.closed - streak.at(-1).closed > 60 * 60000) {
        finish();
        streak = [];
      }
      streak.push(trade);
    }
    finish();
  }
  clusters.sort((a, b) => a.netAfterRecordedCosts - b.netAfterRecordedCosts);
  return {
    artifact: ARTIFACT,
    researchOnly: true,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    eligibleForPromotion: false,
    asOf: new Date(now).toISOString(),
    from: new Date(fromMs).toISOString(),
    tradeRowsWithHistoryBuffer: trades.length,
    invalidOrOpenRowsExcluded: ignoredInvalid,
    candidateClosedTrades: candidates.length,
    maxObservedGapMinutes: 30,
    allClosedByCurrency: group(candidates, () => 'ALL'),
    allClosedBySleeve: group(candidates, (x) => x.instrument + '/' + x.direction + '/' + x.route),
    mutuallyExclusiveEntryGapBins: Object.fromEntries(
      bins.map(([a, b]) => [
        a + '-' + b + 'm',
        group(
          reentries.filter(
            (x) => x.gapMinutes >= a && (b === 30 ? x.gapMinutes <= b : x.gapMinutes < b),
          ),
          () => 'ALL',
        ),
      ]),
    ),
    cumulativeReentryWindows: results,
    closedTradeRouteClustersWithin60Minutes: clusters.slice(0, 16),
    mixedEngineNegativeRouteClusters: clusters
      .filter((x) => x.engineCount > 1 && x.netAfterRecordedCosts < 0)
      .slice(0, 12),
    lossClusteringBeforeEntry: {
      priorFourSameRouteNegativeNet: group(
        annotated.filter((x) => x.last4SameRouteNet !== null && x.last4SameRouteNet < 0),
        (x) => x.instrument + '/' + x.direction + '/' + x.route,
      ),
      crossEngineFourCloseNetNegative: group(
        annotated.filter(
          (x) =>
            x.last4SameRouteNet !== null && x.last4SameRouteNet < 0 && x.last4SameRouteEngines > 1,
        ),
        (x) => x.instrument + '/' + x.direction + '/' + x.route,
      ),
    },
    warnings: [
      'Observational closed-trade cohorts only. Their sum is NOT causal profit achievable by skipping quick re-entries.',
      'Re-entries are based on most recent PRE-ENTRY close in the same broker account, instrument and side, across BOTH M1 and Plan-B engines.',
      'Complete cost data required for net metrics; incomplete records are excluded from money sums and counted separately.',
      'Comparisons across currencies are never summed. PnL is currency-denominated, not R-normalized, because initial monetary risk cannot be reliably obtained from trading.trades.',
      'Win rate and short-horizon samples do not validate a policy.',
      'No cooldown, broker execution change or risk-gate promotion is authorized by this report.',
    ],
  };
}
async function runAudit({ client, userId, connectionId, since, maxTrades = MAX_TRADES }) {
  if (!UUID.test(userId ?? '') || !UUID.test(connectionId ?? '')) throw Error('INVALID_DEMO_SCOPE');
  if (!Number.isInteger(maxTrades) || maxTrades < 1 || maxTrades > MAX_TRADES)
    throw Error('INVALID_ROW_LIMIT');
  const from = new Date(since);
  if (!Number.isFinite(from.getTime())) throw Error('INVALID_WINDOW');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const scope = (await client.query(SCOPE_SQL, [connectionId, userId])).rows[0];
    if (!scope) throw Error('OWNER_CTRADER_DEMO_NOT_FOUND');
    const snapshotAt = new Date(scope.snapshotAt);
    if (
      !Number.isFinite(snapshotAt.getTime()) ||
      from > snapshotAt ||
      snapshotAt - from > 14 * 864e5
    )
      throw Error('INVALID_WINDOW');
    const rows = (
      await client.query(TRADES_SQL, [
        userId,
        connectionId,
        from.toISOString(),
        snapshotAt.toISOString(),
        maxTrades + 1,
      ])
    ).rows;
    if (rows.length > maxTrades) throw Error('TRUNCATED_TRADE_HISTORY');
    const result = analyzeReentries(rows, from, snapshotAt);
    await client.query('COMMIT');
    return result;
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
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'irexpro_dev',
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-cross-engine-reentry-readonly',
  });
  try {
    await client.connect();
    const report = await runAudit({
      client,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
      since:
        process.env.REENTRY_CHURN_AUDIT_SINCE || new Date(Date.now() - 7 * 864e5).toISOString(),
    });
    console.log('CROSS_ENGINE_REENTRY_AUDIT ' + JSON.stringify(report));
  } finally {
    await client.end();
  }
}
module.exports = {
  ARTIFACT,
  HORIZONS_MINUTES,
  SCOPE_SQL,
  TRADES_SQL,
  normalizeTrade,
  summary,
  analyzeReentries,
  runAudit,
};
if (require.main === module)
  main().catch(() => {
    console.error('CROSS_ENGINE_REENTRY_AUDIT_FAILED read-only research unable to complete');
    process.exitCode = 1;
  });
