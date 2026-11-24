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
function decimalToScaled(value, scale) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [i = '0', f = ''] = s.replace('-', '').split('.');
  const frac = (f + '0'.repeat(scale)).slice(0, scale);
  const v = BigInt(i || '0') * 10n ** BigInt(scale) + BigInt(frac || '0');
  return negative ? -v : v;
}

function compareDecimal(a, b, scale = 8) {
  const x = decimalToScaled(a, scale);
  const y = decimalToScaled(b, scale);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

function normalizeDecimals(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\u00a0/g, '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [i, f = ''] = body.split('.');
  const int = i.replace(/^0+(?=\d)/, '') || '0';
  const frac = (f || '').replace(/0+$/, '');
  const norm = frac.length ? `${int}.${frac}` : int;
  return (negative && (norm !== '0')) ? `-${norm}` : norm;
}

// ─── statement fingerprint parsing ──────────────────────────────────────────
function parseFingerprints(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('EMPTY_FINGERPRINT_CSV');
  const header = lines[0].split(',').map((h) => h.trim());
  const need = [
    'symbol',
    'opening_direction',
    'closing_time_utc',
    'entry_price',
    'closing_price',
    'closing_quantity_lots',
  ];
  const idx = {};
  for (const name of need) {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`MISSING_FINGERPRINT_COLUMN:${name}`);
    idx[name] = i;
  }
  const netIdx = header.indexOf('net_usd');
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const day = String(cells[idx.closing_time_utc] || '').slice(0, 10); // YYYY-MM-DD
    const row = {
      symbol: (cells[idx.symbol] || '').trim(),
      openingDirection: (cells[idx.opening_direction] || '').trim().toUpperCase(),
      closingDirection: (cells[idx.symbol] ? '' : ''),
      day,
      entry: normalizeDecimals(cells[idx.entry_price]),
      exit: normalizeDecimals(cells[idx.closing_price]),
      lots: normalizeDecimals(cells[idx.closing_quantity_lots]),
      net: netIdx >= 0 ? normalizeDecimals(cells[netIdx]) : null,
      raw: line,
    };
    row.closingDirection = row.openingDirection === 'BUY' ? 'SELL' : 'BUY';
    if (!row.symbol || !row.day || row.entry === null || row.exit === null || row.lots === null) {
      throw new Error(`UNPARSEABLE_FINGERPRINT_ROW:${line.slice(0, 120)}`);
    }
    rows.push(row);
  }
  return rows;
}

function economicKey(row) {
  return [row.symbol, row.openingDirection, row.day, row.entry, row.exit, row.lots].join('|');
}

// ─── matching core (pure; unit-testable) ──────────────────────────────────────
/**
 * Side A — stranded close orders ↔ statement deals.
 * A DB stranded row matches when: trade instrument == symbol, trade direction
 * == statement opening direction, order direction == statement closing
 * direction, fill_price == entry, exit_price == closing price, lot_size ==
 * lots, and the trade closed on the same UTC calendar day. Exact decimals.
 */
function matchStranded(strandedDb, statementRows) {
  const byKey = new Map();
  for (const s of statementRows) {
    const key = economicKey(s);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  for (const db of strandedDb) {
    const dbTradeDirection = String(db.trade_direction || '').toUpperCase();
    const dbOrderDirection = String(db.order_direction || '').toUpperCase();
    const day = db.closed_at ? new Date(db.closed_at).toISOString().slice(0, 10) : null;
    const candidates = [];
    for (const s of statementRows) {
      if (s.symbol !== db.instrument) continue;
      if (s.openingDirection !== dbTradeDirection) continue;
      if (s.closingDirection !== dbOrderDirection) continue;
      if (day !== null && s.day !== day) continue;
      if (compareDecimal(db.fill_price, s.entry) !== 0) continue;
      if (compareDecimal(db.exit_price, s.exit) !== 0) continue;
      if (compareDecimal(db.lot_size, s.lots) !== 0) continue;
      candidates.push(s);
    }
    if (candidates.length === 1) matched.push({ db, statement: candidates[0] });
    else if (candidates.length > 1) ambiguous.push({ db, candidates });
    else unmatched.push({ db });
  }
  return { matched, unmatched, ambiguous };
}

/**
 * Side B — closed trades ↔ statement deals (completeness of the window).
 * Every statement deal should have a DB closed trade with the same economics.
 */
function matchClosedTrades(closedDb, statementRows) {
  const matched = [];
  const unmatchedStatement = [];
  const matchedStatementIndices = new Set();
  for (const s of statementRows) {
    const candidates = closedDb.filter((t) => {
      const dir = String(t.direction || '').toUpperCase();
      if (t.instrument !== s.symbol || dir !== s.openingDirection) return false;
      if (compareDecimal(t.fill_price, s.entry) !== 0) return false;
      if (compareDecimal(t.exit_price, s.exit) !== 0) return false;
      if (compareDecimal(t.lot_size, s.lots) !== 0) return false;
      const day = t.closed_at ? new Date(t.closed_at).toISOString().slice(0, 10) : null;
      return day === s.day;
    });
    if (candidates.length >= 1) {
      matched.push({ statement: s, trade: candidates[0], duplicates: candidates.length - 1 });
      matchedStatementIndices.add(s);
    } else {
      unmatchedStatement.push(s);
    }
  }
  const unmatchedTrades = closedDb.filter((t) => {
    const dir = String(t.direction || '').toUpperCase();
    const day = t.closed_at ? new Date(t.closed_at).toISOString().slice(0, 10) : null;
    return !statementRows.some(
      (s) =>
        s.symbol === t.instrument &&
        s.openingDirection === dir &&
        s.day === day &&
        compareDecimal(t.fill_price, s.entry) === 0 &&
        compareDecimal(t.exit_price, s.exit) === 0 &&
        compareDecimal(t.lot_size, s.lots) === 0,
    );
  });
  return { matched, unmatchedStatement, unmatchedTrades };
}

/** Net P&L composition: statement net == realised + commission + swap (exact). */
function checkPnlComposition(closedDb, statementRows) {
  const mismatches = [];
  const missingEconomics = [];
  for (const t of closedDb) {
    if (t.realised_pnl === null || t.commission === null || t.swap === null) {
      missingEconomics.push(t);
      continue;
    }
    const day = t.closed_at ? new Date(t.closed_at).toISOString().slice(0, 10) : null;
    const dir = String(t.direction || '').toUpperCase();
    const s = statementRows.find(
      (row) =>
        row.symbol === t.instrument &&
        row.openingDirection === dir &&
        row.day === day &&
        compareDecimal(t.fill_price, row.entry) === 0 &&
        compareDecimal(t.exit_price, row.exit) === 0 &&
        compareDecimal(t.lot_size, row.lots) === 0,
    );
    if (!s || s.net === null) continue;
    const composed = decimalToScaled(t.realised_pnl, 8) +
      decimalToScaled(t.commission, 8) + decimalToScaled(t.swap, 8);
    const net = decimalToScaled(s.net, 8);
    if (composed !== net) {
      mismatches.push({
        trade_id: t.id,
        composed: String(t.realised_pnl) + ' + ' + String(t.commission) + ' + ' + String(t.swap),
        statement_net: s.net,
      });
    }
  }
  return { mismatches, missingEconomics };
}

function summarize(input) {
  const { strandedMatch, closedMatch, pnl, statementRows, dbClosedCount } = input;
  return {
    artifact: 'closed-demo-statement-match-v1',
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
    },
    pnlComposition: {
      checked: dbClosedCount - pnl.missingEconomics.length,
      mismatches: pnl.mismatches.length,
      missingEconomics: pnl.missingEconomics.length,
    },
    status:
      strandedMatch.unmatched.length === 0 &&
      strandedMatch.ambiguous.length === 0 &&
      closedMatch.unmatchedStatement.length === 0 &&
      closedMatch.unmatchedTrades.length === 0 &&
      pnl.mismatches.length === 0
        ? 'FULLY_MATCHED'
        : 'DISCREPANCY_REQUIRES_REVIEW',
  };
}

// ─── database access (read-only) ─────────────────────────────────────────────
async function inspect(db, options) {
  await db.query('BEGIN READ ONLY');
  try {
    const brokerFilter = options.broker ? "AND b.broker_id = $1" : '';
    const strandedParams = options.broker ? [options.broker] : [];
    const stranded = (
      await db.query(
        `SELECT o.id AS order_id, o.status AS order_status, o.order_kind,
                o.direction AS order_direction, o.provider_order_id, o.filled_quantity, o.requested_quantity,
                t.id AS trade_id, t.instrument, t.direction AS trade_direction, t.lot_size,
                t.fill_price, t.exit_price, t.realised_pnl, t.closed_at
         FROM trading.orders o
         JOIN trading.trades t ON t.id = o.trade_id AND t.user_id = o.user_id
              AND t.broker_connection_id = o.broker_connection_id
         JOIN broker.broker_connections b ON b.id = o.broker_connection_id
         WHERE o.status = 'RECONCILIATION_PENDING' AND o.order_kind = 'MARKET'
           AND o.provider_order_id IS NULL AND o.filled_quantity = 0
           AND t.status = 'CLOSED' AND o.direction <> t.direction
           AND UPPER(b.account_type) = 'DEMO' ${brokerFilter}
         ORDER BY t.closed_at ASC`,
        strandedParams,
      )
    ).rows;

    const closedParams = [];
    if (options.broker) closedParams.push(options.broker);
    if (options.from) closedParams.push(options.from);
    if (options.to) closedParams.push(options.to);
    const closed = (
      await db.query(
        `SELECT t.id, t.instrument, t.direction, t.lot_size, t.fill_price, t.exit_price,
                t.realised_pnl, t.commission, t.swap, t.closed_at
         FROM trading.trades t
         JOIN broker.broker_connections b ON b.id = t.broker_connection_id
         WHERE t.status = 'CLOSED' AND UPPER(b.account_type) = 'DEMO'
           ${options.broker ? 'AND b.broker_id = $' + (closedParams.indexOf(options.broker) + 1) : ''}
           ${options.from ? "AND t.closed_at >= $".concat(String(closedParams.indexOf(options.from) + 1)) : ''}
           ${options.to ? "AND t.closed_at < $".concat(String(closedParams.indexOf(options.to) + 1)) : ''}
         ORDER BY t.closed_at ASC`,
        closedParams,
      )
    ).rows;

    const statementRows = parseFingerprints(fs.readFileSync(options.fingerprints, 'utf-8'));
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
        pnlMismatches: pnl.mismatches,
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
  // Both EURUSD duplicate rows match the same single trade, plus USDJPY.
  if (b.matched.length !== 3) throw new Error('SELFTEST_SIDE_B');
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
  const options = { broker: null, from: null, to: null, fingerprints: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--broker') options.broker = args[++i];
    else if (args[i] === '--from') options.from = args[++i];
    else if (args[i] === '--to') options.to = args[++i];
    else if (!args[i].startsWith('--')) options.fingerprints = args[i];
  }
  options.fingerprints =
    options.fingerprints || process.env.IREXPRO_STATEMENT_FINGERPRINTS || null;
  if (!options.fingerprints) {
    console.error('Usage: node verify-closed-demo-statement-match.cjs <fingerprints.csv> [--broker pepperstone-ctrader] [--from 2026-11-10] [--to 2026-11-24] [--self-test]');
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
module.exports = { parseFingerprints, matchStranded, matchClosedTrades, checkPnlComposition, summarize, compareDecimal, normalizeDecimals, economicKey };
