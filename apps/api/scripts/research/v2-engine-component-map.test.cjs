'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  ENGINE_COMPONENT_MAP,
  AUDIT_CLAIMED_COUNTS,
  validateEngineComponentMap,
  verifyComponentPaths,
  summarizeEngineComponentMap,
} = require('./v2-engine-component-map.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const clone = (map) => JSON.parse(JSON.stringify(map));
const entry = (key) => clone(ENGINE_COMPONENT_MAP).components.find((e) => e.key === key);

test('the committed inventory validates and reconciles with the audit claims', () => {
  assert.equal(validateEngineComponentMap(ENGINE_COMPONENT_MAP), true);
  const summary = summarizeEngineComponentMap(ENGINE_COMPONENT_MAP);
  assert.equal(summary.artifact, 'v2-engine-component-map-v1');
  assert.equal(summary.totalComponents, 64);
  assert.equal(summary.byFamily['direction-scorer'], 4);
  assert.equal(summary.byFamily['reversal-definition'], 6);
  assert.equal(summary.byFamily['reliability-gate'], 9);
  assert.equal(summary.byFamily['calibration-layer'], 6);
  assert.equal(summary.byFamily['exit-engine'], 6);
  assert.equal(summary.byFamily['prediction-family'], 5);
  assert.equal(summary.byFamily['confidence-floor'], 6);
  for (const row of summary.auditClaimComparison) {
    assert.equal(row.reconciled, true, `${row.family} must reconcile`);
  }
});

test('every mapped source path exists in the repository (drift detector)', () => {
  const result = verifyComponentPaths(ENGINE_COMPONENT_MAP, REPO_ROOT);
  assert.equal(result.verified, result.total);
  assert.equal(result.total, 64);
});

test('representative pinned constants match the engine sources', () => {
  const m1 = entry('scorer.m1-tactical');
  assert.deepEqual(
    m1.constants.filter((k) => k.name === 'stopAtrMultiplier' || k.name === 'targetR'
      || k.name === 'maxConfidence'),
    [
      { name: 'stopAtrMultiplier', value: 1.1, line: 24 },
      { name: 'targetR', value: 1.6, line: 25 },
      { name: 'maxConfidence', value: 0.738, line: 27 },
    ],
  );
  const v8 = entry('scorer.v8-shadow-meta');
  assert.deepEqual(
    v8.constants.filter((k) => k.name === 'V8_SHADOW_ADMISSION_THRESHOLD'
      || k.name === 'BASE_WEIGHTS.entryCount'),
    [
      { name: 'V8_SHADOW_ADMISSION_THRESHOLD', value: 0.46, line: 3 },
      { name: 'BASE_WEIGHTS.entryCount', value: 29, line: 51 },
    ],
  );
  const paired = entry('reversal.paired-direction');
  assert.deepEqual(
    paired.constants.filter((k) => k.name === 'PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY'),
    [{ name: 'PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY', value: 0.64, line: 3 }],
  );
  const guard = entry('exit.v89-demo-drawdown-guard');
  assert.deepEqual(
    guard.constants.filter((k) => k.name === 'PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R'
      || k.name === 'PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES'),
    [
      { name: 'PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES', value: 7, line: 13 },
      { name: 'PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R', value: -0.4, line: 14 },
    ],
  );
  const pulse = entry('calibration.adaptive-shadow-directional-pulse');
  assert.deepEqual(
    pulse.constants.filter((k) => k.name === 'ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_DECAY'),
    [{ name: 'ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_DECAY', value: 0.65, line: 4 }],
  );
  const floor = entry('confidence-floor.py.model-qualification');
  assert.deepEqual(
    floor.constants,
    [{ name: 'CONFIDENCE_FLOOR', value: 0.6, line: 49 }],
  );
  const governance = entry('governance.ensemble-governance');
  assert.deepEqual(
    governance.constants.filter((k) => k.name === 'driftEnvelope.hardLow'
      || k.name === 'driftEnvelope.hardHigh'),
    [
      { name: 'driftEnvelope.hardLow', value: 0.640079, line: 133 },
      { name: 'driftEnvelope.hardHigh', value: 0.751451, line: 134 },
    ],
  );
});

test('the inventory is deep-frozen: mutation attempts throw', () => {
  assert.throws(() => { ENGINE_COMPONENT_MAP.components[0].key = 'tampered'; }, TypeError);
  assert.throws(() => { ENGINE_COMPONENT_MAP.meta.executionAuthority = 'FULL'; }, TypeError);
});

test('duplicate component keys are a typed refusal', () => {
  const map = clone(ENGINE_COMPONENT_MAP);
  map.components.push(clone(map.components[0]));
  assert.throws(() => validateEngineComponentMap(map), /MAP_DUPLICATE_KEY/);
});

test('unknown layer and unknown family are typed refusals', () => {
  const badLayer = clone(ENGINE_COMPONENT_MAP);
  badLayer.components[0].layer = 'L9-fantasy';
  assert.throws(() => validateEngineComponentMap(badLayer), /MAP_UNKNOWN_LAYER/);
  const badFamily = clone(ENGINE_COMPONENT_MAP);
  badFamily.components[0].family = 'unicorn';
  assert.throws(() => validateEngineComponentMap(badFamily), /MAP_UNKNOWN_FAMILY/);
});

test('missing required fields are typed refusals', () => {
  const noPath = clone(ENGINE_COMPONENT_MAP);
  delete noPath.components[0].path;
  assert.throws(() => validateEngineComponentMap(noPath), /MAP_MISSING_FIELD/);
  const noNotes = clone(ENGINE_COMPONENT_MAP);
  delete noNotes.components[1].notes;
  assert.throws(() => validateEngineComponentMap(noNotes), /MAP_MISSING_FIELD/);
  const noMeta = clone(ENGINE_COMPONENT_MAP);
  delete noMeta.meta.executionAuthority;
  assert.throws(() => validateEngineComponentMap(noMeta), /MAP_META_INCOMPLETE/);
});

test('malformed constants are typed refusals', () => {
  const map = clone(ENGINE_COMPONENT_MAP);
  map.components[0].constants[0].line = 0;
  assert.throws(() => validateEngineComponentMap(map), /MAP_CONSTANT_MALFORMED/);
  const map2 = clone(ENGINE_COMPONENT_MAP);
  map2.components[0].constants[0] = { name: '', value: 1, line: 5 };
  assert.throws(() => validateEngineComponentMap(map2), /MAP_CONSTANT_MALFORMED/);
});

test('removing a scorer or a gate breaks the audit count reconciliation', () => {
  const fewerScorers = clone(ENGINE_COMPONENT_MAP);
  fewerScorers.components = fewerScorers.components.filter((e) => e.family !== 'direction-scorer');
  fewerScorers.components.push(entry('scorer.m1-tactical'), entry('scorer.plan-b-multimodel-shadow'), entry('scorer.v8-shadow-meta'));
  assert.throws(() => validateEngineComponentMap(fewerScorers), /MAP_COUNT_MISMATCH/);
  const fewerGates = clone(ENGINE_COMPONENT_MAP);
  fewerGates.components = fewerGates.components.filter((e) => e.key !== 'reliability.paper-route');
  assert.throws(() => validateEngineComponentMap(fewerGates), /MAP_COUNT_MISMATCH/);
});

test('a nonexistent mapped path is a typed refusal from the drift detector', () => {
  const map = clone(ENGINE_COMPONENT_MAP);
  map.components[0].path = 'apps/api/src/modules/ai/does-not-exist.ts';
  assert.throws(() => verifyComponentPaths(map, REPO_ROOT), /MAP_PATH_NOT_FOUND/);
  assert.throws(() => verifyComponentPaths(null, REPO_ROOT), /MAP_INPUT_REQUIRED/);
});

test('the declared inventory counts are self-consistent with the components', () => {
  const summary = summarizeEngineComponentMap(ENGINE_COMPONENT_MAP);
  const declared = ENGINE_COMPONENT_MAP.inventoryCounts;
  for (const [family, count] of Object.entries(declared)) {
    assert.equal(summary.byFamily[family], count, `${family} count mismatch`);
  }
  assert.equal(Object.keys(declared).length,
    Object.keys(summary.byFamily).length, 'every family must be declared');
  assert.equal(ENGINE_COMPONENT_MAP.auditClaims, AUDIT_CLAIMED_COUNTS);
});
