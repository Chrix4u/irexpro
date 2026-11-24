'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseFingerprints,
  matchStranded,
  matchClosedTrades,
  checkPnlComposition,
  summarize,
  compareDecimal,
  normalizeDecimals,
  economicKey,
} = require('./verify-closed-demo-statement-match.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'pepperstone-demo-deal-fingerprints.csv');

test('parses the owner-exported statement fingerprints exactly (424 deals, 423 distinct keys)', () => {
  const rows = parseFingerprints(fs.readFileSync(FIXTURE, 'utf-8'));
  assert.equal(rows.length, 424);
  assert.equal(new Set(rows.map(economicKey)).size, 423);
  // The single duplicated economics: two EURUSD 0.01-lot closes 0.7s apart.
  const dupes = rows.filter((r) => economicKey(r) === 'EURUSD|BUY|2026-11-10|1.12194|1.12193|0.01');
  assert.equal(dupes.length, 2);
  assert.equal(rows[0].symbol, 'EURUSD');
  assert.equal(rows[0].openingDirection, 'BUY');
  assert.equal(rows[0].closingDirection, 'SELL');
  assert.equal(rows[0].entry, '1.12194');
  assert.equal(rows[0].exit, '1.12193');
  assert.equal(rows[0].lots, '0.01');
});

test('exact decimal comparison has no float drift', () => {
  assert.equal(compareDecimal('2.8000', '2.8'), 0);
  assert.equal(compareDecimal('0.01', '0.0100'), 0);
  assert.equal(compareDecimal('158.053', '158.011'), 1);
  assert.equal(compareDecimal('-0.07', '-0.0700'), 0);
  assert.equal(compareDecimal('not-a-number', '1') , null);
  assert.equal(normalizeDecimals('2.8000'), '2.8');
  assert.equal(normalizeDecimals('-0.0700'), '-0.07');
  assert.equal(normalizeDecimals(null), null);
});

test('stranded close orders match the statement on the exact economic dimensions', () => {
  // Slice rows 2-4 (USDCHF/USDJPY/GBPUSD first batch) — distinct economics;
  // the first two rows are the duplicated EURUSD pair handled separately.
  const statement = parseFingerprints(fs.readFileSync(FIXTURE, 'utf-8')).slice(0, 5);
  const db = [
    { order_id: 'o-1', instrument: 'USDJPY', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '158.053', exit_price: '158.011', lot_size: '4',
      closed_at: '2026-11-10T00:32:11.061Z' },
    { order_id: 'o-2', instrument: 'AUDUSD', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '0.69213', exit_price: '0.69206', lot_size: '4',
      closed_at: '2026-11-10T02:13:14.389Z' },
  ];
  const m = matchStranded(db, statement);
  assert.equal(m.matched.length, 2);
  assert.equal(m.unmatched.length, 0);
  assert.equal(m.ambiguous.length, 0);
});

test('ambiguous duplicate-economics deals are reported, never silently matched', () => {
  const statement = parseFingerprints(
    'seq,symbol,opening_direction,closing_order_direction,closing_time_utc,entry_price,closing_price,closing_quantity_lots,net_usd\n' +
      '1,EURUSD,Buy,Sell,2026-11-10T00:24:41.249Z,1.12194,1.12193,0.01,-0.07\n' +
      '2,EURUSD,Buy,Sell,2026-11-10T00:24:41.950Z,1.12194,1.12193,0.01,-0.07\n',
  );
  const db = [
    { order_id: 'o-1', instrument: 'EURUSD', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '1.12194', exit_price: '1.12193', lot_size: '0.01',
      closed_at: '2026-11-10T00:24:41.500Z' },
  ];
  const m = matchStranded(db, statement);
  assert.equal(m.ambiguous.length, 1);
  assert.equal(m.matched.length, 0);
});

test('mismatched exit price or lot size never matches (fail-closed, no nearest-guess)', () => {
  const statement = parseFingerprints(
    'seq,symbol,opening_direction,closing_order_direction,closing_time_utc,entry_price,closing_price,closing_quantity_lots,net_usd\n' +
      '1,USDJPY,Buy,Sell,2026-11-10T00:32:11.061Z,158.053,158.011,4,-130.32\n',
  );
  const wrongPrice = [
    { order_id: 'o-price', instrument: 'USDJPY', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '158.053', exit_price: '158.111', lot_size: '4', closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  const wrongLots = [
    { order_id: 'o-lots', instrument: 'USDJPY', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '158.053', exit_price: '158.011', lot_size: '3.9', closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  assert.equal(matchStranded(wrongPrice, statement).unmatched.length, 1);
  assert.equal(matchStranded(wrongLots, statement).unmatched.length, 1);
});

test('net P&L composition check is exact: realised + commission + swap == statement net', () => {
  const statement = parseFingerprints(
    'seq,symbol,opening_direction,closing_order_direction,closing_time_utc,entry_price,closing_price,closing_quantity_lots,net_usd\n' +
      '1,USDJPY,Buy,Sell,2026-11-10T00:32:11.061Z,158.053,158.011,4,-130.32\n',
  );
  const exact = [
    { id: 't-ok', instrument: 'USDJPY', direction: 'BUY', lot_size: '4', fill_price: '158.053',
      exit_price: '158.011', realised_pnl: '-106.32', commission: '-24.00', swap: '0',
      closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  const offByCent = [
    { id: 't-bad', instrument: 'USDJPY', direction: 'BUY', lot_size: '4', fill_price: '158.053',
      exit_price: '158.011', realised_pnl: '-106.31', commission: '-24.00', swap: '0',
      closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  assert.equal(checkPnlComposition(exact, statement).mismatches.length, 0);
  assert.equal(checkPnlComposition(offByCent, statement).mismatches.length, 1);
});

test('summary reports FULLY_MATCHED only when both directions and P&L composition reconcile', () => {
  const statement = parseFingerprints(
    'seq,symbol,opening_direction,closing_order_direction,closing_time_utc,entry_price,closing_price,closing_quantity_lots,net_usd\n' +
      '1,USDJPY,Buy,Sell,2026-11-10T00:32:11.061Z,158.053,158.011,4,-130.32\n',
  );
  const dbTrades = [
    { id: 't-1', instrument: 'USDJPY', direction: 'BUY', lot_size: '4', fill_price: '158.053',
      exit_price: '158.011', realised_pnl: '-106.32', commission: '-24.00', swap: '0',
      closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  const stranded = [
    { order_id: 'o-1', instrument: 'USDJPY', trade_direction: 'BUY', order_direction: 'SELL',
      fill_price: '158.053', exit_price: '158.011', lot_size: '4', closed_at: '2026-11-10T00:32:11.061Z' },
  ];
  const allGood = summarize({
    strandedMatch: matchStranded(stranded, statement),
    closedMatch: matchClosedTrades(dbTrades, statement),
    pnl: checkPnlComposition(dbTrades, statement),
    statementRows: statement,
    dbClosedCount: 1,
  });
  assert.equal(allGood.status, 'FULLY_MATCHED');
  assert.equal(allGood.readOnly, true);

  const noStrandedMatch = summarize({
    strandedMatch: { matched: [], unmatched: stranded, ambiguous: [] },
    closedMatch: matchClosedTrades(dbTrades, statement),
    pnl: checkPnlComposition(dbTrades, statement),
    statementRows: statement,
    dbClosedCount: 1,
  });
  assert.equal(noStrandedMatch.status, 'DISCREPANCY_REQUIRES_REVIEW');
});

test('self-test mode exercises the same matcher with fixtures (no database)', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('node', [path.join(__dirname, 'verify-closed-demo-statement-match.cjs'), '--self-test'], { encoding: 'utf-8' });
  assert.equal(JSON.parse(out).selfTest, 'SELFTEST_OK');
});

test('one statement row cannot be reused for two internal rows, nor vice versa', () => {
  const s = parseFingerprints(fs.readFileSync(FIXTURE, 'utf-8'))[2];
  const trade = { id: 't1', instrument: s.symbol, direction: s.openingDirection, fill_price: s.entry, exit_price: s.exit, lot_size: s.lots, closed_at: `${s.day}T00:32:11Z` };
  const t2 = { ...trade, id: 't2' };
  const a = matchClosedTrades([trade, t2], [s]);
  assert.equal(a.matched.length, 0);
  assert.equal(a.ambiguousTrades.length, 2);
  assert.equal(a.ambiguousStatement.length, 1);
  const b = matchClosedTrades([trade], [s, { ...s }]);
  assert.equal(b.matched.length, 0);
  assert.equal(b.ambiguousStatement.length, 2);
  const order = { ...trade, order_id: 'o1', trade_direction: trade.direction, order_direction: s.closingDirection };
  const c = matchStranded([order, { ...order, order_id: 'o2' }], [s]);
  assert.equal(c.matched.length, 0);
  assert.equal(c.ambiguous.length, 2);
  assert.equal(matchStranded([{ ...order, closed_at: null }], [s]).unmatched.length, 1);
});

test('missing or invalid monetary evidence never produces a fully matched report', () => {
  const s = parseFingerprints(fs.readFileSync(FIXTURE, 'utf-8'))[2];
  const trade = { id: 't1', instrument: s.symbol, direction: s.openingDirection, fill_price: s.entry, exit_price: s.exit, lot_size: s.lots, closed_at: `${s.day}T00:32:11Z`, realised_pnl: 'bad', commission: '0', swap: '0' };
  const pnl = checkPnlComposition([trade], [s]);
  assert.equal(pnl.checked, 0);
  assert.equal(pnl.missingEconomics.length, 1);
  assert.equal(summarize({ strandedMatch: matchStranded([], [s]), closedMatch: matchClosedTrades([trade], [s]), pnl, statementRows: [s], dbClosedCount: 1 }).status, 'DISCREPANCY_REQUIRES_REVIEW');
  assert.equal(compareDecimal('1.000000001', '1'), null);
});

test('P&L composition retains sub-eight-decimal differences instead of rounding them away', () => {
  const s = parseFingerprints(fs.readFileSync(FIXTURE, 'utf-8'))[2];
  const trade = { id: 't1', instrument: s.symbol, direction: s.openingDirection, fill_price: s.entry, exit_price: s.exit, lot_size: s.lots, closed_at: `${s.day}T00:32:11Z`, realised_pnl: '-106.320000001', commission: '-24', swap: '0' };
  const pnl = checkPnlComposition([trade], [s]);
  assert.equal(pnl.checked, 1);
  assert.equal(pnl.mismatches.length, 1);
  assert.equal(checkPnlComposition([{ ...trade, swap: '0.000000001' }], [s]).mismatches.length, 0);
});

test('scientific notation from the statement is expanded exactly, with bounded exponent', () => {
  assert.equal(normalizeDecimals('-2.4E+2'), '-240');
  assert.equal(normalizeDecimals('1.230E-3'), '0.00123');
  assert.equal(normalizeDecimals('9007199254740993E+1'), '90071992547409930');
  assert.equal(normalizeDecimals('-0E+2'), '0');
  assert.equal(normalizeDecimals('1e999999999'), null);
  const statement = parseFingerprints(fs.readFileSync(FIXTURE, 'utf-8'));
  assert.equal(statement.filter((row) => row.net === null).length, 0);
});
