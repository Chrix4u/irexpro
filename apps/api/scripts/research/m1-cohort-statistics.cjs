'use strict';

// Independent research artifact: cohort-level statistics computed ONLY from
// operator-supplied aggregate counts (192 settled DEMO trades; 105 W / 87 L;
// M1 abstained on 154, of which 86 W / 68 L; reported M1-confidence AUC
// 0.4752). No private per-trade observations, account identifiers or
// credentials are used, stored or published. Pure math, no database access,
// no model execution, no trading authority.

const Z95 = 1.959963984540054;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Wilson score interval for a binomial proportion. */
function wilsonInterval(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { k, n, p, ci95: [(center - half) / denom, (center + half) / denom] };
}

/** log-gamma for Fisher exact support. */
function logGamma(n) {
  if (n < 0) return NaN;
  let x = 0;
  for (let i = 2; i <= n; i++) x += Math.log(i);
  return x; // exact for integers
}

function logChoose(n, r) {
  return logGamma(n) - logGamma(r) - logGamma(n - r);
}

/** Two-sided Fisher exact test for a 2x2 table [[a,b],[c,d]]. */
function fisherExact2x2(a, b, c, d) {
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  // Hypergeometric log-probability of a table: C(col1, x) * C(n-col1,
  // row1-x) / C(n, row1).
  const tableLogP = (x) => logChoose(col1, x) + logChoose(n - col1, row1 - x) - logChoose(n, row1);
  const logBase = tableLogP(a);
  // Sum probabilities of all tables no more probable than the observed one.
  let pSum = 0;
  const lo = Math.max(0, row1 - (n - col1));
  const hi = Math.min(row1, col1);
  for (let x = lo; x <= hi; x++) {
    const lp = tableLogP(x);
    if (lp <= logBase + 1e-9) pSum += Math.exp(lp);
  }
  return { p: pSum };
}

/** Hanley-McNeil standard error of the AUC. */
function aucStandardError(auc, n1, n2) {
  if (!finite(auc) || auc <= 0 || auc >= 1 || !Number.isInteger(n1) || !Number.isInteger(n2)) {
    return null;
  }
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const v =
    (auc * (1 - auc) + (n1 - 1) * (q1 - auc * auc) + (n2 - 1) * (q2 - auc * auc)) / (n1 * n2);
  return Math.sqrt(v);
}

/** Two-sided test of AUC == 0.5. */
function aucTest(auc, n1, n2) {
  const se = aucStandardError(auc, n1, n2);
  if (se === null) return null;
  const z = (auc - 0.5) / se;
  // normal two-sided p from |z|
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { auc, n1, n2, se, z, p, ci95: [auc - Z95 * se, auc + Z95 * se] };
}

function normalCdf(x) {
  // Abramowitz & Stegun 7.1.26 via erf
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/** Minimum |AUC-0.5| detectable at 80% power (two-sided alpha=0.05). */
function minDetectableAucDelta(n1, n2) {
  const zA = 1.959963984540054; // alpha=0.05 two-sided
  const zB = 0.8416212335729143; // power=0.8
  let d = 0.05;
  for (let i = 0; i < 100; i++) {
    const se = aucStandardError(0.5 + d, n1, n2);
    const dNew = (zA + zB) * se;
    if (Math.abs(dNew - d) < 1e-10) break;
    d = dNew;
  }
  return d;
}

/** Per-class sample sizes needed to detect AUC=0.5+delta at 80% power.
 * Smallest balanced n where (zA+zB) * SE <= delta; SE shrinks in n, so a
 * doubling scan plus binary search is exact for the integer answer. */
function nNeededForAuc(delta) {
  const zA = 1.959963984540054;
  const zB = 0.8416212335729143; // power=0.8
  const detectableAt = (n) => aucStandardError(0.5 + delta, n, n) * (zA + zB) <= delta;
  let hi = 2;
  while (!detectableAt(hi)) {
    hi *= 2;
    if (hi > 1e9) return NaN;
  }
  let lo = Math.floor(hi / 2) + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (detectableAt(mid)) hi = mid;
    else lo = mid + 1;
  }
  return hi;
}

/**
 * Aggregates for the reported M1 abstention review (operator-supplied).
 * Computes win-rate intervals, group separation, AUC test, detectability and
 * the payoff-asymmetry bound implied by net-negative cohorts.
 */
function analyzeCohort(input) {
  const required = ['total', 'wins', 'losses', 'abstainedWins', 'abstainedLosses'];
  for (const key of required) if (!Number.isInteger(input[key])) return null;
  const {
    total,
    wins,
    losses,
    abstainedWins,
    abstainedLosses,
    auc = null,
    aucWinners = null,
    aucLosers = null,
  } = input;
  if (wins + losses !== total) return null;
  const nonAbstainedWins = wins - abstainedWins;
  const nonAbstainedLosses = losses - abstainedLosses;
  if (nonAbstainedWins < 0 || nonAbstainedLosses < 0) return null;

  const group = {
    overall: wilsonInterval(wins, total),
    abstained: wilsonInterval(abstainedWins, abstainedWins + abstainedLosses),
    nonAbstained: wilsonInterval(nonAbstainedWins, nonAbstainedWins + nonAbstainedLosses),
  };
  const separation = fisherExact2x2(
    abstainedWins,
    abstainedLosses,
    nonAbstainedWins,
    nonAbstainedLosses,
  );
  const aucResult =
    auc !== null && aucWinners !== null && aucLosers !== null
      ? aucTest(auc, aucWinners, aucLosers)
      : null;
  const detectability = {
    minDetectableAucDeltaOverall: minDetectableAucDelta(wins, losses),
    nPerClassForAuc055: nNeededForAuc(0.05),
    nPerClassForAuc060: nNeededForAuc(0.1),
  };
  // Payoff asymmetry: with a win rate above the design break-even but a net
  // loss, the realized average loss must exceed (wins/losses) x average win
  // under equal sizing. Design geometry: 1.6R target vs 1.0R stop.
  const payoffAsymmetry = {
    breakevenAvgLossOverAvgWin: wins / losses,
    designWinLossRatio: 1.6,
    designBreakevenWinRate: 1 / (1 + 1.6),
    note:
      'Observed win rate above design break-even with net-negative P&L ' +
      'implies realized payoff ratio below design under equal sizing; exit ' +
      'management and costs truncate wins or extend losses. Variable ' +
      'position sizes can distort this bound.',
  };

  return {
    artifact: 'm1-cohort-statistics-v1',
    researchOnly: true,
    executionAuthority: 'NONE',
    counts: {
      total,
      wins,
      losses,
      abstained: abstainedWins + abstainedLosses,
      abstainedWins,
      abstainedLosses,
      nonAbstained: nonAbstainedWins + nonAbstainedLosses,
      nonAbstainedWins,
      nonAbstainedLosses,
    },
    group,
    fisherExactAbstainedVsNonAbstained: separation,
    auc: aucResult,
    detectability,
    payoffAsymmetry,
    limitations:
      'Aggregate counts only; per-trade magnitudes, instruments, timestamps ' +
      'and correlations are unavailable, so overlapping observations and ' +
      'variable sizing cannot be corrected. Abstained-cohort outcomes exist ' +
      'only where another authority executed the trade (selection bias). ' +
      'Statistically indistinguishable from random is NOT evidence of zero ' +
      'true effect at these sample sizes.',
  };
}

module.exports = {
  wilsonInterval,
  fisherExact2x2,
  aucStandardError,
  aucTest,
  minDetectableAucDelta,
  nNeededForAuc,
  analyzeCohort,
};
