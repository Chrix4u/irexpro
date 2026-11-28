'use strict';
/**
 * Tests for the P1-5 exit-intelligence consolidation contract.
 * Every pinned constant below is a byte-exact copy from the cited source
 * lines; the tests refuse inventory drift and malformed EI-1 ladders.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  EXIT_ENGINE_INVENTORY,
  EXIT_REASONS,
  EI1_CHAMPION_BASELINE,
  V2_CHALLENGER_EXIT_PRESET,
  validateEI1Policy,
  applyEI1Policy,
  emulateExitEngine,
  verifyExitEnginePaths,
  summarizeExitIntelligenceContract,
} = require('./v2-exit-intelligence-contract.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

test('six-engine inventory is path-verified (drift detector)', () => {
  const { verified, total } = verifyExitEnginePaths(repoRoot);
  assert.strictEqual(total, 6);
  assert.strictEqual(verified, 6);
});

test('inventory constants are byte-exact copies of the cited lines', () => {
  const byKey = Object.fromEntries(EXIT_ENGINE_INVENTORY.map((e) => [e.key, e]));
  // X1 paper-broker ladder (l.660-680, 719-725)
  assert.deepStrictEqual(byKey.X1.constants.standardArmR, 0.50);
  assert.deepStrictEqual(byKey.X1.constants.m1RescueArmR, 0.395);
  assert.deepStrictEqual(byKey.X1.constants.m1RescueRetain, 0.40);
  assert.deepStrictEqual(
    byKey.X1.constants.bands.map((b) => [b.fromR, b.retain]),
    [[0.50, 0.70], [0.75, 0.75], [1.00, 0.80], [1.50, 0.85], [2.00, 0.90]],
  );
  assert.deepStrictEqual(byKey.X1.constants.routeArmOverrides, {
    CONFIRMED_REVERSAL: 1.00, EARLY_TRANSITION: 0.75,
  });
  // X2 tiered retention (l.30-34)
  assert.deepStrictEqual(
    byKey.X2.constants.bands.map((b) => [b.fromR, b.retain]),
    [[0.0, 0.55], [0.5, 0.65], [0.75, 0.75], [1.0, 0.80]],
  );
  assert.deepStrictEqual(byKey.X2.constants.tpOverlayFraction, 0.91);
  // X3 recorded as evaluation-based divergence (l.48)
  assert.deepStrictEqual(byKey.X3.constants.continuationRecoveryGraceMinutes, 4.5);
  assert.strictEqual(byKey.X3.semantics, 'EVALUATION_BASED');
  // X4 drawdown guard constants (l.12-15)
  assert.deepStrictEqual(
    { ...byKey.X4.constants },
    { checkpointMinutes: 5, deadlineMinutes: 7, closeR: -0.4, intervalMs: 15000 },
  );
  // X5 unprotected band (l.144-156)
  assert.deepStrictEqual(
    { ...byKey.X5.constants },
    {
      bandFromR: 0.30, bandToR: 0.50, givebackFraction: 0.30,
      currentRBleedFloorR: -0.7, minObservations: 12, minElapsedMinutes: 2,
    },
  );
  // X6 fee floor (l.226-232)
  assert.deepStrictEqual(
    { ...byKey.X6.constants },
    { feeFloorRiskFraction: 0.1, feeFloorMinUsd: 1.0,
      refusalCode: 'FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE' },
  );
  assert.strictEqual(byKey.X6.semantics, 'EVALUATION_BASED');
});

test('X2 tiered retention mirror reproduces the frozen table', () => {
  assert.deepStrictEqual(emulateExitEngine('X2', { grossR: 0.1, peakR: 0.2 }).reason, 'LOCK_TRAIL');
  // peak 0.2 < 0.5 -> retain 0.55 -> lock 0.11; gross 0.1 <= 0.11 -> close
  const peakTable = [0.2, 0.6, 0.8, 1.3];
  const expected = [0.55, 0.65, 0.75, 0.80];
  for (let i = 0; i < peakTable.length; i += 1) {
    const d = emulateExitEngine('X2', { grossR: peakTable[i] * expected[i] + 0.5, peakR: peakTable[i] });
    assert.strictEqual(d.action, 'HOLD');
    assert.ok(Math.abs(d.lockR - peakTable[i] * expected[i]) < 1e-12);
  }
});

test('X1 standard ladder: peak 0.6R locks at 0.42R and closes when breached', () => {
  const hold = emulateExitEngine('X1', { grossR: 0.45, peakR: 0.6 });
  assert.strictEqual(hold.action, 'HOLD');
  assert.ok(Math.abs(hold.lockR - 0.6 * 0.70) < 1e-12);
  const close = emulateExitEngine('X1', { grossR: 0.40, peakR: 0.6 });
  assert.strictEqual(close.action, 'CLOSE');
  assert.strictEqual(close.reason, 'LOCK_TRAIL');
  assert.ok(Math.abs(close.lockR - 0.42) < 1e-12);
});

test('X1 route arming overrides: CONFIRMED_REVERSAL needs 1.00R peak', () => {
  const notArmed = emulateExitEngine('X1', {
    grossR: 0.5, peakR: 0.9, route: 'CONFIRMED_REVERSAL',
  });
  assert.strictEqual(notArmed.action, 'HOLD');
  assert.strictEqual(notArmed.lockR, null);
  const armed = emulateExitEngine('X1', {
    grossR: 1.0, peakR: 1.2, route: 'CONFIRMED_REVERSAL',
  });
  assert.strictEqual(armed.action, 'HOLD');
  assert.ok(Math.abs(armed.lockR - 1.2 * 0.80) < 1e-12);
});

test('X1 M1 rescue band: peak 0.45R retains 40%', () => {
  const close = emulateExitEngine('X1', { grossR: 0.17, peakR: 0.45 });
  assert.strictEqual(close.reason, 'RESCUE_LOCK');
  assert.ok(Math.abs(close.lockR - 0.45 * 0.40) < 1e-12);
});

test('X4 drawdown guard: closes at <= -0.4R only from the checkpoint minute', () => {
  const early = emulateExitEngine('X4', { grossR: -0.5, peakR: 0.1, elapsedMinutes: 3 });
  assert.strictEqual(early.action, 'HOLD');
  const active = emulateExitEngine('X4', { grossR: -0.5, peakR: 0.1, elapsedMinutes: 6 });
  assert.strictEqual(active.action, 'CLOSE');
  assert.strictEqual(active.reason, 'DRAWDOWN_GUARD');
});

test('X5 unprotected band rescue conditions are conjunctive', () => {
  const base = {
    grossR: -0.2, peakR: 0.4, givebackR: 0.5, observationCount: 20,
    elapsedMinutes: 5,
  };
  assert.strictEqual(emulateExitEngine('X5', base).reason, 'UNPROTECTED_BAND_RESCUE');
  assert.strictEqual(emulateExitEngine('X5', { ...base, peakR: 0.6 }).reason, 'HOLD');
  assert.strictEqual(emulateExitEngine('X5', { ...base, grossR: -0.8 }).reason, 'HOLD');
  assert.strictEqual(emulateExitEngine('X5', { ...base, givebackR: 0.2 }).reason, 'HOLD');
  assert.strictEqual(emulateExitEngine('X5', { ...base, observationCount: 5 }).reason, 'HOLD');
  assert.strictEqual(emulateExitEngine('X5', { ...base, elapsedMinutes: 1 }).reason, 'HOLD');
});

test('X3 and X6 are typed refusals, not silent defaults', () => {
  assert.throws(() => emulateExitEngine('X3', { grossR: 0.1, peakR: 0.5 }),
    /EI1_EMULATION_NOT_PARAMETERIZED: X3/);
  assert.throws(() => emulateExitEngine('X6', { grossR: 0.1, peakR: 0.5 }),
    /EI1_EMULATION_NOT_PARAMETERIZED: X6/);
});

test('malformed EI-1 ladders are typed refusals', () => {
  const good = {
    stopAtrMultiple: 1.1, minStopPips: 5, targetR: 1.6,
    armR: 0.5,
    bands: [{ fromR: 0.5, retain: 0.7 }],
    rescue: null, routeArmOverrides: null, tpOverlayFraction: null,
    drawdownGuard: null, unprotectedBand: null, timeStopBars: null,
  };
  assert.strictEqual(validateEI1Policy(good), true);
  assert.throws(() => validateEI1Policy({ ...good, bands: [{ fromR: 0.5, retain: 0.7 }, { fromR: 0.5, retain: 0.8 }] }),
    /EI1_BANDS_NOT_ASCENDING/);
  assert.throws(() => validateEI1Policy({ ...good, bands: [{ fromR: 0.5, retain: 1.2 }] }),
    /EI1_RETAIN_INVALID/);
  assert.throws(() => validateEI1Policy({ ...good, bands: [{ fromR: 0.6, retain: 0.7 }] }),
    /EI1_BANDS_MISALIGNED_WITH_ARM/);
  assert.throws(() => validateEI1Policy({ ...good, armR: 0.5, bands: [{ fromR: 0.5, retain: 0.7 }], rescue: { armR: 0.9, retain: 0.4 } }),
    /EI1_RESCUE_INVALID/);
  assert.throws(() => validateEI1Policy({ ...good, targetR: 0 }),
    /EI1_TARGET_INVALID/);
  assert.throws(() => validateEI1Policy({ ...good, drawdownGuard: { closeR: 0.4, checkpointMinutes: 5, deadlineMinutes: 7 } }),
    /EI1_DRAWDOWN_GUARD_INVALID/);
});

test('champion baseline is frozen geometry only (no ladder, hard target)', () => {
  const target = applyEI1Policy({ grossR: 1.6, peakR: 1.7 }, EI1_CHAMPION_BASELINE);
  assert.strictEqual(target.reason, 'TARGET');
  // A large peak never locks anything for the champion: no retention ladder.
  const hold = applyEI1Policy({ grossR: 0.9, peakR: 2.5 }, EI1_CHAMPION_BASELINE);
  assert.strictEqual(hold.action, 'HOLD');
  assert.strictEqual(hold.lockR, null);
  assert.strictEqual(EI1_CHAMPION_BASELINE.stopAtrMultiple, 1.1);
  assert.strictEqual(EI1_CHAMPION_BASELINE.minStopPips, 5);
  assert.strictEqual(EI1_CHAMPION_BASELINE.targetR, 1.6);
});

test('challenger preset validates and its time stop fires', () => {
  assert.strictEqual(validateEI1Policy(V2_CHALLENGER_EXIT_PRESET), true);
  const timeStop = applyEI1Policy(
    { grossR: 0.2, peakR: 0.3, barsHeld: V2_CHALLENGER_EXIT_PRESET.timeStopBars },
    V2_CHALLENGER_EXIT_PRESET,
  );
  assert.strictEqual(timeStop.reason, 'TIME_STOP');
  assert.strictEqual(timeStop.action, 'CLOSE');
});

test('exit reasons are closed and summary counts reconcile', () => {
  const summary = summarizeExitIntelligenceContract();
  assert.strictEqual(summary.engines, 6);
  assert.strictEqual(summary.parameterized, 4);
  assert.strictEqual(summary.evaluationBased, 2);
  assert.strictEqual(summary.noConstantsChanged, true);
  assert.ok(EXIT_REASONS.includes('LOCK_TRAIL'));
  assert.ok(EXIT_REASONS.includes('RESCUE_LOCK'));
  assert.ok(EXIT_REASONS.includes('DRAWDOWN_GUARD'));
  assert.ok(EXIT_REASONS.includes('UNPROTECTED_BAND_RESCUE'));
  assert.ok(EXIT_REASONS.includes('TIME_STOP'));
});
