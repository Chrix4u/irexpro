'use strict';

// Read-only, user/broker-scoped, manually invoked replay of SAVED causal
// decisions. Not a six-pair broker/backtest simulator. No trading imports.
const { resolve } = require('node:path');
const { writeFileSync, mkdirSync } = require('node:fs');

const ARTIFACT = 'wednesday-six-pair-versus-focused3-observation-v1';
const SIX = Object.freeze(['AUDUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY']);
const FOCUSED = new Set(['AUDUSD', 'EURUSD', 'GBPUSD']);
const PAIR_VETO = 'M1_DEMO_INSTRUMENT_RESEARCH_ONLY';
const FALLBACK_VETO = 'M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DECISIONS = 1000;
const MIN_FEE_SAMPLES = 3;
const EPISODE_COOLDOWN_MS = 30 * 60000;
const START = '2026-11-05T14:00:00.000Z';
const PRIVATE_REPORT =
  '/home/lightworld/webapps/irexpro-research/wednesday-policy-shadow/latest-report.json';

const SCOPE_SQL = [
  'SELECT current_timestamp AS "snapshotAt" FROM broker.broker_connections',
  "WHERE id=$1 AND user_id=$2 AND broker_id='ctrader'",
  "AND account_type='DEMO' AND deleted_at IS NULL",
].join(' ');

const DECISIONS_SQL = [
  'WITH scoped AS (',
  ' SELECT d.id,d.user_id,d.broker_connection_id,d.instrument,d.direction,d.bar_time,d.evaluated_at,d.created_at,',
  ' d.execution_authority,d.route,d.blockers,d.candidate,d.governance,',
  ' row_number() over (PARTITION BY d.broker_connection_id,d.instrument,d.direction,d.bar_time',
  ' ORDER BY d.created_at,d.id) AS same_bar_rank',
  ' FROM trading.m1_tactical_decisions d',
  ' WHERE d.user_id=$1 AND d.broker_connection_id=$2',
  ' AND d.evaluated_at >= $3::timestamptz AND d.evaluated_at <= $4::timestamptz',
  " AND d.direction IN ('BUY','SELL')",
  " AND d.instrument IN ('AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY')",
  " AND ((d.governance #>> '{multimodelAuthority,authorityPath}')='PRIMARY_PLAN_B'",
  " OR ((d.blockers ? 'M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION')",
  ' AND jsonb_array_length(d.blockers) <= 2))',
  '), unique_bars AS (SELECT * FROM scoped WHERE same_bar_rank=1)',
  'SELECT d.instrument,d.direction,d.bar_time AS "barTime",d.evaluated_at AS "evaluatedAt",',
  ' d.created_at AS "createdAt",d.execution_authority AS "executionAuthority",',
  ' d.route AS "m1Route",d.blockers AS "blockers",',
  ' d.governance #>> \'{multimodelAuthority,authorityPath}\' AS "primaryPath",',
  ' d.governance #>> \'{demoPrimaryOnlyProbation,chosenAuthorityPath}\' AS "chosenPath",',
  ' d.governance #>> \'{multimodelEnsemble,strategyRoute}\' AS "planBRoute",',
  ' (d.candidate->>\'stopLoss\')::numeric AS "stopLoss",',
  ' (d.candidate->>\'takeProfit\')::numeric AS "takeProfit",',
  ' e.bid_close AS "entryBid",e.ask_close AS "entryAsk",e.last_quote_sample_at AS "entryAt",',
  ' f.bid_close AS "futureBid",f.ask_close AS "futureAsk",f.last_quote_sample_at AS "futureAt",',
  ' p.bars AS "pathBars",p.first_bar AS "firstPathBar",p.last_bar AS "lastPathBar",',
  ' p.first_possible_stop AS "firstPossibleStop",p.first_possible_target AS "firstPossibleTarget",',
  ' p.first_quote_stop AS "firstQuoteStop",p.first_quote_target AS "firstQuoteTarget"',
  'FROM unique_bars d',
  'LEFT JOIN LATERAL (',
  ' SELECT q.bid_close,q.ask_close,q.last_quote_sample_at,q.bucket_time',
  ' FROM market_data.provider_quote_candles q',
  " WHERE q.connection_id=d.broker_connection_id AND q.instrument=d.instrument AND q.timeframe='M1'",
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
  " WHERE q.connection_id=d.broker_connection_id AND q.instrument=d.instrument AND q.timeframe='M1'",
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
  // Stored M1 OHLC does not retain full bid/ask intraminute extrema.
  // Pad the price low/high by at least the recorded spread. This may
  // overcount possible stops, but must never label an uncertain hold safe.
  "   (d.direction='BUY' AND q.low - greatest(coalesce(q.spread_close,0),q.ask_close-q.bid_close) <= (d.candidate->>'stopLoss')::numeric) OR",
  "   (d.direction='SELL' AND q.high + greatest(coalesce(q.spread_close,0),q.ask_close-q.bid_close) >= (d.candidate->>'stopLoss')::numeric)) AS first_possible_stop,",
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
  " WHERE q.connection_id=d.broker_connection_id AND q.instrument=d.instrument AND q.timeframe='M1'",
  " AND q.source='ctrader-broker-native' AND q.positive_quote_sample_count>0",
  ' AND q.bid_close>0 AND q.ask_close>=q.bid_close',
  ' AND e.bucket_time IS NOT NULL AND f.bucket_time IS NOT NULL',
  ' AND q.bucket_time>e.bucket_time AND q.bucket_time<=f.bucket_time',
  " AND q.last_quote_sample_at>=q.bucket_time AND q.last_quote_sample_at<q.bucket_time+interval '1 minute'",
  ' AND q.last_quote_sample_at<=f.last_quote_sample_at',
  ') p ON TRUE',
  'ORDER BY d.created_at ASC,d.instrument,d.direction,d.bar_time',
  'LIMIT $5::int',
].join('\n');

const FEES_SQL = [
  'SELECT t.instrument,t.closed_at AS "closedAt",t.fill_price AS "fillPrice",',
  't.exit_price AS "exitPrice",t.stop_loss AS "stopLoss",',
  't.realised_pnl AS "gross",t.commission,t.swap,t.lot_size AS "lotSize"',
  'FROM trading.trades t',
  "WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.status='CLOSED'",
  "AND t.account_currency='EUR' AND t.closed_at>=$3::timestamptz",
  'AND t.closed_at<=$4::timestamptz',
  "AND t.instrument IN ('AUDUSD','EURUSD','GBPUSD','USDCAD','USDCHF','USDJPY')",
  'ORDER BY t.closed_at ASC',
  'LIMIT 3001',
].join('\n');

const ACTUAL_SQL = [
  "SELECT to_char(t.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS \"utcDate\",",
  't.instrument,t.status,ti.strategy_code AS "engine",',
  'ti.metadata->>\'multimodel_execution_authority_path\' AS "authorityPath",',
  't.realised_pnl AS "gross",t.commission,t.swap',
  'FROM trading.trades t JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id',
  "WHERE t.user_id=$1 AND t.broker_connection_id=$2 AND t.status='CLOSED'",
  "AND t.account_currency='EUR' AND t.closed_at >= '2026-11-04T00:00:00Z'",
  'AND t.closed_at <= $3::timestamptz',
  'ORDER BY t.closed_at',
  'LIMIT 2001',
].join('\n');

function number(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function time(x) {
  if (!x) return null;
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? t : null;
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function money(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
function feeRiskSample(t) {
  const gross = number(t.gross),
    fee = number(t.commission),
    fill = number(t.fillPrice),
    exit = number(t.exitPrice),
    stop = number(t.stopLoss),
    lot = number(t.lotSize);
  if (
    [gross, fee, fill, exit, stop, lot].some((x) => x === null) ||
    Math.abs(gross) < 0.5 ||
    fee >= 0 ||
    fill <= 0 ||
    exit <= 0 ||
    stop <= 0 ||
    lot <= 0
  )
    return null;
  const priceMovement = Math.abs(exit - fill),
    stopDistance = Math.abs(stop - fill);
  if (priceMovement < 1e-6 || stopDistance < 1e-6) return null;
  // Cost in fractions of the original trade's money-at-risk,
  // recovered from realised broker gross P&L and actual fill-price geometry.
  const commissionR = (Math.abs(fee) / Math.abs(gross)) * (priceMovement / stopDistance);
  return Number.isFinite(commissionR) && commissionR >= 0 && commissionR <= 2
    ? { instrument: t.instrument, closedAt: time(t.closedAt), commissionR }
    : null;
}
function classify(d) {
  const b = Array.isArray(d.blockers) ? d.blockers : [];
  const instrument = String(d.instrument || '');
  if (!SIX.includes(instrument) || !['BUY', 'SELL'].includes(d.direction)) return 'INVALID';
  const primary = d.primaryPath === 'PRIMARY_PLAN_B';
  const alternative =
    d.chosenPath &&
    d.chosenPath !== 'PRIMARY_PLAN_B' &&
    d.chosenPath !== 'BLOCKED' &&
    d.chosenPath !== 'UNKNOWN';
  if (b.length === 0 && FOCUSED.has(instrument) && primary) return 'CURRENT_PRIMARY_ELIGIBLE';
  if (b.length === 1 && b[0] === PAIR_VETO && primary && !FOCUSED.has(instrument))
    return 'SIX_PAIR_PRIMARY_RESTORATION_ONLY';
  if (b.length === 1 && b[0] === FALLBACK_VETO && alternative && FOCUSED.has(instrument))
    return 'WEDNESDAY_FALLBACK_RESTORATION_ONLY';
  if (
    b.length === 2 &&
    b.includes(PAIR_VETO) &&
    b.includes(FALLBACK_VETO) &&
    alternative &&
    !FOCUSED.has(instrument)
  )
    return 'BOTH_RESTRICTIONS_REQUIRED';
  return 'OTHER_BLOCKERS_REMAIN';
}
function pathState(d) {
  const entryAt = time(d.entryAt),
    futureAt = time(d.futureAt),
    createdAt = time(d.createdAt);
  const stop = number(d.stopLoss),
    target = number(d.takeProfit),
    buy = d.direction === 'BUY';
  const entry = number(buy ? d.entryAsk : d.entryBid),
    future = number(buy ? d.futureBid : d.futureAsk);
  const otherEntry = number(buy ? d.entryBid : d.entryAsk);
  const otherFuture = number(buy ? d.futureAsk : d.futureBid);
  if (
    entryAt === null ||
    futureAt === null ||
    createdAt === null ||
    entry === null ||
    future === null ||
    otherEntry === null ||
    otherFuture === null ||
    stop === null ||
    target === null ||
    entry <= 0 ||
    future <= 0 ||
    otherEntry <= 0 ||
    otherFuture <= 0 ||
    entryAt < createdAt ||
    entryAt - createdAt > 150000 ||
    futureAt - entryAt < 900000 ||
    futureAt - entryAt > 1080000 ||
    (buy
      ? !(stop < entry && entry < target && otherEntry <= entry)
      : !(target < entry && entry < stop && otherEntry >= entry)) ||
    (buy ? future > otherFuture : future < otherFuture)
  )
    return {
      state: 'UNOBSERVABLE',
      grossR: null,
      reason: 'MISSING_OR_INVALID_CAUSAL_BROKER_QUOTES',
    };
  const n = Number(d.pathBars);
  const start = time(d.firstPathBar),
    end = time(d.lastPathBar);
  const expectedBars =
    start === null || end === null ? null : Math.round((end - start) / 60000) + 1;
  const expectedStart = Math.floor(entryAt / 60000) * 60000 + 60000;
  const expectedEnd = Math.floor(futureAt / 60000) * 60000;
  if (
    !Number.isInteger(n) ||
    n < 14 ||
    expectedBars !== n ||
    start !== expectedStart ||
    end !== expectedEnd ||
    end > futureAt
  )
    return { state: 'UNOBSERVABLE', grossR: null, reason: 'INCOMPLETE_CONSECUTIVE_M1_PATH' };
  const firstStop = time(d.firstPossibleStop),
    firstTarget = time(d.firstPossibleTarget);
  const firstStopQuote = time(d.firstQuoteStop),
    firstTargetQuote = time(d.firstQuoteTarget);
  let state = 'NO_BARRIER_TOUCH';
  if (firstStop !== null && (firstTarget === null || firstStop <= firstTarget)) {
    state =
      firstTarget !== null && firstTarget === firstStop
        ? 'SAME_MINUTE_BARRIER_AMBIGUITY'
        : 'POSSIBLE_STOP_BEFORE_TARGET';
  } else if (firstTarget !== null) state = 'POSSIBLE_TARGET_BEFORE_STOP';
  // A quote-close beyond the TP requires no earlier possible midpoint stop.
  const quoteTargetFirst =
    firstTargetQuote !== null && (firstStop === null || firstTargetQuote < firstStop);
  const grossR = (buy ? future - entry : entry - future) / Math.abs(stop - entry);
  return {
    state,
    grossR,
    quoteTargetFirst,
    stopPossible: firstStop !== null,
    targetPossible: firstTarget !== null,
    firstQuoteStop: firstStopQuote !== null,
    firstQuoteTarget: firstTargetQuote !== null,
    reason: null,
  };
}
function assess(d, fees) {
  const cohort = classify(d),
    observation = pathState(d);
  const asOf = time(d.createdAt);
  const feeHistory = fees
    .filter(
      (x) =>
        x.instrument === d.instrument && x.closedAt !== null && asOf !== null && x.closedAt < asOf,
    )
    .map((x) => x.commissionR);
  const feeR = feeHistory.length >= MIN_FEE_SAMPLES ? median(feeHistory) : null;
  // Only a scenario without a possible SL or TP before the 15m reference
  // is a meaningful "still open at 15m" comparison.
  const unchangedOpen = observation.state === 'NO_BARRIER_TOUCH';
  const netR = unchangedOpen && feeR !== null ? observation.grossR - feeR : null;
  return {
    cohort,
    instrument: d.instrument,
    direction: d.direction,
    day: new Date(d.createdAt).toISOString().slice(0, 10),
    at: asOf,
    authority: d.executionAuthority,
    observed: observation,
    commissionCalibrationSamples: feeHistory.length,
    estimatedCommissionR: feeR,
    holdTo15mNetProxyR: netR,
  };
}
function aggregate(items) {
  const result = {
    decisions: items.length,
    observed: 0,
    notObserved: 0,
    possibleStop: 0,
    possibleTarget: 0,
    quoteTargetFirst: 0,
    unchanged15m: 0,
    netCalibrated: 0,
    winsAfterEstimatedCommission: 0,
    netProxyRSum: 0,
    meanEstimatedNetR: null,
    positiveFraction: null,
  };
  let wins = 0;
  for (const x of items) {
    if (x.observed.state === 'UNOBSERVABLE') {
      result.notObserved++;
      continue;
    }
    result.observed++;
    if (x.observed.stopPossible) result.possibleStop++;
    if (x.observed.targetPossible) result.possibleTarget++;
    if (x.observed.quoteTargetFirst) result.quoteTargetFirst++;
    if (x.observed.state === 'NO_BARRIER_TOUCH') result.unchanged15m++;
    if (x.holdTo15mNetProxyR !== null) {
      result.netCalibrated++;
      result.netProxyRSum += x.holdTo15mNetProxyR;
      if (x.holdTo15mNetProxyR > 0) wins++;
    }
  }
  result.winsAfterEstimatedCommission = wins;
  result.netProxyRSum = money(result.netProxyRSum);
  result.meanEstimatedNetR = result.netCalibrated
    ? Number((result.netProxyRSum / result.netCalibrated).toFixed(4))
    : null;
  result.positiveFraction = result.netCalibrated
    ? Number((wins / result.netCalibrated).toFixed(4))
    : null;
  return result;
}
function analyze(decisions, feeRows, actualRows, since, snapshotAt) {
  const samples = feeRows.map(feeRiskSample).filter(Boolean);
  const ranked = decisions
    .filter((x) => time(x.createdAt) !== null)
    .sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const all = ranked.map((d) => assess(d, samples));
  const lastSeen = new Map();
  const spaced = [];
  for (const x of all) {
    const previous = lastSeen.get(x.instrument);
    if (previous !== undefined && x.at - previous < EPISODE_COOLDOWN_MS) continue;
    lastSeen.set(x.instrument, x.at);
    spaced.push(x);
  }
  function byGroup(rows, getKey) {
    const groups = {};
    for (const x of rows) {
      const k = getKey(x);
      (groups[k] ??= []).push(x);
    }
    return Object.fromEntries(
      Object.entries(groups)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, list]) => [key, aggregate(list)]),
    );
  }
  const actual = {};
  for (const t of actualRows) {
    const gross = number(t.gross),
      fee = number(t.commission),
      swap = number(t.swap);
    if (gross === null || fee === null || swap === null) continue;
    const day = t.utcDate || 'UNKNOWN';
    const key = day + '/' + t.instrument + '/' + (t.authorityPath || 'UNKNOWN');
    const a = actual[key] ?? (actual[key] = { trades: 0, netEUR: 0, wins: 0 });
    const net = gross + fee + swap;
    a.trades++;
    a.netEUR += net;
    if (net > 0) a.wins++;
  }
  Object.values(actual).forEach((x) => {
    x.netEUR = money(x.netEUR);
  });
  return {
    artifact: ARTIFACT,
    snapshotAt: new Date(snapshotAt).toISOString(),
    since: new Date(since).toISOString(),
    authority: 'NONE',
    modelFitted: false,
    executionAllowed: false,
    strategyPolicies: {
      wednesdayReference: 'SIX_PAIRS_PLAN_B_PLUS_ELIGIBLE_M1_FALLBACK',
      sixPairPrimaryOnly: 'ALL_SIX_PRIMARY_PLAN_B_BUT_FALLBACKS_IN_PROBATION',
      current: 'AUDUSD_EURUSD_GBPUSD_PRIMARY_PLAN_B_ONLY',
    },
    provenance: {
      source: 'ctrader-broker-native-quoted-M1',
      stopTouchConservatism:
        'quote-side BID/ASK closes plus M1 low/high spread-padded possible touches; intraminute bid/ask extrema unavailable',
      entry: 'first verified broker M1 quote sample after persisted decision (up to 150 sec)',
      future: 'first verified M1 quote at +15 to +18 min from entry reference',
      independentEpisodes:
        '30-minute gap per instrument across directions and routes, earliest signal wins',
      fees: 'historical same-instrument closed DEMO EUR broker commission, risk-R median, strictly before decision; minimum 3 records',
    },
    rawCohortCounts: byGroup(all, (x) => x.cohort),
    spacedCohorts: byGroup(spaced, (x) => x.cohort),
    spacedByPairAndCohort: byGroup(spaced, (x) => x.cohort + '/' + x.instrument),
    spacedByDayAndCohort: byGroup(spaced, (x) => x.day + '/' + x.cohort),
    feeCalibrationByPair: Object.fromEntries(
      SIX.map((pair) => [pair, { samples: samples.filter((x) => x.instrument === pair).length }]),
    ),
    actualClosedTradeNetEUR: actual,
    warnings: [
      'This is NOT a re-execution of old model versions under new data; it uses saved decision-time model approvals from their actual policy date.',
      'One non-executed signal is not one brokerage fill or independent trade. Commission-R values are historical estimates, never a promised execution cost.',
      '15-minute mark-to-market R is reported only if the contiguous broker-native path shows no possible TP or spread-padded SL touch; quote-side intraminute bid/ask extrema are unavailable and any uncertain touch is censored, not an order.',
      'Neither policy reconstructs actual broker fills, position overlap, loss brakes, available equity, lot constraints, spread at submit or portfolio drawdown.',
      'Price scenarios from the same day are not independent out-of-sample validation; dates and pair clusters have correlated exposure.',
      'Do not promote any strategy or restore DEMO/LIVE instrument authority from this report.',
    ],
  };
}
async function runAudit({ client, userId, connectionId, since = START }) {
  if (!UUID.test(userId || '') || !UUID.test(connectionId || ''))
    throw Error('INVALID_USER_BROKER_SCOPE');
  if (!Number.isFinite(time(since))) throw Error('INVALID_START_DATE');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '35s'");
    const scope = (await client.query(SCOPE_SQL, [connectionId, userId])).rows[0];
    if (!scope) throw Error('OWNER_CTRADER_DEMO_NOT_FOUND');
    const snapshotAt = new Date(scope.snapshotAt);
    if (snapshotAt.getTime() <= time(since) || snapshotAt.getTime() - time(since) > 14 * 86400000)
      throw Error('INVALID_AUDIT_WINDOW');
    const end = new Date(snapshotAt.getTime() - 20 * 60000).toISOString();
    const results = await client.query(DECISIONS_SQL, [
      userId,
      connectionId,
      since,
      end,
      MAX_DECISIONS + 1,
    ]);
    if (results.rows.length > MAX_DECISIONS) throw Error('DECISIONS_TRUNCATED');
    const feeResults = await client.query(FEES_SQL, [
      userId,
      connectionId,
      new Date(time(since) - 30 * 86400000).toISOString(),
      snapshotAt.toISOString(),
    ]);
    if (feeResults.rows.length > 3000) throw Error('FEE_HISTORY_TRUNCATED');
    const actualResults = await client.query(ACTUAL_SQL, [
      userId,
      connectionId,
      snapshotAt.toISOString(),
    ]);
    if (actualResults.rows.length > 2000) throw Error('TRADE_HISTORY_TRUNCATED');
    const report = analyze(results.rows, feeResults.rows, actualResults.rows, since, snapshotAt);
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
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'irexpro_dev',
    user: process.env.DB_USER || 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: getDatabaseSslOptions(process.env.DB_SSL === 'true'),
    connectionTimeoutMillis: 10000,
    application_name: 'irexpro-wednesday-policy-shadow-readonly',
  });
  try {
    await client.connect();
    const report = await runAudit({
      client,
      userId: process.env.VPS_FOREX_SCANNER_USER_ID,
      connectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
      since: process.env.WEDNESDAY_POLICY_SHADOW_SINCE || START,
    });
    mkdirSync(resolve(PRIVATE_REPORT, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(PRIVATE_REPORT, JSON.stringify(report, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    console.log(
      'WEDNESDAY_POLICY_SHADOW ' +
        JSON.stringify({
          artifact: report.artifact,
          snapshotAt: report.snapshotAt,
          spacedCohorts: report.spacedCohorts,
          spacedByPairAndCohort: report.spacedByPairAndCohort,
          feeCalibrationByPair: report.feeCalibrationByPair,
          authority: report.authority,
          executionAllowed: report.executionAllowed,
        }),
    );
  } finally {
    await client.end();
  }
}
module.exports = {
  ARTIFACT,
  PAIR_VETO,
  FALLBACK_VETO,
  START,
  SCOPE_SQL,
  DECISIONS_SQL,
  FEES_SQL,
  ACTUAL_SQL,
  number,
  time,
  median,
  feeRiskSample,
  classify,
  pathState,
  assess,
  aggregate,
  analyze,
  runAudit,
};
if (require.main === module)
  main().catch((error) => {
    console.error(
      'WEDNESDAY_POLICY_SHADOW_FAILED ' + String(error?.message || 'unknown').slice(0, 140),
    );
    process.exitCode = 1;
  });
