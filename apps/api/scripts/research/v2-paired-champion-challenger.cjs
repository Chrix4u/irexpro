'use strict';

// V2 paired Champion–Challenger comparison on identical decision windows.
// Champion and Challenger must be evaluated on the SAME market windows
// (equivalent conditions), so per-window outcomes pair exactly. Unpaired
// inputs are refused. Verdicts never claim profitability: a challenger is
// "advantaged" only when the paired CI of the difference excludes zero with
// a sufficient window sample.
const ARTIFACT = 'v2-paired-champion-challenger-v1';
const { portfolioMetrics } = require('./v2-settled-trade-economics.cjs');
const { mulberry32, percentile } = require('./v2-settled-trade-economics.cjs');

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const DEFAULT_MIN_WINDOWS = 30;
const DEFAULT_RESAMPLES = 2000;
const DEFAULT_SEED = 20261127;

function binomPmf(k, n) {
  // C(n,k) * 0.5^n, with C(n,k) built from the exact falling-factorial ratio.
  let p = 1;
  for (let i = 0; i < k; i += 1) p *= (n - i) / (k - i);
  return p / Math.pow(2, n);
}

// Exact two-sided sign-test p-value under the null P(diff>0)=0.5.
function signTestP(wins, n) {
  const w = Math.max(wins, n - wins);
  let p = 0;
  for (let k = w; k <= n; k += 1) p += binomPmf(k, n);
  return Math.min(1, 2 * p);
}

function collectWindows(windows) {
  const byId = new Map();
  const duplicates = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || !finite(w.windowId)) continue;
    if (byId.has(w.windowId)) duplicates.push(w.windowId);
    byId.set(w.windowId, w);
  }
  return { byId, duplicates: [...new Set(duplicates)] };
}

function comparePairedWindows(championWindows, challengerWindows, options = {}) {
  const base = {
    artifact: ARTIFACT,
    researchOnly: true,
    executionAuthority: 'NONE',
  };
  const minWindows = finite(options.minWindows) ? options.minWindows : DEFAULT_MIN_WINDOWS;
  const resamples = finite(options.resamples) ? options.resamples : DEFAULT_RESAMPLES;
  const seed = finite(options.seed) ? options.seed : DEFAULT_SEED;
  const confidence = finite(options.confidence) ? options.confidence : 0.95;

  const champ = collectWindows(championWindows);
  const chall = collectWindows(challengerWindows);
  const unpaired = [...champ.byId.keys()].filter((id) => !chall.byId.has(id))
    .concat([...chall.byId.keys()].filter((id) => !champ.byId.has(id)));
  if (unpaired.length > 0 || champ.duplicates.length > 0 || chall.duplicates.length > 0) {
    return {
      ...base,
      status: 'UNPAIRED_EVIDENCE',
      unpairedWindowIds: unpaired,
      duplicateWindowIds: { champion: champ.duplicates, challenger: chall.duplicates },
      reason: 'Champion and Challenger windows must cover identical decision windows before any comparison is valid',
    };
  }

  const ids = [...champ.byId.keys()].sort((a, b) => a - b);
  const diffs = [];
  const missingMetric = [];
  for (const id of ids) {
    const c = champ.byId.get(id);
    const h = chall.byId.get(id);
    if (!finite(c.netPnlUsd) || !finite(h.netPnlUsd)) { missingMetric.push(id); continue; }
    diffs.push(h.netPnlUsd - c.netPnlUsd);
  }
  if (missingMetric.length > 0) {
    return { ...base, status: 'MISSING_MEASUREMENT', windowsWithoutNetPnl: missingMetric };
  }

  const n = diffs.length;
  const meanDiff = n ? diffs.reduce((a, b) => a + b, 0) / n : null;
  const champMetrics = portfolioMetrics([...champ.byId.values()].filter((w) => finite(w.netPnlUsd)));
  const challMetrics = portfolioMetrics([...chall.byId.values()].filter((w) => finite(w.netPnlUsd)));

  if (n < minWindows) {
    return {
      ...base,
      status: 'INSUFFICIENT_SAMPLE',
      windows: n,
      minWindowsRequired: minWindows,
      champion: champMetrics,
      challenger: challMetrics,
      meanPairedDiffUsd: meanDiff === null ? null : Number(meanDiff.toFixed(4)),
      reason: 'Descriptive statistics only: the window sample cannot support a comparative conclusion',
    };
  }

  // Deterministic paired bootstrap of the mean difference.
  const rand = mulberry32(seed);
  const means = [];
  for (let i = 0; i < resamples; i += 1) {
    let s = 0;
    for (let j = 0; j < n; j += 1) s += diffs[Math.floor(rand() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const low = percentile(means, alpha * 100);
  const high = percentile(means, (1 - alpha) * 100);
  const positiveWins = diffs.filter((d) => d > 0).length;
  const negativeWins = diffs.filter((d) => d < 0).length;
  const signP = signTestP(positiveWins, positiveWins + negativeWins);

  let verdict = 'NOT_DISTINGUISHABLE';
  if (low > 0) verdict = 'CHALLENGER_ADVANTAGE';
  else if (high < 0) verdict = 'CHAMPION_ADVANTAGE';

  return {
    ...base,
    status: 'MEASURED',
    windows: n,
    champion: champMetrics,
    challenger: challMetrics,
    meanPairedDiffUsd: Number(meanDiff.toFixed(4)),
    bootstrap: {
      resamples, seed, confidence,
      ciLowDiffUsd: Number(low.toFixed(4)),
      ciHighDiffUsd: Number(high.toFixed(4)),
      ciExcludesZero: low > 0 || high < 0,
    },
    signTest: {
      windowsChallengerBetter: positiveWins,
      windowsChampionBetter: negativeWins,
      exactTwoSidedP: Number(signP.toFixed(6)),
    },
    verdict,
    interpretationRule: 'A verdict requires the paired-difference CI to exclude zero AND at least the minimum window count. It is not a profitability claim and grants no execution authority.',
    caveats: [
      'Overlapping or correlated USD-grouped windows inflate significance; window construction must enforce non-overlapping holding exposure.',
      'Costs must be broker-observed on BOTH sides, not internal paper estimates, before any verdict supports promotion.',
    ],
  };
}

module.exports = { comparePairedWindows, signTestP, ARTIFACT };
