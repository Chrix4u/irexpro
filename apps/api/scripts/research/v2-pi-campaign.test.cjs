'use strict';
/**
 * Tests for the PI evaluation campaign (PI-5): fastAuc equivalence with the
 * house Mann-Whitney implementation, campaign structure, determinism,
 * null false-positive control, planted-edge sensitivity reporting, and the
 * pre-registered broker-connected decision gate. Small CI-safe sizes; the
 * full-scale artifact is executed by the CLI runner and committed.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  fastAuc,
  layerA,
  runPiCampaign,
  brokerConnectedGate,
} = require('./v2-pi-campaign.cjs');
const { mannWhitneyAUC } = require('./v2-offline-evaluation-harness.cjs');

const TINY = {
  symbols: ['EURUSD', 'GBPUSD', 'USDJPY'],
  days: 8,
  nFolds: 3,
  stumpsSmall: 8,
  stumpsLarge: 12,
  plantedContinuationProb: 0.6,
  seedBases: {
    PI_NULL: 9100000, PI_PLANTED_CONTINUATION: 9200000, PI_TREND_REGIMES: 9300000,
  },
};

test('fastAuc matches the house Mann-Whitney AUC exactly (ties included)', () => {
  const items = [];
  const scores = [0.3, 0.3, 0.5, 0.7, 0.7, 0.9, 0.1, 0.2, 0.2, 0.8, 0.4, 0.6];
  const ys = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  scores.forEach((score, i) => items.push({ score, y: ys[i], outcome: ys[i] }));
  const mine = fastAuc(items);
  const house = mannWhitneyAUC(items);
  assert.ok(Math.abs(mine.auc - house) < 1e-12, `fast=${mine.auc} house=${house}`);
  assert.ok(Math.abs(mine.z) < 5);
  // Deterministic tie handling.
  assert.strictEqual(fastAuc(items).auc, fastAuc(items).auc);
  assert.throws(() => fastAuc([]), /PI_CAMPAIGN_ROWS_INVALID/);
});

test('campaign runs end-to-end on CI-safe sizes with full structure', () => {
  const result = runPiCampaign(TINY);
  for (const scenario of ['PI_NULL', 'PI_PLANTED_CONTINUATION', 'PI_TREND_REGIMES']) {
    const s = result.scenarios[scenario];
    assert.ok(s.dataset.rows > 100, `${scenario} rows=${s.dataset.rows}`);
    assert.ok(s.dataset.devRows > 0 && s.dataset.heldOutRows > 0);
    assert.strictEqual(s.fixture.provenance.includes('SYNTHETIC_FIXTURE'), true);
    for (const task of ['direction', 'trendContinuation', 'reversal', 'expectedReturn']) {
      assert.ok(s.tasks[task], `${scenario}/${task} missing`);
      assert.ok(s.tasks[task].devWalkForward['prior-baseline']
        || s.tasks[task].devWalkForward['prior-mean']);
      assert.ok(s.tasks[task].heldOutFinal['prior-baseline']
        || s.tasks[task].heldOutFinal['prior-mean']);
    }
    const prior = s.tasks.direction.devWalkForward['prior-baseline'].layerA;
    assert.ok(prior.auc.value !== null);
    assert.ok(prior.brier >= 0 && prior.brier <= 1);
  }
  // Regime task exists only on the regimes scenario.
  assert.ok(result.scenarios.PI_TREND_REGIMES.tasks.regime);
  assert.equal(result.scenarios.PI_NULL.tasks.regime, null);
  assert.ok(result.scenarios.PI_TREND_REGIMES.tasks.regime.devWalkForward.beatsMajority === true
    || result.scenarios.PI_TREND_REGIMES.tasks.regime.devWalkForward.beatsMajority === false);
});

test('campaign is deterministic: two runs produce identical JSON', () => {
  const a = runPiCampaign(TINY);
  const b = runPiCampaign(TINY);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('null false-positive control reports direction-only cells with family-wise verdict', () => {
  const result = runPiCampaign(TINY);
  const fp = result.nullFpControl;
  // Direction task only: 5 models x 3 symbols = 15 cells.
  assert.strictEqual(fp.cells, 15);
  assert.ok(fp.rate !== null && fp.rate >= 0 && fp.rate <= 1);
  assert.ok(['CONTROLLED', 'ELEVATED'].includes(fp.verdict));
  assert.strictEqual(fp.familyCorrection.includes('Bonferroni'), true);
  assert.ok(fp.zFamilyThreshold > 2.5);
  assert.ok(fp.note.includes('tautological'));
  assert.ok(Array.isArray(fp.significantCells));
});

test('planted-edge sensitivity: fixture rate near planted, direction-task detection recorded', () => {
  const result = runPiCampaign(TINY);
  const sens = result.plantedSensitivity;
  assert.strictEqual(sens.plantedContinuationProb, 0.6);
  assert.strictEqual(sens.detectionTask.includes('direction'), true);
  assert.ok(sens.fixtureContinuationRateAtTriggers !== null);
  assert.ok(Math.abs(sens.fixtureContinuationRateAtTriggers - 0.6) < 0.05,
    `fixture rate ${sens.fixtureContinuationRateAtTriggers}`);
  // Null direction AUC sits at chance; planted values are recorded per model.
  const logi = sens.perModel['logistic-l2'];
  const stumps = sens.perModel['stumps-12'];
  assert.ok(Math.abs(logi.nullDirAuc - 0.5) < 0.06, `null dir AUC ${logi.nullDirAuc}`);
  assert.ok(logi.plantedDirAuc !== null);
  assert.ok(stumps.plantedDirAuc !== null);
  assert.ok(sens.requiredNPerClass > 0);
  assert.ok(sens.sufficientPower === true || sens.sufficientPower === false);
  assert.ok(sens.interpretation.includes('NOT evidence of real-world'));
});

test('complexity-vs-value table covers scenarios, tasks, families, params', () => {
  const result = runPiCampaign(TINY);
  const rows = result.complexityVsValue;
  assert.ok(rows.length >= 40, `rows=${rows.length}`);
  const models = new Set(rows.map((r) => r.modelId));
  for (const expected of ['prior-baseline', 'logistic-l2', 'recency-logistic',
    'stumps-8', 'stumps-12', 'prior-mean', 'ridge', 'ar-5', 'stumps-reg-8']) {
    assert.ok(models.has(expected), `missing ${expected}`);
  }
  const families = new Set(rows.map((r) => r.family));
  for (const expected of ['classical', 'temporal', 'boosted']) {
    assert.ok(families.has(expected));
  }
  for (const row of rows) {
    assert.ok(row.paramCount >= 1);
    assert.ok(row.afterCostMeanRPerTrade === null
      || Number.isFinite(row.afterCostMeanRPerTrade));
    assert.ok(typeof row.gateEligible === 'boolean');
  }
  // Continuation/reversal rows carry the caveat; direction and
  // expectedReturn rows are gate-eligible.
  for (const row of rows.filter((r) => r.task === 'reversal')) {
    assert.ok(row.taskCaveat.includes('TAUTOLOGICAL'));
    assert.strictEqual(row.gateEligible, false);
  }
  for (const row of rows.filter((r) => r.task === 'direction' || r.task === 'expectedReturn')) {
    assert.strictEqual(row.gateEligible, true);
  }
  // Prior must be the smallest direction complexity in every scenario.
  for (const scenario of ['PI_NULL', 'PI_PLANTED_CONTINUATION', 'PI_TREND_REGIMES']) {
    const dir = rows.filter((r) => r.scenario === scenario && r.task === 'direction');
    const priorRow = dir.find((r) => r.modelId === 'prior-baseline');
    for (const r of dir) assert.ok(r.paramCount >= priorRow.paramCount);
  }
});

test('gate: NOT_RECOMMENDED, synthetic-only, anti-gate-substitution recorded', () => {
  const result = runPiCampaign(TINY);
  const gate = result.gate;
  assert.strictEqual(gate.recommendation, 'NOT_RECOMMENDED');
  assert.strictEqual(gate.syntheticOnly, true);
  assert.strictEqual(gate.conditions.length, 3);
  assert.ok(gate.reason.includes('operator-authorized'));
  assert.ok(gate.antiGateSubstitution.includes('FULL common grid'));
  assert.ok(gate.gateEligibleTasks.includes('direction'));
  assert.ok(gate.gateEligibleTasks.includes('expectedReturn'));
  assert.ok(gate.gateExclusionNote.includes('tautological'));
  assert.ok(gate.evaluated.length > 0);
  for (const e of gate.evaluated) {
    assert.ok(typeof e.c1AfterCostExpectancy === 'boolean');
    assert.ok(typeof e.pass === 'boolean');
  }
  // Layer semantics recorded for every artifact consumer.
  assert.ok(result.layerSemantics.layerA.includes('improvement claims'));
  assert.ok(result.layerSemantics.layerB.includes('identical standardized'));
  // Task caveats recorded on continuation and reversal blocks.
  assert.ok(result.scenarios.PI_NULL.tasks.trendContinuation.labelCaveat.includes('CAVEAT'));
  assert.ok(result.scenarios.PI_NULL.tasks.reversal.labelCaveat.includes('TAUTOLOGICAL'));
});

test('typed refusals on malformed campaign configuration', () => {
  assert.throws(() => runPiCampaign({ ...TINY, days: 1 }), /PI_CAMPAIGN_CONFIG_INVALID/);
  assert.throws(() => runPiCampaign({ ...TINY, symbols: [] }), /PI_CAMPAIGN_CONFIG_INVALID/);
});

test('layerA refuses degenerate class mixes instead of guessing', () => {
  const oneSided = [{ p: 0.6, y: 1 }, { p: 0.2, y: 1 }];
  const a = layerA(oneSided);
  assert.strictEqual(a.auc.value, null);
  assert.match(a.auc.refused, /PI_AUC_CLASS_EMPTY/);
});

test('gate function is pure and stable for a fixed table', () => {
  const table = [
    {
      scenario: 'PI_NULL', task: 'direction', modelId: 'logistic-l2', gateEligible: true,
      afterCostMeanRPerTrade: -0.1, afterCostCi95: [-0.2, -0.05],
      deltaVsPriorZ: 3.0,
    },
    {
      scenario: 'PI_PLANTED_CONTINUATION', task: 'direction', modelId: 'stumps-12', gateEligible: true,
      afterCostMeanRPerTrade: 0.05, afterCostCi95: [0.01, 0.09],
      deltaVsPriorZ: 4.0,
    },
  ];
  const gate = brokerConnectedGate(table);
  assert.strictEqual(gate.anyModelPasses, true); // C1+C2 on planted cell
  assert.strictEqual(gate.recommendation, 'NOT_RECOMMENDED'); // C3 blocks anyway
  assert.ok(gate.reason.includes('sensitivity-validation artifacts'));
  assert.strictEqual(brokerConnectedGate(table).evaluated.length, 2);
});
