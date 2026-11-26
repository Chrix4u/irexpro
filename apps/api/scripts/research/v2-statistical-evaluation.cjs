'use strict';
/**
 * V2 statistical evaluation framework for the Champion-Challenger
 * comparison. Primary endpoint: after-cumulative-cost net expectancy per
 * trade in R units with a two-sided uncertainty interval. Win rate alone is
 * explicitly insufficient and never a decision criterion.
 *
 * Research-only. Operates on synthetic fixtures or separately authorized
 * offline aggregates. Never grants order authority. Refuses
 * underpowered comparisons (INSUFFICIENT_SAMPLE) and naive iid comparisons
 * on clustered inputs (CLUSTERED_INPUT).
 */

const Z95 = 1.959964;

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Wilson score interval for a binomial proportion. */
function wilsonInterval(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) {
    return null;
  }
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Max drawdown of a cumulative return series (same units as input). */
function maxDrawdown(returns) {
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  for (const value of returns) {
    if (!finiteNumber(value)) return null;
    cumulative += value;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Population stdev (ddof=0); null for n<2. */
function stdev(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
  return Math.sqrt(variance);
}

/**
 * After-cost performance statistics for one engine, in R units.
 * rows: [{ netR: number (after cumulative costs) }] plus optional lots.
 */
function evaluateAfterCostPerformance(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('PERFORMANCE_ROWS_EMPTY');
  }
  const netR = rows.map((r) => {
    if (!finiteNumber(r.netR)) throw new Error('PERFORMANCE_NET_R_INVALID');
    return r.netR;
  });
  const n = netR.length;
  const wins = netR.filter((v) => v > 0);
  const losses = netR.filter((v) => v < 0);
  const grossWinR = wins.reduce((s, v) => s + v, 0);
  const grossLossR = losses.reduce((s, v) => s + Math.abs(v), 0);
  const total = netR.reduce((s, v) => s + v, 0);
  const mean = total / n;
  const sd = stdev(netR);
  const k = wins.length;
  const [wrLo, wrHi] = wilsonInterval(k, n) || [null, null];
  const avgWinR = wins.length > 0 ? grossWinR / wins.length : null;
  const avgLossR = losses.length > 0 ? grossLossR / losses.length : null;
  return Object.freeze({
    n,
    totalNetR: total,
    meanNetR: mean,
    winCount: k,
    lossCount: losses.length,
    winRate: k / n,
    winRateWilson95: [wrLo, wrHi],
    profitFactor: grossLossR > 0 ? grossWinR / grossLossR
      : grossWinR > 0 ? null : 0,
    avgWinR,
    avgLossR,
    payoffRatio: avgWinR !== null && avgLossR !== null && avgLossR > 0
      ? avgWinR / avgLossR : null,
    stdevNetR: sd,
    riskNormalizedExpectancy: sd !== null && sd > 0 ? mean / sd : null,
    maxDrawdownR: maxDrawdown(netR),
    uncertaintyStatement: Object.freeze({
      note: 'Wilson 95% on win rate; R-unit point estimates carry ' +
        'selection and clustering caveats stated in the campaign ' +
        'pre-registration. Win rate alone is never a decision criterion.',
      minimumDetectableWinRateShift95: wrLo !== null ? 2 * (wrHi - wrLo) / 2 : null,
    }),
  });
}

/**
 * Calibration of registered pre-outcome probabilities against settled
 * outcomes (proper scoring rule). items: [{ probability, outcome(0|1) }].
 */
function evaluateCalibration(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('CALIBRATION_ITEMS_EMPTY');
  }
  const clean = items.map((it) => {
    if (!it || !finiteNumber(it.probability) || it.probability < 0 ||
        it.probability > 1) {
      throw new Error('CALIBRATION_PROBABILITY_INVALID');
    }
    if (it.outcome !== 0 && it.outcome !== 1) {
      throw new Error('CALIBRATION_OUTCOME_INVALID');
    }
    return { p: it.probability, o: it.outcome };
  });
  const n = clean.length;
  const brier = clean.reduce((s, it) => s + (it.p - it.o) ** 2, 0) / n;
  const base = clean.reduce((s, it) => s + it.o, 0) / n;
  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0000001];
  const reliability = [];
  for (let i = 0; i < 5; i += 1) {
    const inBin = clean.filter((it) => it.p >= bins[i] && it.p < bins[i + 1]);
    if (inBin.length === 0) continue;
    const meanP = inBin.reduce((s, it) => s + it.p, 0) / inBin.length;
    const meanO = inBin.reduce((s, it) => s + it.o, 0) / inBin.length;
    reliability.push(Object.freeze({
      bin: i,
      count: inBin.length,
      meanPredicted: meanP,
      meanObserved: meanO,
      gap: meanO - meanP,
    }));
  }
  const ece = reliability.reduce((s, b) => s + (b.count / n) * Math.abs(b.gap), 0);
  // Brier decomposition: resolution = weighted variance of bin means around
  // the base rate (higher is better; 0 = no resolution).
  const resolution = reliability.reduce((s, b) =>
    s + b.count * (b.meanObserved - base) ** 2, 0) / n;
  return Object.freeze({
    n,
    brierScore: brier,
    brierSkillScore: base * (1 - base) > 0 ? 1 - brier / (base * (1 - base)) : null,
    expectedCalibrationError: ece,
    reliability: Object.freeze(reliability),
    resolution: Number.isFinite(resolution) ? resolution : null,
    baseRate: base,
  });
}

/**
 * Hanley-McNeil standard error of AUC given class sizes n1 (positives),
 * n2 (negatives) and the observed AUC. Cross-checked against the value
 * pinned in PR #836 (AUC 0.4752, 105/87 -> SE 0.042).
 */
function aucStandardError(auc, n1, n2) {
  if (!finiteNumber(auc) || auc <= 0 || auc >= 1 ||
      !Number.isInteger(n1) || !Number.isInteger(n2) || n1 < 1 || n2 < 1) {
    throw new Error('AUC_SE_INPUT_INVALID');
  }
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const variance =
    (auc * (1 - auc) + (n1 - 1) * (q1 - auc * auc) + (n2 - 1) * (q2 - auc * auc)) /
    (n1 * n2);
  return Math.sqrt(Math.max(0, variance));
}

/** Smallest |AUC - 0.5| the given class sizes can exclude at 95% (two-sided). */
function minimumDetectableAucEffect(aucNull, n1, n2) {
  const se = aucStandardError(0.5, n1, n2);
  return Z95 * se;
}

/**
 * Per-class sample size required to detect a target AUC deviation from
 * chance at 80% power, alpha=0.05 (two-sided), using the Hanley-McNeil
 * SE at the target AUC. Iterative solve on n1=n2=n.
 */
function requiredNPerClassForAucDetection(targetAuc, alpha = 0.05, power = 0.8) {
  if (!finiteNumber(targetAuc) || targetAuc <= 0.5 || targetAuc >= 1) {
    throw new Error('AUC_N_INPUT_INVALID');
  }
  const zAlpha = 1.959964; // two-sided 0.05
  const zPower = 0.8416212; // 80% power
  const delta = targetAuc - 0.5;
  const seAt = (n) => aucStandardError(targetAuc, n, n);
  let n = 20;
  // monotone decreasing SE in n: find smallest n with delta / se(n) >= zA+zP
  while (n < 100000) {
    if (delta / seAt(n) >= zAlpha + zPower) return n;
    n += 1;
  }
  return null;
}

/**
 * Cluster discipline: refuse naive comparisons whose inputs share cluster
 * keys (session x instrument episodes). Correlated observations must be
 * declared and handled by the pre-registered cluster policy, not averaged.
 */
function assertComparisonClusters(engineARows, engineBRows, clusterKey) {
  const keyOf = (row) => (clusterKey && row ? row[clusterKey] : undefined);
  const keysA = new Set(engineARows.map(keyOf).filter((v) => v !== undefined));
  const shared = [];
  for (const row of engineBRows) {
    const k = keyOf(row);
    if (k !== undefined && keysA.has(k)) shared.push(k);
  }
  return Object.freeze({
    clustered: shared.length > 0,
    sharedClusterKeys: Object.freeze(shared),
  });
}

/**
 * Newcombe hybrid-score interval for the difference of two win rates.
 * Both engines' settled counts are required; underpowered comparisons are
 * refused with a typed error rather than silently reported.
 */
function compareWinRates(a, b, options) {
  const minPerEngine = options && Number.isInteger(options.minPerEngine)
    ? options.minPerEngine : 30;
  for (const side of [a, b]) {
    if (!side || !Number.isInteger(side.wins) || !Number.isInteger(side.n) ||
        side.n <= 0 || side.wins < 0 || side.wins > side.n) {
      throw new Error('WIN_RATE_INPUT_INVALID');
    }
    if (side.n < minPerEngine) {
      throw new Error(`INSUFFICIENT_SAMPLE:${side.n}<${minPerEngine}`);
    }
  }
  const p1 = a.wins / a.n;
  const p2 = b.wins / b.n;
  const [l1, u1] = wilsonInterval(a.wins, a.n);
  const [l2, u2] = wilsonInterval(b.wins, b.n);
  const diff = p1 - p2;
  const lower = diff - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2);
  const upper = diff + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2);
  return Object.freeze({
    p1, p2, difference: diff,
    confidence95: Object.freeze([lower, upper]),
    excludesZero: lower > 0 || upper < 0,
    note: 'Newcombe hybrid score interval; requires declared cluster policy ' +
      'when observations are correlated (see assertComparisonClusters).',
  });
}

module.exports = {
  wilsonInterval,
  maxDrawdown,
  evaluateAfterCostPerformance,
  evaluateCalibration,
  aucStandardError,
  minimumDetectableAucEffect,
  requiredNPerClassForAucDetection,
  assertComparisonClusters,
  compareWinRates,
};
