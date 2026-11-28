'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  ENGINE_COMPONENT_MAP_PHASE2,
  PHASE2_CLAIMED_COUNTS,
  DECLARED_TRAINING_INVENTORY,
  RUNONCE_MIN_SPAN_LINES,
  ENGINE_CLIENT_BASE_URL_DEFAULT,
  ENGINE_CLIENT_ENDPOINTS,
  EVIDENCE_TABLES,
  validatePhase2ComponentMap,
  verifyPhase2ComponentPaths,
  verifyPythonTrainingInventory,
  computeRunOnceSpan,
  verifyOrchestrationAnchors,
  verifyEngineClientEdge,
  verifyEvidenceEdge,
  summarizePhase2Map,
} = require('./v2-engine-component-map-phase2.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const clone = (map) => JSON.parse(JSON.stringify(map));

test('the committed phase-2 inventory validates and reconciles with the declared family counts', () => {
  assert.equal(validatePhase2ComponentMap(ENGINE_COMPONENT_MAP_PHASE2), true);
  const summary = summarizePhase2Map(ENGINE_COMPONENT_MAP_PHASE2);
  assert.equal(summary.artifact, 'v2-engine-component-map-phase2-v1');
  assert.equal(summary.totalComponents, 47);
  for (const [family, claimed] of Object.entries(PHASE2_CLAIMED_COUNTS)) {
    assert.equal(summary.byFamily[family], claimed, `${family} must map ${claimed} components`);
    const row = summary.reconciliation.find((r) => r.family === family);
    assert.equal(row.reconciled, true, `${family} must reconcile`);
  }
});

test('every mapped phase-2 path exists on the branch tree (drift detector)', () => {
  const result = verifyPhase2ComponentPaths(REPO_ROOT);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('the Python training-domain inventory reconciles with the directory', () => {
  const result = verifyPythonTrainingInventory(REPO_ROOT);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(DECLARED_TRAINING_INVENTORY.pyTotal, 73);
  assert.equal(DECLARED_TRAINING_INVENTORY.testSuites, 6);
  assert.equal(DECLARED_TRAINING_INVENTORY.readonlySql, 7);
  assert.equal(DECLARED_TRAINING_INVENTORY.nonTestPy, 67);
});

test('the orchestration runOnce span stays a single method of at least 3000 lines', () => {
  const result = verifyOrchestrationAnchors(REPO_ROOT);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(RUNONCE_MIN_SPAN_LINES, 3000);
});

test('computeRunOnceSpan refuses a shrunken or refactored scheduler as a typed regression', () => {
  const tiny = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    + '\nexport class M1TacticalSchedulerService {}\nasync runOnce(now) {}\n'
    + Array.from({ length: 20 }, (_, i) => `pad ${i}`).join('\n')
    + '\nasync observeOpenPositionRescueShadow() {}\n';
  const span = computeRunOnceSpan(tiny);
  assert.ok(span.span < 3000, 'synthetic tiny scheduler must produce a small span');
});

test('the TS->Python engine-client edge is pinned by content anchors (E1)', () => {
  const result = verifyEngineClientEdge(REPO_ROOT);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(ENGINE_CLIENT_ENDPOINTS.length, 5);
  assert.equal(ENGINE_CLIENT_BASE_URL_DEFAULT, 'http://localhost:8001/api/v1');
});

test('the evidence persistence edge is pinned by SQL table anchors (E2)', () => {
  const result = verifyEvidenceEdge(REPO_ROOT);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([...EVIDENCE_TABLES].sort(), [
    'trading.capital_allocations',
    'trading.m1_tactical_decisions',
    'trading.trades',
    'trading.trading_sessions',
  ]);
});

test('an unknown family is a typed refusal (inventory tampering)', () => {
  const map = clone(ENGINE_COMPONENT_MAP_PHASE2);
  map.components[0].family = 'not-a-family';
  assert.equal(validatePhase2ComponentMap(map), false);
});

test('an unknown layer is a typed refusal (inventory tampering)', () => {
  const map = clone(ENGINE_COMPONENT_MAP_PHASE2);
  map.components[0].layer = 'not-a-layer';
  assert.equal(validatePhase2ComponentMap(map), false);
});

test('a duplicate key is a typed refusal (inventory tampering)', () => {
  const map = clone(ENGINE_COMPONENT_MAP_PHASE2);
  map.components[1].key = map.components[0].key;
  assert.equal(validatePhase2ComponentMap(map), false);
});

test('a missing path field is a typed refusal (inventory tampering)', () => {
  const map = clone(ENGINE_COMPONENT_MAP_PHASE2);
  delete map.components[2].path;
  assert.equal(validatePhase2ComponentMap(map), false);
});

test('malformed constants are typed refusals', () => {
  const map = clone(ENGINE_COMPONENT_MAP_PHASE2);
  map.components[0].constants = [{ value: 10 }];
  assert.equal(validatePhase2ComponentMap(map), false);
  const map2 = clone(ENGINE_COMPONENT_MAP_PHASE2);
  map2.components[0].constants = [{ kind: 'fileLines', value: 'many' }];
  assert.equal(validatePhase2ComponentMap(map2), false);
});

test('a nonexistent mapped path is a typed refusal from the drift detector', () => {
  const map = clone(ENGINE_COMPONENT_MAP_PHASE2);
  map.components[3].path = 'services/ai-engine/app/domain/models/does_not_exist.py';
  const result = verifyPhase2ComponentPaths(REPO_ROOT, map);
  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, 'PHASE2_COMPONENT_PATH_MISSING');
  assert.match(result.refusal.detail, /does_not_exist\.py$/);
});

test('removing an orchestration component breaks the family reconciliation', () => {
  const map = clone(ENGINE_COMPONENT_MAP_PHASE2);
  map.components = map.components.filter((e) => e.key !== 'ts-orch-m1-tactical-scheduler');
  const summary = summarizePhase2Map(map);
  const row = summary.reconciliation.find((r) => r.family === 'orchestration');
  assert.equal(row.reconciled, false);
  assert.equal(row.mapped, 4);
  assert.equal(row.claimed, 5);
});
