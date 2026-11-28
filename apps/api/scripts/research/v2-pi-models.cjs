'use strict';
/**
 * V2 predictive-intelligence candidate models (PI-4, directive 2026-11-28).
 *
 * Deterministic, dependency-free candidate classes for the four prediction
 * tasks (trend continuation, reversal, direction, expected return) and the
 * regime-classification layer:
 *
 *   classical — prior baseline, L2-penalized logistic regression (full-batch
 *               gradient descent), ridge regression (closed form);
 *   temporal  — recency-weighted logistic (chronology-aware decay),
 *               AR(p) expected-return regression on lagged outcomes;
 *   boosted   — gradient-boosted shallow stumps (logistic / squared loss),
 *               two complexity tiers (small / large).
 *
 * Every model exposes { id, family, complexity, fit(trainRows, opts),
 * predict(features) } and is a pure function of its training input — no
 * randomness, no global state. Complexity descriptors (parameter counts)
 * are recorded for the complexity-vs-out-of-sample-value comparison.
 * Research-only: prediction values, never order authority.
 */

const { FEATURE_NAMES } = require('./v2-prediction-dataset.cjs');

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function requireRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('MODEL_ROWS_REQUIRED');
  }
}

function standardizedMatrix(rows, scaler) {
  const X = rows.map((row) => FEATURE_NAMES.map(
    (name) => (row.features[name] - scaler.means[name]) / scaler.sds[name],
  ));
  for (const x of X) {
    for (const v of x) {
      if (!Number.isFinite(v)) {
        throw new Error('MODEL_FEATURE_INVALID');
      }
    }
  }
  return X;
}

function extractLabels(rows, labelKey) {
  const y = rows.map((row) => row.labels[labelKey]);
  for (const v of y) {
    if (!(v === 0 || v === 1)) {
      throw new Error('MODEL_LABEL_INVALID');
    }
  }
  return y;
}

// ---------------------------------------------------------------------------
// Classical: prior baseline (direction and regression variants)
// ---------------------------------------------------------------------------

function createPriorDirectionModel() {
  let p = 0.5;
  return Object.freeze({
    id: 'prior-baseline',
    family: 'classical',
    task: 'direction',
    complexity: Object.freeze({ paramCount: 1, label: 'train base rate' }),
    fit(trainRows, { labelKey = 'up' } = {}) {
      requireRows(trainRows);
      const y = extractLabels(trainRows, labelKey);
      p = y.reduce((s, v) => s + v, 0) / y.length;
      return this;
    },
    predict() {
      return Object.freeze({ p });
    },
  });
}

function createPriorRegressionModel() {
  let value = 0;
  return Object.freeze({
    id: 'prior-mean',
    family: 'classical',
    task: 'regression',
    complexity: Object.freeze({ paramCount: 1, label: 'train mean' }),
    fit(trainRows, { labelKey = 'fwdR' } = {}) {
      requireRows(trainRows);
      const y = trainRows.map((r) => r.labels[labelKey]);
      for (const v of y) {
        if (!Number.isFinite(v) || v === null) {
          throw new Error('MODEL_LABEL_INVALID');
        }
      }
      value = y.reduce((s, v) => s + v, 0) / y.length;
      return this;
    },
    predict() {
      return Object.freeze({ value });
    },
  });
}

// ---------------------------------------------------------------------------
// Classical: L2-penalized logistic regression (full-batch GD)
// ---------------------------------------------------------------------------

function createLogisticL2({ lambda = 0.01, iterations = 300, learningRate = 0.5 } = {}) {
  let w = null;
  return Object.freeze({
    id: 'logistic-l2',
    family: 'classical',
    task: 'direction',
    complexity: Object.freeze({ paramCount: FEATURE_NAMES.length + 1 }),
    fit(trainRows, { labelKey = 'up', scaler } = {}) {
      requireRows(trainRows);
      const X = standardizedMatrix(trainRows, scaler);
      const y = extractLabels(trainRows, labelKey);
      const d = FEATURE_NAMES.length;
      w = new Array(d + 1).fill(0);
      for (let it = 0; it < iterations; it += 1) {
        const grad = new Array(d + 1).fill(0);
        for (let i = 0; i < X.length; i += 1) {
          const x = X[i];
          let z = w[d];
          for (let j = 0; j < d; j += 1) z += w[j] * x[j];
          const err = sigmoid(z) - y[i];
          for (let j = 0; j < d; j += 1) grad[j] += err * x[j];
          grad[d] += err;
        }
        for (let j = 0; j < d; j += 1) {
          w[j] -= learningRate * (grad[j] / X.length + lambda * w[j]);
        }
        w[d] -= learningRate * (grad[d] / X.length);
      }
      return this;
    },
    predict(features) {
      let z = w[w.length - 1];
      for (let j = 0; j < w.length - 1; j += 1) {
        z += w[j] * features[FEATURE_NAMES[j]];
      }
      return Object.freeze({ p: sigmoid(z) });
    },
  });
}

// ---------------------------------------------------------------------------
// Temporal: recency-weighted logistic (chronology-aware decay)
// ---------------------------------------------------------------------------

function createRecencyWeightedLogistic({ decay = 0.999, iterations = 300, learningRate = 0.5, lambda = 0.01 } = {}) {
  let w = null;
  return Object.freeze({
    id: 'recency-logistic',
    family: 'temporal',
    task: 'direction',
    complexity: Object.freeze({ paramCount: FEATURE_NAMES.length + 1, label: `decay ${decay}` }),
    fit(trainRows, { labelKey = 'up', scaler } = {}) {
      requireRows(trainRows);
      const sorted = [...trainRows].sort((a, b) => a.t - b.t);
      const X = standardizedMatrix(sorted, scaler);
      const y = extractLabels(sorted, labelKey);
      const d = FEATURE_NAMES.length;
      const n = X.length;
      w = new Array(d + 1).fill(0);
      for (let it = 0; it < iterations; it += 1) {
        const grad = new Array(d + 1).fill(0);
        let wSum = 0;
        for (let i = 0; i < n; i += 1) {
          const age = n - 1 - i;
          const weight = Math.pow(decay, age);
          wSum += weight;
          const x = X[i];
          let z = w[d];
          for (let j = 0; j < d; j += 1) z += w[j] * x[j];
          const err = sigmoid(z) - y[i];
          for (let j = 0; j < d; j += 1) grad[j] += weight * err * x[j];
          grad[d] += weight * err;
        }
        for (let j = 0; j < d; j += 1) {
          w[j] -= learningRate * (grad[j] / wSum + lambda * w[j]);
        }
        w[d] -= learningRate * (grad[d] / wSum);
      }
      return this;
    },
    predict(features) {
      let z = w[w.length - 1];
      for (let j = 0; j < w.length - 1; j += 1) {
        z += w[j] * features[FEATURE_NAMES[j]];
      }
      return Object.freeze({ p: sigmoid(z) });
    },
  });
}

// ---------------------------------------------------------------------------
// Classical: ridge regression (closed form via normal equations)
// ---------------------------------------------------------------------------

/** Deterministic Gaussian elimination with partial pivoting. */
function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error('MODEL_SOLVE_SINGULAR');
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r += 1) {
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= factor * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c += 1) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

function createRidgeRegression({ lambda = 1.0 } = {}) {
  let w = null;
  return Object.freeze({
    id: 'ridge',
    family: 'classical',
    task: 'regression',
    complexity: Object.freeze({ paramCount: FEATURE_NAMES.length + 1 }),
    fit(trainRows, { labelKey = 'fwdR', scaler } = {}) {
      requireRows(trainRows);
      const X = standardizedMatrix(trainRows, scaler);
      const y = trainRows.map((r) => r.labels[labelKey]);
      for (const v of y) {
        if (!Number.isFinite(v)) throw new Error('MODEL_LABEL_INVALID');
      }
      const d = FEATURE_NAMES.length;
      const XtX = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
      const Xty = new Array(d + 1).fill(0);
      for (let i = 0; i < X.length; i += 1) {
        const x = X[i];
        for (let a = 0; a <= d; a += 1) {
          const xa = a === d ? 1 : x[a];
          Xty[a] += xa * y[i];
          for (let b = 0; b <= d; b += 1) {
            const xb = b === d ? 1 : x[b];
            XtX[a][b] += xa * xb;
          }
        }
      }
      for (let a = 0; a < d; a += 1) XtX[a][a] += lambda;
      w = solveLinearSystem(XtX, Xty);
      return this;
    },
    predict(features) {
      let z = w[w.length - 1];
      for (let j = 0; j < w.length - 1; j += 1) {
        z += w[j] * features[FEATURE_NAMES[j]];
      }
      return Object.freeze({ value: z });
    },
  });
}

// ---------------------------------------------------------------------------
// Temporal: AR(p) expected-return regression on lagged realized outcomes
// ---------------------------------------------------------------------------

function createARp({ p = 5 } = {}) {
  if (!(Number.isInteger(p) && p >= 1)) {
    throw new Error('MODEL_AR_P_INVALID');
  }
  let coeffs = null;
  let intercept = 0;
  return Object.freeze({
    id: `ar-${p}`,
    family: 'temporal',
    task: 'regression',
    complexity: Object.freeze({ paramCount: p + 1 }),
    fit(trainRows, { labelKey = 'fwdR' } = {}) {
      requireRows(trainRows);
      // Lag matrix per symbol from chronological rows (non-overlapping
      // decision spacing makes the previous outcome known at decision time).
      const bySymbol = new Map();
      for (const row of trainRows) {
        if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
        bySymbol.get(row.symbol).push(row);
      }
      const Xs = [];
      const ys = [];
      for (const [, rows] of bySymbol) {
        const sorted = [...rows].sort((a, b) => a.t - b.t);
        const values = sorted.map((r) => r.labels[labelKey]);
        for (const v of values) {
          if (!Number.isFinite(v)) throw new Error('MODEL_LABEL_INVALID');
        }
        for (let i = p; i < sorted.length; i += 1) {
          Xs.push(values.slice(i - p, i).map((v, k) => values[i - 1 - k] ?? v));
          ys.push(values[i]);
        }
      }
      if (Xs.length < 10) {
        throw new Error('MODEL_AR_INSUFFICIENT_ROWS');
      }
      const XtX = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
      const Xty = new Array(p + 1).fill(0);
      for (let i = 0; i < Xs.length; i += 1) {
        const x = [1, ...Xs[i]];
        for (let a = 0; a <= p; a += 1) {
          Xty[a] += x[a] * ys[i];
          for (let b = 0; b <= p; b += 1) XtX[a][b] += x[a] * x[b];
        }
      }
      for (let a = 1; a <= p; a += 1) XtX[a][a] += 1e-6;
      const sol = solveLinearSystem(XtX, Xty);
      intercept = sol[0];
      coeffs = sol.slice(1);
      return this;
    },
    predictFeatures(lagValues) {
      if (coeffs === null) {
        throw new Error('MODEL_AR_UNFITTED');
      }
      if (!Array.isArray(lagValues) || lagValues.length !== coeffs.length) {
        throw new Error('MODEL_AR_LAGS_REQUIRED');
      }
      let z = intercept;
      for (let j = 0; j < coeffs.length; j += 1) z += coeffs[j] * lagValues[j];
      return Object.freeze({ value: z });
    },
  });
}

// ---------------------------------------------------------------------------
// Boosted: gradient-boosted shallow stumps
// ---------------------------------------------------------------------------

const STUMP_QUANTILES = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);

function buildStumpCandidates(X) {
  const candidates = [];
  const d = FEATURE_NAMES.length;
  for (let j = 0; j < d; j += 1) {
    const values = X.map((x) => x[j]).sort((a, b) => a - b);
    for (const q of STUMP_QUANTILES) {
      const idx = Math.min(values.length - 1, Math.floor(q * values.length));
      candidates.push({ feature: j, threshold: values[idx] });
    }
  }
  return candidates;
}

function bestStump(X, g, candidates, learningRate) {
  let best = null;
  for (const cand of candidates) {
    const { feature, threshold } = cand;
    for (const direction of [1, -1]) {
      // Leaf values: mean gradient per side, scaled by learning rate.
      let leftSum = 0;
      let leftCount = 0;
      let rightSum = 0;
      let rightCount = 0;
      for (let i = 0; i < X.length; i += 1) {
        const onRight = X[i][feature] > threshold;
        const gSign = direction;
        if (onRight === (gSign > 0)) {
          rightSum += g[i];
          rightCount += 1;
        } else {
          leftSum += g[i];
          leftCount += 1;
        }
      }
      if (rightCount === 0 || leftCount === 0) continue;
      const rightLeaf = (rightSum / rightCount) * learningRate;
      const leftLeaf = (leftSum / leftCount) * learningRate;
      // Correlation of the stump output with the gradient (to maximize).
      let gain = 0;
      for (let i = 0; i < X.length; i += 1) {
        const onRight = X[i][feature] > threshold;
        gain += g[i] * (onRight === (direction > 0) ? rightLeaf : leftLeaf);
      }
      if (best === null || gain > best.gain) {
        best = Object.freeze({
          feature, threshold, direction, leftLeaf, rightLeaf, gain,
        });
      }
    }
  }
  return best;
}

function stumpPredict(stump, x) {
  const onRight = x[stump.feature] > stump.threshold;
  const rightSide = stump.direction > 0;
  return onRight === rightSide ? stump.rightLeaf : stump.leftLeaf;
}

function createBoostedStumps({ rounds = 25, learningRate = 0.1 } = {}) {
  let stumps = [];
  return Object.freeze({
    id: `stumps-${rounds}`,
    family: 'boosted',
    task: 'direction',
    complexity: Object.freeze({ paramCount: rounds * 3, label: `${rounds} stumps x (feature, threshold, leaves)` }),
    fit(trainRows, { labelKey = 'up', scaler } = {}) {
      requireRows(trainRows);
      const X = standardizedMatrix(trainRows, scaler);
      const y = extractLabels(trainRows, labelKey);
      const candidates = buildStumpCandidates(X);
      const F = new Array(X.length).fill(0);
      stumps = [];
      for (let r = 0; r < rounds; r += 1) {
        const g = X.map((_, i) => y[i] - sigmoid(F[i]));
        const best = bestStump(X, g, candidates, learningRate);
        if (best === null) break;
        stumps.push(best);
        for (let i = 0; i < X.length; i += 1) {
          F[i] += stumpPredict(best, X[i]);
        }
      }
      return this;
    },
    predict(features) {
      const x = FEATURE_NAMES.map((name) => features[name]);
      let z = 0;
      for (const stump of stumps) {
        z += stumpPredict(stump, x);
      }
      return Object.freeze({ p: sigmoid(z) });
    },
  });
}

function createBoostedStumpsRegression({ rounds = 25, learningRate = 0.1 } = {}) {
  let stumps = [];
  return Object.freeze({
    id: `stumps-reg-${rounds}`,
    family: 'boosted',
    task: 'regression',
    complexity: Object.freeze({ paramCount: rounds * 3, label: `${rounds} stumps x (feature, threshold, leaves)` }),
    fit(trainRows, { labelKey = 'fwdR', scaler } = {}) {
      requireRows(trainRows);
      const X = standardizedMatrix(trainRows, scaler);
      const y = trainRows.map((r) => r.labels[labelKey]);
      for (const v of y) {
        if (!Number.isFinite(v)) throw new Error('MODEL_LABEL_INVALID');
      }
      const candidates = buildStumpCandidates(X);
      const F = new Array(X.length).fill(0);
      stumps = [];
      for (let r = 0; r < rounds; r += 1) {
        const g = y.map((v, i) => v - F[i]);
        const best = bestStump(X, g, candidates, learningRate);
        if (best === null) break;
        stumps.push(best);
        for (let i = 0; i < X.length; i += 1) {
          F[i] += stumpPredict(best, X[i]);
        }
      }
      return this;
    },
    predict(features) {
      const x = FEATURE_NAMES.map((name) => features[name]);
      let z = 0;
      for (const stump of stumps) {
        z += stumpPredict(stump, x);
      }
      return Object.freeze({ value: z });
    },
  });
}

// ---------------------------------------------------------------------------
// Regime classification layer (rule-based, fixed thresholds)
// ---------------------------------------------------------------------------

function createRegimeClassifier({
  m1VolThreshold = 2.3e-4, m15MomThreshold = 7.5e-4,
} = {}) {
  return Object.freeze({
    id: 'regime-rule',
    family: 'classical',
    task: 'regime',
    complexity: Object.freeze({ paramCount: 2, label: 'fixed thresholds (no fit)' }),
    fit() {
      return this; // rule-based; nothing fitted
    },
    classify(features) {
      // Calibrated fixed thresholds on the synthetic regime fixtures:
      // m1Vol separates HIGH_VOL (x2.4 vol multiplier); |m15Mom|
      // separates trend regimes from RANGE.
      if (features.m1Vol > m1VolThreshold) return 'HIGH_VOL';
      if (features.m15Mom > m15MomThreshold) return 'TREND_UP';
      if (features.m15Mom < -m15MomThreshold) return 'TREND_DOWN';
      return 'RANGE';
    },
  });
}

module.exports = {
  sigmoid,
  solveLinearSystem,
  standardizedMatrix,
  createPriorDirectionModel,
  createPriorRegressionModel,
  createLogisticL2,
  createRecencyWeightedLogistic,
  createRidgeRegression,
  createARp,
  createBoostedStumps,
  createBoostedStumpsRegression,
  createRegimeClassifier,
};
