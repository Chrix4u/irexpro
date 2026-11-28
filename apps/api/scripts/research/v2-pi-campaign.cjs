'use strict';
/**
 * V2 predictive-intelligence evaluation campaign (PI-5, directive
 * 2026-11-28). Runs the candidate model classes of PI-4 on the common
 * prediction-opportunity datasets of PI-3, built from the synthetic
 * fixtures of PI-2:
 *
 *   Layer A (prediction quality)  — AUC / Brier / accuracy / IC on the
 *     FULL common grid (every opportunity, including rejected ones;
 *     100% coverage by construction). Identical outcome definitions for
 *     every candidate. This is the only layer in which improvement
 *     claims may be made — additional confidence gates or reduced
 *     trading frequency are NOT a substitute for improved intelligence.
 *   Layer B (policy/economics)     — ONE identical standardized
 *     fixed-horizon policy for every candidate (exit at the label
 *     horizon; constant sizing; train-only breakeven thresholds):
 *     differences are attributable to direction-prediction quality only,
 *     never to exit-policy tuning.
 *
 * Campaign blocks: null false-positive control (per task x model x symbol
 * cells), planted-edge detection sensitivity (with required-N checks),
 * complexity-vs-out-of-sample-value table, chronological walk-forward
 * evaluation, held-out final report (nothing tuned on held-out data), and
 * the pre-registered broker-connected decision gate. Deterministic: a pure
 * function of the config. Research-only; never order authority.
 */

const { generatePiFixture, measureContinuationRate } = require('./v2-pi-market-fixtures.cjs');
const {
  buildPredictionOpportunities,
  buildChronologicalSplits,
  reserveHeldOut,
  fitScaler,
  applyScaler,
} = require('./v2-prediction-dataset.cjs');
const {
  createPriorDirectionModel,
  createPriorRegressionModel,
  createLogisticL2,
  createRecencyWeightedLogistic,
  createRidgeRegression,
  createARp,
  createBoostedStumps,
  createBoostedStumpsRegression,
  createRegimeClassifier,
} = require('./v2-pi-models.cjs');
const {
  aucStandardError,
  requiredNPerClassForAucDetection,
} = require('./v2-statistical-evaluation.cjs');
const { normalQuantile } = require('./v2-offline-evaluation-harness.cjs');

const Z95_ONE_SIDED = 1.644854; // one-sided alpha = 0.05
const Z95 = 1.959964;
const CAMPAIGN_REFUSALS = Object.freeze([
  'PI_CAMPAIGN_CONFIG_INVALID', 'PI_CAMPAIGN_ROWS_INVALID',
]);

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** O(n log n) rank-based AUC (ties share average rank). Deterministic. */
function fastAuc(items) {
  if (!Array.isArray(items) || items.length < 2) {
    throw new Error('PI_CAMPAIGN_ROWS_INVALID');
  }
  const sorted = [...items].sort((a, b) => a.score - b.score);
  let rankSumPos = 0;
  let n1 = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j += 1;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      if (sorted[k].y === 1) {
        rankSumPos += avgRank;
        n1 += 1;
      }
    }
    i = j + 1;
  }
  const n0 = sorted.length - n1;
  if (n1 === 0 || n0 === 0) {
    return Object.freeze({ auc: null, n1, n0, refused: 'PI_AUC_CLASS_EMPTY' });
  }
  const auc = (rankSumPos - (n1 * (n1 + 1)) / 2) / (n1 * n0);
  const se = aucStandardError(auc, n1, n0);
  return Object.freeze({ auc, se, z: (auc - 0.5) / se, n: sorted.length, n1, n0 });
}

function tInterval95(values) {
  const n = values.length;
  if (n < 30) {
    return Object.freeze({ n, mean: mean(values), ci95: null, refused: 'PI_INSUFFICIENT_TRADES' });
  }
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return Object.freeze({ n, mean: m, ci95: Object.freeze([m - Z95 * se, m + Z95 * se]) });
}

// ---------------------------------------------------------------------------
// Layer A / Layer B
// ---------------------------------------------------------------------------

function layerA(pooled) {
  const aucBlock = fastAuc(pooled.map((r) => ({ score: r.p, y: r.y })));
  const brier = mean(pooled.map((r) => (r.p - r.y) ** 2));
  let correct = 0;
  for (const r of pooled) if ((r.p > 0.5 ? 1 : 0) === r.y) correct += 1;
  return Object.freeze({
    n: pooled.length,
    coverageOfGrid: 1,
    coverageNote: 'Layer A covers the FULL common grid including rejected '
      + 'opportunities; abstention cannot shrink this denominator.',
    auc: aucBlock.auc === null
      ? Object.freeze({ value: null, refused: 'PI_AUC_CLASS_EMPTY' })
      : Object.freeze({
        value: aucBlock.auc, se: aucBlock.se, z: aucBlock.z,
        n1: aucBlock.n1, n0: aucBlock.n0,
      }),
    brier,
    accuracy: correct / pooled.length,
  });
}

const POLICY_NOTE = Object.freeze({
  policy: 'STANDARDIZED_FIXED_HORIZON',
  policyNote: 'One identical policy for every candidate: entry when the '
    + 'train-derived breakeven threshold is crossed, exit at the label '
    + 'horizon, constant sizing, per-symbol train-derived thresholds. '
    + 'Differences reflect direction-prediction quality only, not '
    + 'exit-policy tuning.',
});

function tradesStats(tradeRs) {
  const stats = tInterval95(tradeRs);
  let wins = 0;
  for (const v of tradeRs) if (v > 0) wins += 1;
  return Object.freeze({
    ...POLICY_NOTE,
    nTrades: tradeRs.length,
    coverageOfGrid: null,
    meanRPerTrade: stats.mean,
    ci95: stats.ci95,
    totalR: tradeRs.reduce((s, v) => s + v, 0),
    winRate: tradeRs.length > 0 ? wins / tradeRs.length : null,
    refusal: stats.refused || null,
  });
}

/**
 * Layer B for direction models. tau comes from TRAINING rows only
 * (per symbol): tau = 0.5 + cost / (2 * E|fwdR|).
 */
function layerB(rows, thresholdsBySymbol) {
  const tradeRs = [];
  for (const r of rows) {
    const tau = thresholdsBySymbol.get(r.symbol);
    if (tau === undefined || r.p === null) continue;
    if (r.p > tau) tradeRs.push(r.fwdR - r.costR);
    else if (r.p < 1 - tau) tradeRs.push(-r.fwdR - r.costR);
  }
  return Object.freeze({ tradeRs: Object.freeze(tradeRs), stats: tradesStats(tradeRs) });
}

function breakevenThresholds(trainRows) {
  const bySymbol = new Map();
  for (const row of trainRows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }
  const out = new Map();
  for (const [symbol, rows] of bySymbol) {
    const m = mean(rows.map((r) => Math.abs(r.labels.fwdR)));
    const c = mean(rows.map((r) => r.labels.costR));
    if (m > 0) out.set(symbol, Math.min(0.95, 0.5 + c / (2 * m)));
  }
  return out;
}

function regressionThresholds(trainRows) {
  const bySymbol = new Map();
  for (const row of trainRows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row.labels.costR);
  }
  const out = new Map();
  for (const [symbol, costs] of bySymbol) out.set(symbol, mean(costs));
  return out;
}

function layerBRegression(rows, thresholdsBySymbol) {
  const tradeRs = [];
  for (const r of rows) {
    const c = thresholdsBySymbol.get(r.symbol);
    if (c === undefined || r.v === null) continue;
    if (r.v > c) tradeRs.push(r.fwdR - r.costR);
    else if (r.v < -c) tradeRs.push(-r.fwdR - r.costR);
  }
  return Object.freeze({ tradeRs: Object.freeze(tradeRs), stats: tradesStats(tradeRs) });
}

function regressionLayerA(rows) {
  const valid = rows.filter((r) => r.v !== null && Number.isFinite(r.v));
  if (valid.length < 10) {
    return Object.freeze({
      n: rows.length, nValid: valid.length, ic: null, icZ: null, rmse: null,
      refused: 'PI_REGRESSION_INSUFFICIENT_ROWS',
    });
  }
  const vs = valid.map((r) => r.v);
  const ys = valid.map((r) => r.fwdR);
  const mv = mean(vs);
  const my = mean(ys);
  let cov = 0;
  let sv = 0;
  let sy = 0;
  for (let i = 0; i < valid.length; i += 1) {
    cov += (vs[i] - mv) * (ys[i] - my);
    sv += (vs[i] - mv) ** 2;
    sy += (ys[i] - my) ** 2;
  }
  const ic = sv > 0 && sy > 0 ? cov / Math.sqrt(sv * sy) : 0;
  const icSe = 1 / Math.sqrt(valid.length - 3);
  return Object.freeze({
    n: rows.length,
    nValid: valid.length,
    ic,
    icSe,
    icZ: ic / icSe,
    rmse: Math.sqrt(mean(valid.map((r) => (r.v - r.fwdR) ** 2))),
  });
}

// ---------------------------------------------------------------------------
// Model specs
// ---------------------------------------------------------------------------

function directionModelSpecs(cfg) {
  return Object.freeze([
    Object.freeze({ id: 'prior-baseline', family: 'classical', paramCount: 1, create: () => createPriorDirectionModel() }),
    Object.freeze({ id: 'logistic-l2', family: 'classical', paramCount: 13, create: () => createLogisticL2({ iterations: 250 }) }),
    Object.freeze({
      id: 'recency-logistic', family: 'temporal', paramCount: 13,
      create: () => createRecencyWeightedLogistic({ decay: 0.999, iterations: 250 }),
    }),
    Object.freeze({
      id: `stumps-${cfg.stumpsSmall}`, family: 'boosted', paramCount: cfg.stumpsSmall * 3,
      create: () => createBoostedStumps({ rounds: cfg.stumpsSmall }),
    }),
    Object.freeze({
      id: `stumps-${cfg.stumpsLarge}`, family: 'boosted', paramCount: cfg.stumpsLarge * 3,
      create: () => createBoostedStumps({ rounds: cfg.stumpsLarge }),
    }),
  ]);
}

function regressionModelSpecs(cfg) {
  return Object.freeze([
    Object.freeze({ id: 'prior-mean', family: 'classical', paramCount: 1, create: () => createPriorRegressionModel() }),
    Object.freeze({ id: 'ridge', family: 'classical', paramCount: 13, create: () => createRidgeRegression({ lambda: 1.0 }) }),
    Object.freeze({ id: 'ar-5', family: 'temporal', paramCount: 6, create: () => createARp({ p: 5 }) }),
    Object.freeze({
      id: `stumps-reg-${cfg.stumpsSmall}`, family: 'boosted', paramCount: cfg.stumpsSmall * 3,
      create: () => createBoostedStumpsRegression({ rounds: cfg.stumpsSmall }),
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Direction-task evaluation (walk-forward on dev + held-out final)
// ---------------------------------------------------------------------------

function evaluateDirectionTask(devRows, { labelKey, specs, nFolds }) {
  const splits = buildChronologicalSplits({ rows: devRows }, { nFolds });
  if (splits.folds.length === 0) {
    throw new Error('PI_CAMPAIGN_ROWS_INVALID');
  }
  const pooled = new Map(specs.map((s) => [s.id, []]));
  const pooledTrades = new Map(specs.map((s) => [s.id, []]));
  const perFold = [];
  for (const fold of splits.folds) {
    const scaler = fitScaler(fold.train);
    const thresholds = breakevenThresholds(fold.train);
    const foldBlock = {
      fold: fold.fold, trainRows: fold.train.length, testRows: fold.test.length,
      gapBars: fold.gapBars, models: {},
    };
    for (const spec of specs) {
      const model = spec.create();
      model.fit(fold.train, { labelKey, scaler });
      const rows = fold.test.map((row) => {
        const s = applyScaler(scaler, row.features);
        return {
          p: model.predict(s).p, y: row.labels[labelKey],
          fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol,
        };
      });
      const lb = layerB(rows, thresholds);
      pooled.get(spec.id).push(...rows);
      pooledTrades.get(spec.id).push(...lb.tradeRs);
      foldBlock.models[spec.id] = Object.freeze({
        layerA: layerA(rows),
        layerB: lb.stats,
      });
    }
    perFold.push(Object.freeze(foldBlock));
  }
  return Object.freeze({ pooled, pooledTrades, perFold: Object.freeze(perFold) });
}

function summarizeDirectionTask(evaluation, specs) {
  const { pooled, pooledTrades } = evaluation;
  const out = {};
  for (const spec of specs) {
    out[spec.id] = Object.freeze({
      layerA: layerA(pooled.get(spec.id)),
      layerB: tradesStats(pooledTrades.get(spec.id)),
    });
  }
  return Object.freeze(out);
}

function evaluateHeldOutDirection(devRows, heldOutRows, { labelKey, specs }) {
  const scaler = fitScaler(devRows);
  const thresholds = breakevenThresholds(devRows);
  const out = {};
  for (const spec of specs) {
    const model = spec.create();
    model.fit(devRows, { labelKey, scaler });
    const rows = heldOutRows.map((row) => {
      const s = applyScaler(scaler, row.features);
      return {
        p: model.predict(s).p, y: row.labels[labelKey],
        fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol,
      };
    });
    out[spec.id] = Object.freeze({
      layerA: layerA(rows),
      layerB: layerB(rows, thresholds).stats,
    });
  }
  return Object.freeze(out);
}

/** Per-symbol Layer A audit cells (null FP control uses these). */
function perSymbolAucAudit(pooled, specs) {
  const cells = [];
  const symbols = [...new Set(pooled.get(specs[0].id).map((r) => r.symbol))];
  for (const spec of specs) {
    for (const symbol of symbols) {
      const rows = pooled.get(spec.id).filter((r) => r.symbol === symbol);
      const a = layerA(rows);
      cells.push(Object.freeze({
        modelId: spec.id, symbol, n: rows.length,
        auc: a.auc.value, z: a.auc.value !== null ? a.auc.z : null,
      }));
    }
  }
  return Object.freeze(cells);
}

// ---------------------------------------------------------------------------
// Regression-task evaluation
// ---------------------------------------------------------------------------

/** Lag map for AR rows: previous realized outcomes per symbol (no peek). */
function buildLagMap(chronologicalRows, p) {
  const seen = new Map();
  const lagMap = new Map();
  for (const row of chronologicalRows) {
    const arr = seen.get(row.symbol);
    lagMap.set(row, arr ? [...arr].slice(-p) : null);
    if (!arr) {
      seen.set(row.symbol, []);
    }
    const history = seen.get(row.symbol);
    history.push(row.labels.fwdR);
    if (history.length > p) history.shift();
  }
  return lagMap;
}

function evaluateRegressionTask(devRows, heldOutRows, { specs, nFolds }) {
  const splits = buildChronologicalSplits({ rows: devRows }, { nFolds });
  const pooled = new Map(specs.map((s) => [s.id, []]));
  const pooledTrades = new Map(specs.map((s) => [s.id, []]));
  const perFold = [];
  for (const fold of splits.folds) {
    const scaler = fitScaler(fold.train);
    const thresholds = regressionThresholds(fold.train);
    const lagMap = buildLagMap([...fold.train, ...fold.test], 5);
    const foldBlock = { fold: fold.fold, models: {} };
    for (const spec of specs) {
      const model = spec.create();
      if (spec.id === 'ar-5') {
        model.fit(fold.train, { labelKey: 'fwdR' });
      } else {
        model.fit(fold.train, { labelKey: 'fwdR', scaler });
      }
      const rows = fold.test.map((row) => {
        if (spec.id === 'ar-5') {
          const lags = (lagMap.get(row) || []).slice(-5);
          if (lags.length < 5) {
            return { v: null, fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol };
          }
          return {
            v: model.predictFeatures(lags).value,
            fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol,
          };
        }
        const s = applyScaler(scaler, row.features);
        return {
          v: model.predict(s).value,
          fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol,
        };
      });
      const lb = layerBRegression(rows, thresholds);
      pooled.get(spec.id).push(...rows);
      pooledTrades.get(spec.id).push(...lb.tradeRs);
      foldBlock.models[spec.id] = Object.freeze({
        layerA: regressionLayerA(rows),
        layerB: lb.stats,
      });
    }
    perFold.push(Object.freeze(foldBlock));
  }
  // Held-out final: fit once on all dev rows, evaluate once.
  const scaler = fitScaler(devRows);
  const thresholds = regressionThresholds(devRows);
  const lagMap = buildLagMap([...devRows, ...heldOutRows], 5);
  const heldOutEval = {};
  for (const spec of specs) {
    const model = spec.create();
    if (spec.id === 'ar-5') {
      model.fit(devRows, { labelKey: 'fwdR' });
    } else {
      model.fit(devRows, { labelKey: 'fwdR', scaler });
    }
    const rows = heldOutRows.map((row) => {
      if (spec.id === 'ar-5') {
        const lags = (lagMap.get(row) || []).slice(-5);
        if (lags.length < 5) {
          return { v: null, fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol };
        }
        return {
          v: model.predictFeatures(lags).value,
          fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol,
        };
      }
      const s = applyScaler(scaler, row.features);
      return {
        v: model.predict(s).value,
        fwdR: row.labels.fwdR, costR: row.labels.costR, symbol: row.symbol,
      };
    });
    heldOutEval[spec.id] = Object.freeze({
      layerA: regressionLayerA(rows),
      layerB: layerBRegression(rows, thresholds).stats,
    });
  }
  return Object.freeze({
    pooled, pooledTrades, perFold: Object.freeze(perFold),
    heldOutEval: Object.freeze(heldOutEval),
  });
}

// ---------------------------------------------------------------------------
// Regime-task evaluation
// ---------------------------------------------------------------------------

function evaluateRegimeTask(rows) {
  const clf = createRegimeClassifier();
  const counts = {};
  let correct = 0;
  const confusion = {};
  for (const row of rows) {
    const truth = row.regime;
    const pred = clf.classify(row.features);
    counts[truth] = (counts[truth] || 0) + 1;
    confusion[truth] = confusion[truth] || {};
    confusion[truth][pred] = (confusion[truth][pred] || 0) + 1;
    if (pred === truth) correct += 1;
  }
  const majority = Math.max(...Object.values(counts)) / rows.length;
  return Object.freeze({
    n: rows.length,
    accuracy: correct / rows.length,
    majorityBaseline: majority,
    counts: Object.freeze(counts),
    confusion: Object.freeze(confusion),
    beatsMajority: correct / rows.length > majority,
  });
}

// ---------------------------------------------------------------------------
// Campaign assembly
// ---------------------------------------------------------------------------

function defaultConfig(config) {
  const merged = {
    symbols: config.symbols ?? ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'],
    days: config.days ?? 50,
    nFolds: config.nFolds ?? 6,
    stumpsSmall: config.stumpsSmall ?? 25,
    stumpsLarge: config.stumpsLarge ?? 100,
    heldOutFraction: config.heldOutFraction ?? 0.2,
    plantedContinuationProb: config.plantedContinuationProb ?? 0.56,
    seedBases: config.seedBases ?? {
      PI_NULL: 8100000, PI_PLANTED_CONTINUATION: 8200000, PI_TREND_REGIMES: 8300000,
    },
  };
  if (!(Number.isInteger(merged.days) && merged.days >= 3)) {
    throw new Error('PI_CAMPAIGN_CONFIG_INVALID');
  }
  if (!(merged.symbols.length >= 1)) {
    throw new Error('PI_CAMPAIGN_CONFIG_INVALID');
  }
  return merged;
}

function runScenarioTasks(scenario, cfg, devRows, heldOutRows) {
  const dirSpecs = directionModelSpecs(cfg);
  const regSpecs = regressionModelSpecs(cfg);
  const blocks = {};
  const taskCaveats = Object.freeze({
    direction: 'Label is a pure forward outcome (forward return > 0): valid '
      + 'for null control, sensitivity and gate claims.',
    cont: 'CAVEAT: the continuation label embeds the past return sign; '
      + 'Layer-A AUC is partially feature-determined and is reported for '
      + 'methodology completeness only — excluded from gate claims.',
    rev: 'CAVEAT: the reversal label embeds the |past| > 0.5*sigma_W '
      + 'feature threshold; Layer-A AUC is partially TAUTOLOGICAL and is '
      + 'reported for completeness only — excluded from null control and '
      + 'gate claims.',
  });
  for (const labelKey of ['up', 'cont', 'rev']) {
    const evaluation = evaluateDirectionTask(devRows, { labelKey, specs: dirSpecs, nFolds: cfg.nFolds });
    blocks[labelKey] = Object.freeze({
      labelCaveat: taskCaveats[labelKey],
      devWalkForward: summarizeDirectionTask(evaluation, dirSpecs),
      perSymbolAucAudit: perSymbolAucAudit(evaluation.pooled, dirSpecs),
      perFold: evaluation.perFold,
      heldOutFinal: evaluateHeldOutDirection(devRows, heldOutRows, { labelKey, specs: dirSpecs }),
    });
  }
  const regression = evaluateRegressionTask(devRows, heldOutRows, {
    specs: regSpecs, nFolds: cfg.nFolds,
  });
  const regSummary = {};
  for (const spec of regSpecs) {
    regSummary[spec.id] = Object.freeze({
      layerA: regressionLayerA(regression.pooled.get(spec.id)),
      layerB: tradesStats(regression.pooledTrades.get(spec.id)),
    });
  }
  return Object.freeze({
    direction: blocks.up,
    trendContinuation: blocks.cont,
    reversal: blocks.rev,
    expectedReturn: Object.freeze({
      devWalkForward: Object.freeze(regSummary),
      perFold: regression.perFold,
      heldOutFinal: regression.heldOutEval,
    }),
    regime: scenario === 'PI_TREND_REGIMES'
      ? Object.freeze({
        devWalkForward: evaluateRegimeTask(devRows),
        heldOutFinal: evaluateRegimeTask(heldOutRows),
      })
      : null,
    modelRegistry: Object.freeze({
      direction: dirSpecs.map((s) => ({ id: s.id, family: s.family, paramCount: s.paramCount })),
      regression: regSpecs.map((s) => ({ id: s.id, family: s.family, paramCount: s.paramCount })),
    }),
  });
}

function nullFpControl(nullTasks) {
  // Null false-positive control runs on the DIRECTION task only: its label
  // (forward return > 0) is a pure forward outcome. The continuation label
  // embeds the past return sign and the reversal label embeds feature
  // thresholds (|past| > 0.5*sigma_W) — their Layer-A AUCs are partially
  // TAUTOLOGICAL with respect to the label definition and are excluded
  // from the null control and from gate claims.
  const cellsAll = [];
  for (const cell of nullTasks.direction.perSymbolAucAudit) {
    if (cell.z === null) continue;
    cellsAll.push(cell);
  }
  const cells = cellsAll.length;
  const perCellAlpha = 0.05;
  const familyAlpha = 0.05;
  const zFamily = cells > 0 ? normalQuantile(1 - familyAlpha / cells) : null;
  let significantPerCell = 0;
  let significantCells = [];
  let familySignificant = 0;
  for (const cell of cellsAll) {
    if (cell.z > Z95_ONE_SIDED) {
      significantPerCell += 1;
      significantCells.push(Object.freeze({
        task: 'direction', modelId: cell.modelId, symbol: cell.symbol, z: cell.z,
      }));
    }
    if (zFamily !== null && cell.z > zFamily) familySignificant += 1;
  }
  const rate = cells > 0 ? significantPerCell / cells : null;
  return Object.freeze({
    nominalAlpha: perCellAlpha,
    familyAlpha,
    familyCorrection: 'Bonferroni (direction-task cells only)',
    cells, significantPerCell, rate,
    zFamilyThreshold: zFamily,
    familySignificant,
    significantCells: Object.freeze(significantCells),
    verdict: familySignificant === 0 ? 'CONTROLLED' : 'ELEVATED',
    note: 'Direction-task (pure forward-outcome label) per (model x symbol) '
      + 'Layer-A cells on the null fixture. Per-cell one-sided 5% counts are '
      + 'descriptive (cells are correlated through shared paths and folds); '
      + 'the CONTROL verdict requires zero Bonferroni family-wise '
      + 'rejections. Continuation/reversal labels are excluded: their '
      + 'definitions depend on past-return signs/thresholds, making their '
      + 'Layer-A AUC partially tautological — not valid null tests.',
  });
}

function plantedSensitivity(cfg, plantedFixture, nullTasks, plantedTasks) {
  // The planted continuation edge manifests as direction persistence
  // (momentum): detection therefore appears in the DIRECTION task (pure
  // forward-outcome label). The continuation task's label is diluted and
  // partially feature-determined, so it is not used for sensitivity.
  const modelIds = ['logistic-l2', `stumps-${cfg.stumpsLarge}`];
  const perModel = {};
  for (const modelId of modelIds) {
    const nullAuc = nullTasks.direction.devWalkForward[modelId].layerA.auc;
    const plantedAuc = plantedTasks.direction.devWalkForward[modelId].layerA.auc;
    perModel[modelId] = Object.freeze({
      nullDirAuc: nullAuc.value,
      plantedDirAuc: plantedAuc.value,
      plantedDirZ: plantedAuc.value !== null ? plantedAuc.z : null,
      deltaAuc: nullAuc.value !== null && plantedAuc.value !== null
        ? plantedAuc.value - nullAuc.value : null,
    });
  }
  const rates = {};
  for (const symbol of plantedFixture.symbols) {
    const r = measureContinuationRate(plantedFixture, symbol);
    if (r.rate !== null) rates[symbol] = r.rate;
  }
  const rateValues = Object.values(rates);
  const measuredRate = rateValues.length ? mean(rateValues) : null;
  const requiredN = requiredNPerClassForAucDetection(cfg.plantedContinuationProb, 0.05, 0.8);
  const plantedAucBlock = plantedTasks.direction.devWalkForward['logistic-l2'].layerA.auc;
  const availablePerClass = plantedAucBlock.value !== null
    ? Math.min(plantedAucBlock.n1, plantedAucBlock.n0) : null;
  return Object.freeze({
    plantedContinuationProb: cfg.plantedContinuationProb,
    detectionTask: 'direction (pure forward-outcome label)',
    fixtureContinuationRateAtTriggers: measuredRate,
    perSymbolRates: Object.freeze(rates),
    perModel: Object.freeze(perModel),
    requiredNPerClass: requiredN,
    availablePerClass,
    sufficientPower: availablePerClass !== null ? availablePerClass >= requiredN : null,
    interpretation: 'Recovery of the planted continuation edge validates the '
      + 'detection sensitivity of the framework on synthetic fixtures; it '
      + 'is NOT evidence of real-world predictive value.',
  });
}

function complexityVsValueTable(scenarioTasksByName, cfg) {
  const rows = [];
  for (const [scenario, tasks] of Object.entries(scenarioTasksByName)) {
    const dirRegistry = new Map(tasks.modelRegistry.direction.map((s) => [s.id, s]));
    const regRegistry = new Map(tasks.modelRegistry.regression.map((s) => [s.id, s]));
    for (const task of ['direction', 'trendContinuation', 'reversal']) {
      const held = tasks[task].heldOutFinal;
      const prior = held['prior-baseline'].layerA.auc;
      for (const [modelId, summary] of Object.entries(held)) {
        const auc = summary.layerA.auc;
        const spec = dirRegistry.get(modelId);
        const delta = auc.value !== null && prior.value !== null
          ? auc.value - prior.value : null;
        const deltaZ = delta !== null && auc.se && prior.se
          ? delta / Math.sqrt(auc.se ** 2 + prior.se ** 2) : null;
        rows.push(Object.freeze({
          scenario, task, modelId,
          taskCaveat: task === 'direction' ? null : (tasks[task].labelCaveat || null),
          gateEligible: task === 'direction',
          family: spec.family,
          paramCount: spec.paramCount,
          heldOutAuc: auc.value,
          heldOutAucZ: auc.value !== null ? auc.z : null,
          heldOutBrier: summary.layerA.brier,
          deltaVsPriorAuc: delta,
          deltaVsPriorZ: deltaZ,
          afterCostMeanRPerTrade: summary.layerB.meanRPerTrade,
          afterCostCi95: summary.layerB.ci95,
          nTrades: summary.layerB.nTrades,
        }));
      }
    }
    const regPrior = tasks.expectedReturn.heldOutFinal['prior-mean'].layerA;
    for (const [modelId, summary] of Object.entries(tasks.expectedReturn.heldOutFinal)) {
      const spec = regRegistry.get(modelId);
      const ic = summary.layerA.ic;
      const icZ = summary.layerA.icZ;
      const delta = ic !== null && regPrior.ic !== null ? ic - regPrior.ic : null;
      const deltaZ = delta !== null && summary.layerA.nValid > 13 && regPrior.nValid > 13
        ? delta / Math.sqrt((1 / (summary.layerA.nValid - 3)) + (1 / (regPrior.nValid - 3)))
        : null;
      rows.push(Object.freeze({
        scenario, task: 'expectedReturn', modelId,
        taskCaveat: null,
        gateEligible: true,
        family: spec.family,
        paramCount: spec.paramCount,
        heldOutAuc: ic,
        heldOutAucZ: icZ,
        heldOutBrier: null,
        deltaVsPriorAuc: delta,
        deltaVsPriorZ: deltaZ,
        afterCostMeanRPerTrade: summary.layerB.meanRPerTrade,
        afterCostCi95: summary.layerB.ci95,
        nTrades: summary.layerB.nTrades,
      }));
    }
  }
  return Object.freeze(rows);
}

function brokerConnectedGate(complexityTable) {
  const conditions = Object.freeze([
    'C1 held-out after-cost mean R/trade > 0 AND 95% CI excludes zero',
    'C2 held-out prediction-quality improvement vs prior-baseline significant at one-sided alpha=0.05',
    'C3 real-data (operator-authorized export) evaluation completed — impossible on synthetic fixtures',
  ]);
  // Gate-eligible tasks only: direction and expectedReturn (pure forward
  // outcome labels). Continuation/reversal labels are partially
  // feature-determined and are excluded from gate claims.
  const gateRows = complexityTable.filter((r) => r.gateEligible);
  const evaluated = gateRows.map((row) => {
    const c1 = row.afterCostMeanRPerTrade !== null && row.afterCostMeanRPerTrade > 0
      && row.afterCostCi95 !== null && row.afterCostCi95[0] > 0;
    const c2 = row.deltaVsPriorZ !== null && row.deltaVsPriorZ > Z95_ONE_SIDED;
    return Object.freeze({
      scenario: row.scenario, task: row.task, modelId: row.modelId,
      c1AfterCostExpectancy: c1, c2PredictionImprovement: c2,
      pass: c1 && c2,
    });
  });
  const anyPass = evaluated.some((e) => e.pass);
  return Object.freeze({
    syntheticOnly: true,
    conditions,
    gateEligibleTasks: Object.freeze(['direction', 'expectedReturn']),
    gateExclusionNote: 'Continuation and reversal tasks are excluded from '
      + 'gate claims: their labels are partially feature-determined by '
      + 'definition (past-return sign; |past| > 0.5*sigma_W threshold), '
      + 'which would make C2 tautological.',
    evaluated: Object.freeze(evaluated),
    anyModelPasses: anyPass,
    recommendation: 'NOT_RECOMMENDED',
    reason: 'Broker-connected evaluation is NOT recommended from this phase: '
      + 'the fixtures are fully synthetic (condition C3 unmet — real-data '
      + 'evaluation requires the operator-authorized historical export, '
      + 'still blocked per P4-0). Even where a planted edge is recovered '
      + '(framework sensitivity validation), that validates the '
      + 'methodology, NOT real-world predictive value. '
      + (anyPass ? 'Candidates passing C1+C2 on PLANTED synthetic cells are '
        + 'sensitivity-validation artifacts, not recommendations. ' : '')
      + 'V2 remains research-only with no LIVE authority.',
    antiGateSubstitution: 'Improvement claims are evaluated ONLY on Layer A '
      + '(prediction quality on the FULL common grid, 100% coverage). No '
      + 'confidence gate, abstention rule or frequency reduction is counted '
      + 'as intelligence improvement in this phase.',
  });
}

function runPiCampaign(userConfig = {}) {
  const cfg = defaultConfig(userConfig);
  const scenarios = {};
  const scenarioTasks = {};
  const fixtures = {};
  for (const [scenario, seedBase] of Object.entries(cfg.seedBases)) {
    const fixture = generatePiFixture({
      seed: seedBase + 1, symbols: cfg.symbols, days: cfg.days, scenario,
      plantedContinuationProb: cfg.plantedContinuationProb,
    });
    fixtures[scenario] = scenario === 'PI_PLANTED_CONTINUATION' ? fixture : null;
    const dataset = buildPredictionOpportunities(fixture);
    const { dev, heldOut } = reserveHeldOut(dataset, { fraction: cfg.heldOutFraction });
    const tasks = runScenarioTasks(scenario, cfg, dev, heldOut);
    scenarioTasks[scenario] = tasks;
    scenarios[scenario] = Object.freeze({
      fixture: Object.freeze({
        scenario, days: cfg.days, symbols: Object.freeze([...cfg.symbols]),
        nBarsPerSymbolM1: fixture.nBarsPerSymbol,
        plantedContinuationProb: fixture.plantedContinuationProb,
        provenance: 'SYNTHETIC_FIXTURE (no broker records)',
      }),
      dataset: Object.freeze({
        rows: dataset.rows.length,
        devRows: dev.length,
        heldOutRows: heldOut.length,
        horizonM5: dataset.horizonM5,
        lookbackM5: dataset.lookbackM5,
        sampleEveryM5: dataset.sampleEveryM5,
        outcomeDefinitions: dataset.outcomeDefinitions,
      }),
      tasks,
    });
  }
  const result = {
    phase: 'PI-5 predictive-intelligence evaluation campaign',
    campaignDate: '2026-11-28',
    config: Object.freeze({
      symbols: Object.freeze([...cfg.symbols]),
      days: cfg.days,
      nFolds: cfg.nFolds,
      stumpsSmall: cfg.stumpsSmall,
      stumpsLarge: cfg.stumpsLarge,
      heldOutFraction: cfg.heldOutFraction,
      plantedContinuationProb: cfg.plantedContinuationProb,
      seedBases: Object.freeze({ ...cfg.seedBases }),
    }),
    layerSemantics: Object.freeze({
      layerA: 'prediction quality on the FULL common grid (identical outcome '
        + 'definitions; 100% coverage; the only layer where improvement '
        + 'claims may be made)',
      layerB: 'one identical standardized fixed-horizon policy for every '
        + 'candidate — direction-quality differences only, no exit-policy '
        + 'tuning, constant sizing, train-only thresholds',
    }),
    scenarios,
    nullFpControl: nullFpControl(scenarioTasks.PI_NULL),
    plantedSensitivity: plantedSensitivity(
      cfg, fixtures.PI_PLANTED_CONTINUATION,
      scenarioTasks.PI_NULL, scenarioTasks.PI_PLANTED_CONTINUATION,
    ),
    complexityVsValue: complexityVsValueTable(scenarioTasks, cfg),
    refusals: CAMPAIGN_REFUSALS,
  };
  const gate = brokerConnectedGate(result.complexityVsValue);
  return Object.freeze({ ...result, gate });
}

module.exports = {
  Z95_ONE_SIDED,
  CAMPAIGN_REFUSALS,
  fastAuc,
  layerA,
  layerB,
  breakevenThresholds,
  tradesStats,
  brokerConnectedGate,
  runPiCampaign,
};
