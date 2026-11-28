'use strict';
/**
 * Tests for the controlled offline ablation campaign (directive item 4:
 * premature winner truncation, excessive turnover, transaction-cost drag).
 * Sizes are CI-safe (30 replays per arm); the full-scale run is a committed
 * artifact executed by the CLI runner.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  runAblationArm,
  runTurnoverAblation,
  runCostDragAblation,
  runWinnerTruncationAblation,
  NO_LADDER_ARM,
} = require('./v2-ablation-campaign.cjs');

const OPTS = { replays: 30, nBars: 600, seedBase: 4310000 };

test('ablation arms refuse invalid configurations (0 must not be defaulted)', () => {
  assert.throws(() => runAblationArm(
    { kind: 'ENTRY_GATE', label: 'g', entryGate: 0.6 }, { replays: 0, nBars: 600 }),
    /ABLATION_REPLAYS_INVALID/);
  assert.throws(() => runAblationArm(
    { kind: 'ENTRY_GATE', label: 'g', entryGate: 0.6 }, { replays: 3, nBars: 100 }),
    /ABLATION_ARM_INVALID/);
  assert.throws(() => runAblationArm(
    { kind: 'ENTRY_GATE', label: 'g', entryGate: 0.6 },
    { replays: 3, nBars: 600, seedBase: 0 }),
    /ABLATION_SEED_INVALID/);
});

test('the no-ladder arm is a valid EI-1 policy and actually trades', () => {
  // 30 replays so per-arm aggregates are estimable (typed refusal below 30).
  const arm = runAblationArm(NO_LADDER_ARM, { replays: 30, nBars: 600 });
  assert.ok(arm.tradesPerReplay.mean > 0, 'no-ladder arm produces trades');
  assert.strictEqual(arm.armKind, 'EXIT_PRESET');
});

test('turnover ablation: higher entry gates monotonically reduce trade counts', () => {
  const arms = runTurnoverAblation(OPTS).arms;
  const byGate = arms.filter((a) => a.armKind === 'ENTRY_GATE');
  assert.strictEqual(byGate.length, 4);
  assert.ok(byGate[0].tradesPerReplay.mean > byGate[1].tradesPerReplay.mean,
    'gate 0.50 trades > gate 0.60');
  assert.ok(byGate[1].tradesPerReplay.mean > byGate[2].tradesPerReplay.mean,
    'gate 0.60 trades > gate 0.70');
  assert.ok(byGate[2].tradesPerReplay.mean > byGate[3].tradesPerReplay.mean,
    'gate 0.70 trades > gate 0.80');
});

test('cost-drag ablation: net expectancy degrades monotonically with cost multiplier', () => {
  const arms = runCostDragAblation(OPTS).arms;
  assert.strictEqual(arms.length, 4);
  for (let i = 0; i + 1 < arms.length; i += 1) {
    assert.ok(arms[i].meanCostR.mean < arms[i + 1].meanCostR.mean,
      `costR increases x${(i + 1) / 2} -> x${(i + 2) / 2}`);
    assert.ok(arms[i].meanNetR.mean > arms[i + 1].meanNetR.mean,
      `netR decreases with cost multiplier (arm ${i})`);
  }
  // The cost arms must all be estimable (30 replays) with real intervals.
  for (const arm of arms) {
    assert.ok(arm.meanNetR.interval95[0] !== null);
    assert.ok(Number.isFinite(arm.meanCostR.se));
  }
});

test('winner-truncation ablation: looser locks capture more of the MFE', () => {
  const arms = runWinnerTruncationAblation(OPTS).arms;
  assert.strictEqual(arms.length, 4);
  const [tighter, frozen, looser, noLadder] = arms;
  assert.ok(tighter.meanCapture.mean < frozen.meanCapture.mean,
    'tighter lock reduces capture');
  assert.ok(frozen.meanCapture.mean < looser.meanCapture.mean,
    'looser lock increases capture');
  assert.ok(noLadder.tradesPerReplay.mean !== frozen.tradesPerReplay.mean,
    'no-ladder geometry changes trade behavior');
});

test('ablation discipline is recorded on every ablation block', () => {
  for (const block of [runTurnoverAblation({ replays: 2, nBars: 400 }),
    runCostDragAblation({ replays: 2, nBars: 400 }),
    runWinnerTruncationAblation({ replays: 2, nBars: 400 })]) {
    assert.ok(block.discipline.includes('no arm is promoted'));
    assert.ok(block.discipline.includes('frozen'));
  }
});
