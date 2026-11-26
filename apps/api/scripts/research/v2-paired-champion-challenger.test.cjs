'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { comparePairedWindows, signTestP } = require('./v2-paired-champion-challenger.cjs');

// Deterministic synthetic window generator: challenger wins each window by
// a fixed margin with controlled noise.
function windows(count, seedNetFn) {
  return Array.from({ length: count }, (_, i) => ({ windowId: i + 1, netPnlUsd: seedNetFn(i) }));
}

test('refuses unpaired windows before any comparison', () => {
  const c = windows(10, (i) => i % 2 ? 5 : -4);
  const h = windows(10, (i) => i % 2 ? 6 : -3);
  h.pop(); // challenger missing window 10
  const r = comparePairedWindows(c, h);
  assert.equal(r.status, 'UNPAIRED_EVIDENCE');
  assert.deepEqual(r.unpairedWindowIds, [10]);
  assert.equal(r.executionAuthority, 'NONE');
});

test('refuses duplicate window ids on either side', () => {
  const c = windows(4, () => 1);
  const h = [...windows(3, () => 2), { windowId: 3, netPnlUsd: 2 }];
  const r = comparePairedWindows(c, h);
  assert.equal(r.status, 'UNPAIRED_EVIDENCE');
  assert.deepEqual(r.duplicateWindowIds.challenger, [3]);
});

test('insufficient window sample returns descriptive-only result', () => {
  const c = windows(5, () => 10);
  const h = windows(5, () => 30);
  const r = comparePairedWindows(c, h, { minWindows: 30 });
  assert.equal(r.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(r.verdict, undefined);
  assert.match(r.reason, /cannot support a comparative conclusion/);
  // Descriptive side metrics are still computed exactly.
  assert.equal(r.champion.netAfterCostUsd, 50);
  assert.equal(r.challenger.netAfterCostUsd, 150);
});

test('a large consistent paired advantage yields CHALLENGER_ADVANTAGE', () => {
  const c = windows(60, (i) => (i % 2 ? 5 : -4));
  const h = windows(60, (i) => (i % 2 ? 25 : 6)); // challenger always +20 net
  const r = comparePairedWindows(c, h);
  assert.equal(r.status, 'MEASURED');
  assert.equal(r.verdict, 'CHALLENGER_ADVANTAGE');
  // odd windows: +20, even windows: +10 → mean paired diff 15.
  assert.equal(r.meanPairedDiffUsd, 15);
  assert.equal(r.bootstrap.ciExcludesZero, true);
  assert.equal(r.signTest.exactTwoSidedP, 0);
  assert.ok(r.bootstrap.ciLowDiffUsd > 0);
  assert.equal(r.challenger.netAfterCostUsd, 60 * 15.5);
});

test('noisy zero-mean differences stay NOT_DISTINGUISHABLE', () => {
  // Challenger wins +100 on 15 windows and loses -100 on 15 windows.
  const c = windows(30, () => 0);
  const h = windows(30, (i) => (i < 15 ? 100 : -100));
  const r = comparePairedWindows(c, h);
  assert.equal(r.verdict, 'NOT_DISTINGUISHABLE');
  assert.equal(r.meanPairedDiffUsd, 0);
  assert.equal(r.bootstrap.ciExcludesZero, false);
  assert.equal(r.signTest.exactTwoSidedP, 1);
});

test('sign-test exact p-values match hand-computed binomial tails', () => {
  // 9 of 10 positive: two-sided p = 2*(P(9)+P(10)) = 2*(10+1)/1024 = 11/512
  assert.ok(Math.abs(signTestP(9, 10) - 11 / 512) < 1e-12);
  // 5 of 10: p = 1.0 by symmetry.
  assert.equal(signTestP(5, 10), 1);
  // 10 of 10: p = 2/1024 = 1/512
  assert.ok(Math.abs(signTestP(10, 10) - 1 / 512) < 1e-12);
});

test('deterministic bootstrap is reproducible for identical inputs and seeds', () => {
  const c = windows(40, (i) => (i % 3 ? 2 : -1));
  const h = windows(40, (i) => (i % 3 ? 5 : 1));
  const a = comparePairedWindows(c, h, { seed: 99 });
  const b = comparePairedWindows(c, h, { seed: 99 });
  assert.deepEqual(a, b);
});

test('the report never claims profitability and stays research-only', () => {
  const c = windows(60, () => 1);
  const h = windows(60, () => 3);
  const r = comparePairedWindows(c, h);
  assert.equal(r.researchOnly, true);
  assert.match(r.interpretationRule, /not a profitability claim/);
  assert.match(r.caveats.join(' '), /broker-observed on BOTH sides/);
});
