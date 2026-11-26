'use strict';
// Read-only statement-evidence matcher. Independently verifies that every
// stranded internal close order (RECONCILIATION_PENDING MARKET, no provider
// order id, zero fill, linked CLOSED trade, opposite direction) and every
// closed DEMO trade in a window matches the owner-exported broker statement
// on instrument, direction, date, entry price, exit price and lot size — the
// exact economic dimensions the historical analysis claimed. Never writes,
// never infers a broker outcome, never fabricates an identifier.

const fs = require('node:fs');
const path = require('node:path');

// ─── exact decimal comparison (BigInt, no floats) ────────────────────────────
const { decimalToScaled, compareDecimal, normalizeDecimals, parseFingerprints, parseStatementInput, economicKey } = require('../../../packages/types/src/statement-consistency.cjs');

// ─── matching core (pure; unit-testable) ──────────────────────────────────────
/**
 * Side A — stranded close orders ↔ statement deals.
 * A DB stranded row matches when: trade instrument == symbol, trade direction
 * == statement opening direction, order direction == statement closing
 * direction, fill_price == entry, exit_price == closing price, lot_size ==
 * lots, and the trade closed on the same UTC calendar day. Exact decimals.
 */
function closedUtcDay(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function sameEconomics(db, statement, direction) {
  const day = closedUtcDay(db.closed_at);
  return day !== null && statement.day === day &&
    statement.symbol === db.instrument && statement.openingDirection === direction &&
    compareDecimal(db.fill_price, statement.entry) === 0 &&
    compareDecimal(db.exit_price, statement.exit) === 0 &&
    compareDecimal(db.lot_size, statement.lots) === 0;
}

// Only mutually unique economic candidates are counted. No arbitrary first
// match, greedy assignment, timestamp guessing or reuse across distinct rows.
function reciprocalCandidates(dbRows, statementRows, predicate) {
  const edges = dbRows.map((db) => statementRows.map((s, i) => predicate(db, s) ? i : -1).filter((i) => i >= 0));
  const counts = statementRows.map(() => 0);
  for (const candidates of edges) for (const i of candidates) counts[i] += 1;
  return { edges, counts };
}

function matchStranded(strandedDb, statementRows) {
  const { edges, counts } = reciprocalCandidates(strandedDb, statementRows, (db, s) =>
    sameEconomics(db, s, String(db.trade_direction || '').toUpperCase()) &&
    s.closingDirection === String(db.order_direction || '').toUpperCase());
  const matched = [], unmatched = [], ambiguous = [];
  strandedDb.forEach((db, i) => {
    const candidates = edges[i];
    if (candidates.length === 1 && counts[candidates[0]] === 1) {
      matched.push({ db, statement: statementRows[candidates[0]] });
    } else if (candidates.length) {
      ambiguous.push({ db, candidates: candidates.map((j) => statementRows[j]) });
    } else unmatched.push({ db });
  });
  return { matched, unmatched, ambiguous };
}

/** Closed trades ↔ statement deals, without counting ambiguous pairs as matches. */
function matchClosedTrades(closedDb, statementRows) {
  const { edges, counts } = reciprocalCandidates(closedDb, statementRows, (db, s) =>
    sameEconomics(db, s, String(db.direction || '').toUpperCase()));
  const matched = [], unmatchedTrades = [], ambiguousTrades = [];
  const used = new Set();
  closedDb.forEach((trade, i) => {
    const candidates = edges[i];
    if (candidates.length === 1 && counts[candidates[0]] === 1) {
      const j = candidates[0];
      used.add(j);
      matched.push({ trade, statement: statementRows[j] });
    } else if (candidates.length) ambiguousTrades.push(trade);
    else unmatchedTrades.push(trade);
  });
  const unmatchedStatement = statementRows.filter((_, i) => counts[i] === 0);
  const ambiguousStatement = statementRows.filter((_, i) => counts[i] > 0 && !used.has(i));
  return { matched, unmatchedStatement, unmatchedTrades, ambiguousTrades, ambiguousStatement };
}

/**
 * Diagnostic only: describe exactly one differing or unprovable economic
 * dimension. Only unmatched rows are considered; never settle a trade from
 * these observations. No identifiers or prices are returned by this summary.
 */
function singleFieldDifference(trade, statement) {
  const direction = String(trade.direction || '').toUpperCase();
  const compareText = (actual, expected, valid) =>
    valid(actual) && valid(expected) ? (actual === expected ? 0 : 1) : null;
  const day = closedUtcDay(trade.closed_at);
  const fields = [
    ['INSTRUMENT', compareText(trade.instrument, statement.symbol, (v) => typeof v === 'string' && v.length > 0)],
    ['DIRECTION', compareText(direction, statement.openingDirection, (v) => ['BUY', 'SELL'].includes(v))],
    ['UTC_DAY', compareText(day, statement.day, (v) => typeof v === 'string' && v.length === 10)],
    ['ENTRY_PRICE', compareDecimal(trade.fill_price, statement.entry)],
    ['EXIT_PRICE', compareDecimal(trade.exit_price, statement.exit)],
    ['LOT_SIZE', compareDecimal(trade.lot_size, statement.lots)],
  ];
  const differences = fields.filter(([, comparison]) => comparison !== 0);
  if (differences.length !== 1) return null;
  const [field, comparison] = differences[0];
  return (comparison === null ? 'MISSING_OR_INVALID_' : 'DIFFERENT_') + field;
}

function summarizeUnmatchedEconomics(closedMatch) {
  const trades = closedMatch.unmatchedTrades;
  const statements = closedMatch.unmatchedStatement;
  const { edges, counts } = reciprocalCandidates(trades, statements,
    (trade, statement) => singleFieldDifference(trade, statement) !== null);
  const candidates = statements.map(() => []);
  edges.forEach((indices, tradeIndex) => {
    indices.forEach((statementIndex) => candidates[statementIndex].push(tradeIndex));
  });
  const reasonCounts = {};
  const add = (reason) => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; };
  candidates.forEach((tradeIndices, statementIndex) => {
    if (counts[statementIndex] === 0) {
      add('NO_SINGLE_FIELD_CANDIDATE');
    } else if (tradeIndices.length !== 1 || edges[tradeIndices[0]].length !== 1) {
      add('AMBIGUOUS_SINGLE_FIELD_CANDIDATES');
    } else {
      add(singleFieldDifference(trades[tradeIndices[0]], statements[statementIndex]));
    }
  });
  return {
    diagnosticOnly: true,
    statementDealsExamined: statements.length,
    unmatchedTradesExamined: trades.length,
    reasonCounts,
  };
}

/** Compare P&L only for reciprocal matches with all valid economic fields. */
function checkPnlComposition(closedDb, statementRows) {
  const mismatches = [], missingEconomics = [];
  const { matched } = matchClosedTrades(closedDb, statementRows);
  let checked = 0;
  for (const { trade: t, statement: s } of matched) {
    const amounts = [t.realised_pnl, t.commission, t.swap, s.net].map(normalizeDecimals);
    if (amounts.some((v) => v === null)) {
      missingEconomics.push({ trade_id: t.id, missingFields: ['realised_pnl', 'commission', 'swap', 'statement_net'].filter((_, i) => amounts[i] === null) });
      continue;
    }
    const scale = Math.max(...amounts.map((v) => (v.split('.')[1] || '').length));
    const [realised, commission, swap, net] = amounts.map((v) => decimalToScaled(v, scale));
    checked += 1;
    if (realised + commission + swap !== net) {
      mismatches.push({ trade_id: t.id, composed: String(t.realised_pnl) + ' + ' + String(t.commission) + ' + ' + String(t.swap), statement_net: s.net });
    }
  }
  return { mismatches, missingEconomics, checked };
}

function summarize(input) {
  const { strandedMatch, closedMatch, pnl, statementRows, dbClosedCount } = input;
  return {
    artifact: 'closed-demo-statement-match-v2',
    readOnly: true,
    statement: {
      deals: statementRows.length,
      distinctEconomicKeys: new Set(statementRows.map(economicKey)).size,
    },
    strandedCloseOrders: {
      total: strandedMatch.matched.length + strandedMatch.unmatched.length + strandedMatch.ambiguous.length,
      matched: strandedMatch.matched.length,
      unmatched: strandedMatch.unmatched.length,
      ambiguous: strandedMatch.ambiguous.length,
    },
    closedTrades: {
      dbCount: dbClosedCount,
      matchedToStatement: closedMatch.matched.length,
      unmatchedStatementDeals: closedMatch.unmatchedStatement.length,
      unmatchedDbTrades: closedMatch.unmatchedTrades.length,
      ambiguousDbTrades: closedMatch.ambiguousTrades.length,
      ambiguousStatementDeals: closedMatch.ambiguousStatement.length,
    },
    unmatchedEconomicDiagnostics: summarizeUnmatchedEconomics(closedMatch),
    pnlComposition: {
      checked: pnl.checked,
      mismatches: pnl.mismatches.length,
      missingEconomics: pnl.missingEconomics.length,
    },
    status:
      strandedMatch.unmatched.length === 0 &&
      strandedMatch.ambiguous.length === 0 &&
      closedMatch.unmatchedStatement.length === 0 &&
      closedMatch.unmatchedTrades.length === 0 &&
      closedMatch.ambiguousTrades.length === 0 &&
      closedMatch.ambiguousStatement.length === 0 &&
      pnl.missingEconomics.length === 0 &&
      pnl.checked === dbClosedCount &&
      pnl.mismatches.length === 0
        ? 'FULLY_MATCHED'
        : 'DISCREPANCY_REQUIRES_REVIEW',
  };
}

// ─── database access (read-only) ─────────────────────────────────────────────
// Date-only flags describe UTC calendar days, not the database session timezone.
function utcDayBoundary(value) {
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('INVALID_UTC_DAY');
  const iso = `${value}T00:00:00.000Z`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== iso) throw new Error('INVALID_UTC_DAY');
  return iso;
}

async function inspect(db, options) {
  const from = utcDayBoundary(options.from);
  const to = utcDayBoundary(options.to);
  if (from && to && from >= to) throw new Error('INVALID_UTC_WINDOW');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.connectionId || '')) {
    throw new Error('EXPLICIT_BROKER_CONNECTION_REQUIRED');
  }
  const params = [options.connectionId];
  const bind = (value) => `$${params.push(value)}`;
  // Both queries use the same account and UTC window. Economic fingerprints
  // alone cannot establish that two different accounts own the same deal.
  const filters = [
    'AND b.id = $1::uuid',
    options.broker ? `AND b.broker_id = ${bind(options.broker)}` : '',
    from ? `AND t.closed_at >= ${bind(from)}::timestamptz` : '',
    to ? `AND t.closed_at < ${bind(to)}::timestamptz` : '',
  ].join(' ');
  await db.query('BEGIN READ ONLY');
  try {
    const stranded = (
      await db.query(
        `SELECT o.id AS order_id, o.status AS order_status, o.order_kind,
                o.direction AS order_direction, o.provider_order_id, o.filled_quantity, o.requested_quantity,
                t.id AS trade_id, t.instrument, t.direction AS trade_direction, t.lot_size,
                t.fill_price, t.exit_price, t.realised_pnl, t.closed_at
         FROM trading.orders o
         JOIN trading.trades t ON t.id = o.trade_id AND t.user_id = o.user_id
              AND t.broker_connection_id = o.broker_connection_id
         JOIN broker.broker_connections b ON b.id = o.broker_connection_id AND b.user_id = o.user_id
         WHERE o.status = 'RECONCILIATION_PENDING' AND o.order_kind = 'MARKET'
           AND o.provider_order_id IS NULL AND o.filled_quantity = 0
           AND t.status = 'CLOSED' AND o.direction <> t.direction
           AND UPPER(b.account_type) = 'DEMO' ${filters}
         ORDER BY t.closed_at ASC`,
        params,
      )
    ).rows;

    const closed = (
      await db.query(
        `SELECT t.id, t.instrument, t.direction, t.lot_size, t.fill_price, t.exit_price,
                t.realised_pnl, t.commission, t.swap, t.closed_at
         FROM trading.trades t
         JOIN broker.broker_connections b ON b.id = t.broker_connection_id AND b.user_id = t.user_id
         WHERE t.status = 'CLOSED' AND UPPER(b.account_type) = 'DEMO'
           ${filters}
         ORDER BY t.closed_at ASC`,
        params,
      )
    ).rows;

    const statementRows = parseStatementInput(fs.readFileSync(options.fingerprints, 'utf-8'));
    const strandedMatch = matchStranded(stranded, statementRows);
    const closedMatch = matchClosedTrades(closed, statementRows);
    const pnl = checkPnlComposition(closed, statementRows);
    return {
      report: summarize({
        strandedMatch,
        closedMatch,
        pnl,
        statementRows,
        dbClosedCount: closed.length,
      }),
      detail: {
        strandedUnmatched: strandedMatch.unmatched.map((u) => u.db),
        strandedAmbiguous: strandedMatch.ambiguous.map((a) => ({
          ...a.db,
          candidateCount: a.candidates.length,
        })),
        unmatchedStatementDeals: closedMatch.unmatchedStatement.map((s) => s.raw),
        unmatchedDbTrades: closedMatch.unmatchedTrades,
        ambiguousDbTrades: closedMatch.ambiguousTrades,
        ambiguousStatementDeals: closedMatch.ambiguousStatement.map((s) => s.raw),
        pnlMismatches: pnl.mismatches,
        missingPnlEconomics: pnl.missingEconomics,
      },
    };
  } finally {
    await db.query('ROLLBACK');
  }
}

// ─── self-test (no database) ─────────────────────────────────────────────────
function selfTest() {
  const csv = [
    'seq,symbol,opening_direction,closing_order_direction,closing_time_utc,entry_price,closing_price,closing_quantity_lots,net_usd,running_balance_usd',
    '1,EURUSD,Buy,Sell,2026-11-10T00:24:41.249Z,1.12194,1.12193,0.01,-0.07,49999.93',
    '2,EURUSD,Buy,Sell,2026-11-10T00:24:41.950Z,1.12194,1.12193,0.01,-0.07,49999.86',
    '3,USDJPY,Buy,Sell,2026-11-10T00:32:11.061Z,158.053,158.011,4,-130.32,49869.54',
    '4,GBPUSD,Sell,Buy,2026-11-10T08:41:30.794Z,1.34564,1.34547,4,-92.00,49324.29',
  ].join('\n');
  const statementRows = parseFingerprints(csv);
  if (new Set(statementRows.map(economicKey)).size !== 3) throw new Error('SELFTEST_KEY_COUNT');
  if (statementRows[0].closingDirection !== 'SELL') throw new Error('SELFTEST_CLOSING_DIR');
  if (statementRows[2].lots !== '4') throw new Error('SELFTEST_LOTS');

  const strandedDb = [
    { order_id: 'o-1', instrument: 'EURUSD', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '1.12194', exit_price: '1.12193', lot_size: '0.01',
      closed_at: '2026-11-10T00:24:41.500Z', fill: null },
    { order_id: 'o-2', instrument: 'USDJPY', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '158.053', exit_price: '158.111', lot_size: '4',
      closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  const m = matchStranded(strandedDb, statementRows);
  if (m.ambiguous.length !== 1 || m.ambiguous[0].db.order_id !== 'o-1') throw new Error('SELFTEST_AMBIGUOUS');
  if (m.unmatched.length !== 1 || m.unmatched[0].db.order_id !== 'o-2') throw new Error('SELFTEST_UNMATCHED');

  const closedDb = [
    { id: 't-1', instrument: 'EURUSD', direction: 'BUY', lot_size: '0.01', fill_price: '1.12194',
      exit_price: '1.12193', realised_pnl: '-0.01', commission: '-0.06', swap: '0',
      closed_at: '2026-11-10T00:24:41.249Z' },
    { id: 't-3', instrument: 'USDJPY', direction: 'BUY', lot_size: '4', fill_price: '158.053',
      exit_price: '158.011', realised_pnl: '-106.32', commission: '-24.00', swap: '0',
      closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  const b = matchClosedTrades(closedDb, statementRows);
  // Duplicate EURUSD economics remain ambiguous; only USDJPY matches.
  if (b.ambiguousStatement.length !== 2 || b.ambiguousTrades.length !== 1) throw new Error('SELFTEST_AMBIGUITY');
  if (b.matched.length !== 1) throw new Error('SELFTEST_SIDE_B');
  if (b.unmatchedStatement.length !== 1) throw new Error('SELFTEST_UNMATCHED_STATEMENT');
  const pnl = checkPnlComposition(closedDb, statementRows);
  if (pnl.mismatches.length !== 0) throw new Error('SELFTEST_PNL');
  const report = summarize({
    strandedMatch: m,
    closedMatch: b,
    pnl,
    statementRows,
    dbClosedCount: closedDb.length,
  });
  if (report.status !== 'DISCREPANCY_REQUIRES_REVIEW') throw new Error('SELFTEST_STATUS');
  return 'SELFTEST_OK';
}

// ─── entry point ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    console.log(JSON.stringify({ selfTest: selfTest() }));
    return;
  }
  const options = { broker: null, connectionId: process.env.IREXPRO_STATEMENT_CONNECTION_ID || null, from: null, to: null, fingerprints: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--broker') options.broker = args[++i];
    else if (args[i] === '--connection-id') options.connectionId = args[++i];
    else if (args[i] === '--from') options.from = args[++i];
    else if (args[i] === '--to') options.to = args[++i];
    else if (!args[i].startsWith('--')) options.fingerprints = args[i];
  }
  options.fingerprints =
    options.fingerprints || process.env.IREXPRO_STATEMENT_FINGERPRINTS || null;
  if (!options.fingerprints || !options.connectionId) {
    console.error('Usage: node verify-closed-demo-statement-match.cjs <fingerprints.csv> --connection-id <broker-connection-uuid> [--broker pepperstone-ctrader] [--from 2026-11-10] [--to 2026-11-24] [--self-test]');
    process.exitCode = 2;
    return;
  }
  const api = path.join(process.env.IREXPRO_AUDIT_ROOT || path.resolve(__dirname, '..', '..', '..'), 'apps/api');
  const env = require(path.join(api, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(api, '.env')));
  const { Client } = require(path.join(api, 'node_modules/pg'));
  const db = new Client({
    host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    statement_timeout: 15000, connectionTimeoutMillis: 5000,
    application_name: 'irexpro_statement_match_readonly',
  });
  try {
    await db.connect();
    const result = await inspect(db, options);
    console.log(JSON.stringify(result, null, 2));
    if (result.report.status !== 'FULLY_MATCHED') process.exitCode = 10;
  } finally {
    await db.end();
  }
}
if (require.main === module) {
  main().catch(() => { console.error('Statement match verification failed'); process.exitCode = 1; });
}
module.exports = { parseFingerprints, parseStatementInput, matchStranded, matchClosedTrades, checkPnlComposition, summarize, compareDecimal, normalizeDecimals, economicKey, utcDayBoundary, inspect, summarizeUnmatchedEconomics };
