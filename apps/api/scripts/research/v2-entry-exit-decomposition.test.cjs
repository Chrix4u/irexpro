'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decomposeTradeOutcome,
  decomposeCohort,
  classifyEconomicDeficit,
} = require('./v2-entry-exit-decomposition.cjs');

test('win beyond design decomposes exactly (negative truncation = exceeded)', () => {
  const r = decomposeTradeOutcome({
    direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.1020,
    stopDistance: 0.0010, designTargetR: 1.6,
    commissionR: 0.05, swapR: 0.02,
  });
  assert.ok(Math.abs(r.realizedGrossR - 2) < 1e-9);
  assert.equal(r.costDragR, 0.07);
  assert.ok(Math.abs(r.realizedNetR - 1.93) < 1e-9);
  assert.equal(r.designPayoffR, 1.6);
  assert.ok(Math.abs(r.winTruncationR - (-0.4)) < 1e-9);
  assert.equal(r.lossExtensionR, 0);
  assert.equal(r.identityHolds, true); // 1.93 - 0.4 + 0 + 0.07 = 1.6
});

test('loss extended beyond the 1R design is isolated as loss extension', () => {
  const r = decomposeTradeOutcome({
    direction: 'SELL', entryPrice: 1.1000, exitPrice: 1.1020,
    stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.07,
  });
  assert.ok(Math.abs(r.realizedGrossR - (-2)) < 1e-9);
  assert.equal(r.designPayoffR, -1);
  assert.ok(Math.abs(r.lossExtensionR - 1) < 1e-9);
  assert.ok(Math.abs(r.realizedNetR - (-2.07)) < 1e-9);
  assert.equal(r.identityHolds, true); // -2.07 + 0 + 1 + 0.07 = -1
});

test('missing or non-positive stop distance is a typed refusal', () => {
  assert.throws(() => decomposeTradeOutcome({
    direction: 'BUY', entryPrice: 1.1, exitPrice: 1.2,
    stopDistance: 0, designTargetR: 1.6,
  }), /DECOMPOSITION_MISSING_STOP_DISTANCE/);
  assert.throws(() => decomposeTradeOutcome({
    direction: 'BUY', entryPrice: 1.1, exitPrice: 1.2,
    designTargetR: 1.6,
  }), /DECOMPOSITION_MISSING_STOP_DISTANCE/);
  assert.throws(() => decomposeTradeOutcome({
    direction: 'HOLD', entryPrice: 1.1, exitPrice: 1.2,
    stopDistance: 0.001, designTargetR: 1.6,
  }), /DECOMPOSITION_DIRECTION_INVALID/);
});

test('cohort decomposition: totals, identity, ranked deficit channels', () => {
  const trades = [
    // gross +1.6R exactly at design; costs 0.07
    { direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.1016,
      stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.07 },
    // gross +1.2R (truncated 0.4R); costs 0.08
    { direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.1012,
      stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.08 },
    // gross +0.5R (truncated 1.1R); costs 0.06
    { direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.1005,
      stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.06 },
    // gross -1.0R exactly at stop; costs 0.07
    { direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.0990,
      stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.07 },
    // gross -1.5R (extended 0.5R); costs 0.07
    { direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.0985,
      stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.07 },
  ];
  const c = decomposeCohort(trades);
  assert.equal(c.n, 5);
  assert.equal(c.winCount, 3);
  assert.equal(c.winRate, 0.6);
  assert.ok(Math.abs(c.totalDesignPayoffR - 2.8) < 1e-9); // 3*1.6 - 2
  assert.ok(Math.abs(c.totalRealizedNetR - 0.45) < 1e-9);
  assert.ok(Math.abs(c.totalWinTruncationR - 1.5) < 1e-9);
  assert.ok(Math.abs(c.totalLossExtensionR - 0.5) < 1e-9);
  assert.ok(Math.abs(c.totalCostDragR - 0.35) < 1e-9);
  assert.ok(Math.abs(c.avgWinR - 1.03) < 1e-9);
  assert.ok(Math.abs(c.avgLossR - (-1.32)) < 1e-9);
  assert.ok(Math.abs(c.payoffRatio - 1.03 / 1.32) < 1e-9);
  assert.equal(c.identityHoldsForAll, true);
  // deficit budget 2.35R: truncation 1.5, extension 0.5, cost 0.35
  assert.equal(c.decomposition.dominant, 'WIN_TRUNCATION');
  assert.deepEqual(c.decomposition.ranked,
    ['WIN_TRUNCATION', 'LOSS_EXTENSION', 'COST_DRAG']);
  assert.ok(Math.abs(c.decomposition.shares.WIN_TRUNCATION - 1.5 / 2.35) < 1e-9);
});

test('cohort identity ties realized net to design payoff and deltas', () => {
  const c = decomposeCohort([
    { direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.1012,
      stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.08 },
    { direction: 'BUY', entryPrice: 1.1000, exitPrice: 1.0985,
      stopDistance: 0.0010, designTargetR: 1.6, commissionR: 0.07 },
  ]);
  // 2*design(1.6, -1) = 0.6 total design; realized 1.12 + (-1.57) = -0.45
  assert.ok(Math.abs(c.totalDesignPayoffR - 0.6) < 1e-9);
  assert.ok(Math.abs(c.totalRealizedNetR - (-0.45)) < 1e-9);
  // -0.45 + 0.4 (truncated) + 0.5 (extended) + 0.15 (cost) = 0.6 design
  assert.ok(Math.abs(
    (c.totalRealizedNetR + c.totalWinTruncationR + c.totalLossExtensionR +
      c.totalCostDragR) - c.totalDesignPayoffR) < 1e-9);
});

test('deficit classification returns MIXED when top channels are near-equal', () => {
  const mixed = classifyEconomicDeficit({
    totalWinTruncationR: 1.0, totalLossExtensionR: 0.9, totalCostDragR: 0.9 });
  assert.equal(mixed.dominant, 'MIXED');
  assert.ok(Math.abs(mixed.shares.WIN_TRUNCATION - 0.357143) < 1e-6);
  const none = classifyEconomicDeficit({
    totalWinTruncationR: 0, totalLossExtensionR: 0, totalCostDragR: 0 });
  assert.equal(none.dominant, 'NONE');
  assert.throws(() => classifyEconomicDeficit({
    totalWinTruncationR: -1, totalLossExtensionR: 0, totalCostDragR: 0 }),
    /DEFICIT_INPUT_INVALID/);
});
