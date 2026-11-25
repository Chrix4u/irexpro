'use strict';
/**
 * Pins the historical-reconciliation analysis of the two unmatched EURUSD
 * deals (and the 126 generic cTrader DEMO records) to the GENUINE broker
 * evidence fixture — every asserted number is recomputed exactly from
 * apps/api/scripts/fixtures/pepperstone-demo-deal-fingerprints.csv.
 */
const test = require('node:test');
const assert = require('node:assert');
const { main } = require('./audit-unmatched-deal-historical-reconciliation.cjs');

test('the duplicate-fingerprint pair IS the two unmatched EURUSD deals', () => {
  const result = main();
  assert.equal(result.deals, 424);
  assert.equal(result.distinct_fingerprints, 423);
  assert.equal(result.duplicate_fingerprint_pairs, 1);
  const pairRows = result.unmatched_pair.rows;
  assert.equal(pairRows.length, 2);
  assert.deepEqual(
    pairRows.map((r) => [r.seq, r.symbol, r.quantity_lots, r.net_usd]),
    [
      [1, 'EURUSD', '0.01', '-0.07'],
      [2, 'EURUSD', '0.01', '-0.07'],
    ],
  );
  assert.equal(result.unmatched_pair.interval_ms, 701);
  assert.equal(result.unmatched_pair.combined_net_usd, '-0.14');
  assert.equal(result.unmatched_pair.fingerprints_identical_except_close_time, true);
});

test('the pair economics are CLOSED — exact balance chain, no missing money', () => {
  const result = main();
  assert.equal(result.opening_balance_derived_from_first_row, '50000');
  assert.equal(result.closing_balance, '42954.79');
  assert.equal(result.net_total, '-7045.21');
  assert.equal(result.balance_chain_errors, 0);
  assert.equal(result.deposit_plus_realised_equals_balance, true);
});

test('corpus-derived context: first transactions, commission family, size not unique', () => {
  const result = main();
  const p = result.unmatched_pair;
  assert.equal(p.corpus_position.first_two_transactions, true);
  assert.equal(p.corpus_position.next_deal_after_pair_utc, '2026-11-10T00:32:11.061Z');
  assert.equal(p.commission_family.pair_residual_per_lot_usd, -6);
  assert.equal(p.commission_family.consistent_with_corpus_family, true);
  // Micro-lot size is NOT distinguishing evidence — the audit's 422/424
  // match rate covers the other micro-lot deals.
  assert.equal(p.lot_size_context.corpus_micro_lot_0_01_deals_total, 13);
  assert.equal(p.lot_size_context.corpus_micro_lot_deals_excluding_pair, 11);
  assert.equal(p.lot_size_context.corpus_median_lot, 2);
});

test('the 126 generic cTrader records: documented negative — no in-repo native evidence', () => {
  const result = main();
  assert.equal(result.generic_ctrader_126.in_repository_native_deal_evidence, false);
  assert.match(
    result.generic_ctrader_126.standing_decision,
    /no internal records created; attribution stays unknown/,
  );
});
