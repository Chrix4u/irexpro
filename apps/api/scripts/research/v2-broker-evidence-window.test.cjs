'use strict';
/**
 * Tests for the V1 broker-confirmed evidence window (real statement data —
 * the only non-synthetic performance data in the V2 track).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const {
  EVIDENCE_FILE,
  loadBrokerEvidenceWindow,
} = require('./v2-broker-evidence-window.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

test('the statement fixture is committed byte-identical to the upload', () => {
  const fixture = path.join(repoRoot, 'apps/api/scripts/research', EVIDENCE_FILE);
  assert.ok(fs.existsSync(fixture));
  const text = fs.readFileSync(fixture, 'utf8');
  assert.strictEqual(text.split('\n').length, 30);
  assert.ok(text.startsWith('Deals'));
});

test('the window parses to exactly 19 deals on 2026-11-10', () => {
  const e = loadBrokerEvidenceWindow(repoRoot);
  assert.strictEqual(e.dealCount, 19);
  assert.ok(e.deals.every((d) => d.openedAt.startsWith('10 Nov 2026')));
  assert.ok(e.deals.every((d) => d.lots === 0.01 || d.lots === 4));
});

test('pinned broker-confirmed totals reconcile exactly', () => {
  const e = loadBrokerEvidenceWindow(repoRoot);
  // Net USD of the window: broker total row == sum of deals == realized
  // P&L in the summary block == -442.49.
  assert.strictEqual(Math.round(e.netUsd * 100) / 100, -442.49);
  assert.strictEqual(e.windowNetTotalRow, -442.49);
  assert.strictEqual(e.summaryRealisedUsd, -442.49);
  assert.strictEqual(e.wins, 5);
  assert.strictEqual(e.losses, 14);
  assert.strictEqual(Math.round(e.winRate * 10000) / 10000, 0.2632);
  assert.strictEqual(Math.round(e.profitFactor * 10000) / 10000, 0.7912);
  assert.strictEqual(Math.round(e.expectancyUsdPerTrade * 100) / 100, -23.29);
  assert.strictEqual(e.firstBalanceUsd, 50000);
  assert.strictEqual(e.lastBalanceUsd, 49557.51);
  assert.strictEqual(e.summaryBalanceUsd, 42404.16);
  assert.strictEqual(e.summaryEquityUsd, 42404.16);
});

test('all four verification checks pass on the real window', () => {
  const e = loadBrokerEvidenceWindow(repoRoot);
  assert.strictEqual(e.verification.netTotalMatchesDeals, true);
  assert.strictEqual(e.verification.balanceChainContinuous, true);
  assert.strictEqual(e.verification.realizedMatches, true);
  assert.strictEqual(e.verification.duplicateDealIds, false);
});

test('the window-vs-account gap is recorded, not silently reconciled', () => {
  const e = loadBrokerEvidenceWindow(repoRoot);
  // The deals section covers only the 10 Nov window; the summary block is
  // the account state at the 28 Nov export. The gap is documented
  // evidence of the window-vs-account scope difference.
  assert.strictEqual(Math.round(e.windowVsAccountGapUsd * 100) / 100, -7153.35);
});

test('the split-second EURUSD pair is identified (prior investigation)', () => {
  const e = loadBrokerEvidenceWindow(repoRoot);
  assert.deepStrictEqual(e.splitSecondPair, ['DID332349465', 'DID332349467']);
  assert.strictEqual(e.deals[0].openedAt, e.deals[1].openedAt);
});

test('implied round-turn friction per lot is plausible and pinned', () => {
  const e = loadBrokerEvidenceWindow(repoRoot);
  // Median implied friction (theoretical mid P&L minus broker Net) in
  // pips per lot across the 19 deals.
  assert.ok(e.medianImpliedFrictionPipsPerLot > 0.3 &&
    e.medianImpliedFrictionPipsPerLot < 1.0,
  `median friction ${e.medianImpliedFrictionPipsPerLot}`);
});

test('malformed evidence is refused, never guessed', () => {
  assert.throws(() => loadBrokerEvidenceWindow(repoRoot, 'does-not-exist.csv'),
    /EVIDENCE_FILE_NOT_FOUND/);
});
