'use strict';

// Independent research artifact: evaluation metrics for Champion-Challenger
// comparison (iRexPro AI V2 research). Pure math over SYNTHETIC fixtures only.
// No private per-trade observations, account identifiers, credentials, database
// access, model execution, broker calls, deployment or trading authority.
//
// Purpose: enforce the evaluation criteria of the V2 research charter:
//   - net after-cost returns, risk-normalized expectancy, maximum drawdown,
//     profit factor, prediction calibration, performance stability,
//     sample sufficiency and uncertainty
//   - win rate alone is NEVER a qualification gate.
// Thresholds are NOT assumed: every gate limit is supplied by the caller as a
// pre-registered policy; defaults below restate published project gates
// (docs/integrations/vps-twelvedata-paper-evidence.md: PF >= 1.15,
// Sharpe >= 1.0, max drawdown <= 12%) and are marked with provenance.

const Z95 = 1.959963984540054;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const DEFAULT_POLICY = Object.freeze({
  // Re-registered published project gates. Callers must pass their own
  // pre-registered policy for any real evaluation; defaults are research
  // references only and never authorize anything.
  minTrades: 100,
  profitFactorFloor: 1.15,
  sharpeFloor: 1.0,
  maxDrawdownCap: 0.12, // fraction of cumulative R budget (12%)
  eceCeiling: 0.10, // expected calibration error ceiling
  minDetectableEffect: 0.10, // R units for sufficiency planning
  stabilitySegments: 4,
  stabilityMinPositiveFraction: 0.6,
  policySource: 'vps-twelvedata-paper-evidence.md (published gates, research reference)',
});

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** Validate one settled decision record. */
function validateDecision(d, idx) {
  const errs = [];
  const p = (k) => errs.push(`decision[${idx}].${k}`);
  if (d === null || typeof d !== 'object') { return ['decision[' + idx + ']: not an object']; }
  if (!['string', 'undefined'].includes(typeof d.engineId)) p('engineId');
  if (!['string', 'undefined'].includes(typeof d.instrument)) p('instrument');
  if (!['BUY', 'SELL'].includes(d.direction)) p('direction');
  if (!(d.entryTime instanceof Date) && typeof d.entryTime !== 'string') p('entryTime');
  if (!finite(d.predictedWinProbability) || d.predictedWinProbability < 0 || d.predictedWinProbability > 1) p('predictedWinProbability');
  if (!finite(d.predictedExpectedR)) p('predictedExpectedR');
  if (!finite(d.realizedNetR)) p('realizedNetR');
  if (d.exitTime !== undefined && !(d.exitTime instanceof Date) && typeof d.exitTime !== 'string') p('exitTime');
  return errs;
}

/** Chronological separation check: sorted entries and flagged overlaps. */
function chronologicalIssues(decisions) {
  const issues = [];
  const ts = decisions.map((d) => new Date(d.entryTime).getTime());
  for (let i = 1; i < ts.length; i++) {
    if (!(ts[i] > ts[i - 1])) issues.push({ kind: 'UNSORTED_OR_DUPLICATE_ENTRY_TIME', index: i });
  }
  // Overlapping exposure on the same instrument is a bias risk (correlated
  // observations); it is reported, never silently accepted.
  const byInstrument = new Map();
  decisions.forEach((d, i) => {
    const exitTs = d.exitTime !== undefined ? new Date(d.exitTime).getTime() : ts[i] + 1;
    const entryTs = ts[i];
    if (!byInstrument.has(d.instrument)) byInstrument.set(d.instrument, []);
    byInstrument.get(d.instrument).forEach((o) => {
      if (entryTs < o.exitTs && o.entryTs < exitTs) {
        issues.push({ kind: 'OVERLAPPING_EXPOSURE', instrument: d.instrument, index: i, overlapIndex: o.index });
      }
    });
    byInstrument.get(d.instrument).push({ entryTs, exitTs, index: i });
  });
  return issues;
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stdev(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

function wilsonInterval(k, n, z = Z95) {
  if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(k) || k < 0 || k > n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, ci95: [(center - half) / denom, (center + half) / denom] };
}

/** Hanley-McNeil AUC with standard error (respects tied ranks). */
function aucWithSe(labels, scores) {
  const n = labels.length;
  if (n < 2) return { auc: NaN, se: NaN, nPos: 0, nNeg: 0 };
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  let i = 0;
  const labelsSorted = order.map((o) => labels[o.i]);
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1].s === order[i].s) j++;
    const avgRank = (i + j + 2) / 2; // 1-based average rank of the tie group
    for (let k = i; k <= j; k++) if (labelsSorted[k] === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  const nPos = labels.reduce((a, b) => a + b, 0);
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return { auc: NaN, se: NaN, nPos, nNeg };
  const auc = (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  // Mann-Whitney null-variance SE (Hanley-McNeil under H0, used for the
  // AUC != 0.5 test). Tied scores share midranks above, which reduces the
  // rank variance; the H0 form is the conservative (larger) SE.
  const varRank = (nPos * nNeg * (nPos + nNeg + 1)) / 12;
  const se = Math.sqrt(varRank) / (nPos * nNeg);
  return { auc, se, nPos, nNeg };
}

/** Brier score and equal-width binned ECE (expected calibration error). */
function calibrationMetrics(decisions, bins = 10) {
  const n = decisions.length;
  if (n === 0) return { brier: NaN, ece: NaN, bins: [] };
  let brier = 0;
  const buckets = Array.from({ length: bins }, () => ({ k: 0, n: 0, pSum: 0 }));
  decisions.forEach((d) => {
    const y = d.realizedNetR > 0 ? 1 : 0;
    brier += (d.predictedWinProbability - y) ** 2;
    const b = Math.min(bins - 1, Math.floor(d.predictedWinProbability * bins));
    buckets[b].n += 1;
    buckets[b].k += y;
    buckets[b].pSum += d.predictedWinProbability;
  });
  let ece = 0;
  const binRows = [];
  buckets.forEach((b, i) => {
    if (b.n === 0) return;
    const pAvg = b.pSum / b.n;
    const obs = b.k / b.n;
    ece += (b.n / n) * Math.abs(obs - pAvg);
    binRows.push({ bin: i, n: b.n, avgPredicted: pAvg, observed: obs });
  });
  return { brier: brier / n, ece, bins: binRows };
}

/** Maximum drawdown on the cumulative realized R curve (in R units). */
function maxDrawdownR(realized) {
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  realized.forEach((r) => {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  });
  return { maxDd, terminalR: cum, peakR: peak };
}

/** Chronological stability: sign consistency of segment mean R. */
function stability(decisions, segments) {
  if (decisions.length < segments * 2) return { evaluated: false, reason: 'TOO_FEW' };
  const segSize = Math.floor(decisions.length / segments);
  const segs = [];
  for (let i = 0; i < segments; i++) {
    const slice = decisions.slice(i * segSize, (i + 1) * segSize);
    segs.push({ index: i, n: slice.length, meanR: mean(slice.map((d) => d.realizedNetR)) });
  }
  const positiveFraction = segs.filter((s) => s.meanR > 0).length / segs.length;
  return { evaluated: true, segments: segs, positiveFraction };
}

/** Sample sufficiency: trades needed to detect a given mean-R effect. */
function sampleSufficiency(decisions, mde) {
  const n = decisions.length;
  if (n < 2) return { n, requiredN: NaN, sufficient: false, stdev: NaN };
  const sd = stdev(decisions.map((d) => d.realizedNetR));
  if (!(sd > 0)) return { n, requiredN: Infinity, sufficient: false, stdev: sd };
  const requiredN = Math.ceil(((Z95 * sd) / mde) ** 2);
  return { n, requiredN, sufficient: n >= requiredN, stdev: sd };
}

/**
 * Full evaluation report. The verdict has four states; a verdict of
 * QUALIFIED_FOR_REVIEW is an ANALYTICAL classification over the supplied
 * synthetic fixtures and pre-registered policy only. It is never trading,
 * promotion or deployment authority, and win rate is never a gate input.
 */
function evaluate(decisionsInput, policyInput) {
  const policy = Object.freeze({ ...DEFAULT_POLICY, ...(policyInput || {}) });
  const errors = [];
  if (!Array.isArray(decisionsInput) || decisionsInput.length === 0) {
    return { status: 'NO_SETTLED_DECISIONS', errors: ['decisions empty'], policy };
  }
  decisionsInput.forEach((d, i) => errors.push(...validateDecision(d, i)));
  if (errors.length) return { status: 'INVALID_INPUT', errors, policy };
  const decisions = clone(decisionsInput);
  const chrono = chronologicalIssues(decisions);
  const realized = decisions.map((d) => d.realizedNetR);
  const wins = realized.filter((r) => r > 0);
  const losses = realized.filter((r) => r < 0);
  const n = realized.length;
  const meanR = mean(realized);
  const sdR = stdev(realized);
  const netR = realized.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN;
  // Risk-normalized expectancy (per-trade Sharpe analogue, chronological).
  const riskNormExpectancy = sdR > 0 ? meanR / sdR : NaN;
  const sharpe = riskNormExpectancy; // same quantity, documented alias
  const drawdown = maxDrawdownR(realized);
  const ddFraction = drawdown.peakR > 0 ? drawdown.maxDd / drawdown.peakR : drawdown.maxDd / Math.max(1, Math.abs(drawdown.terminalR) + drawdown.maxDd);
  const calib = calibrationMetrics(decisions);
  const labels = decisions.map((d) => (d.realizedNetR > 0 ? 1 : 0));
  const scores = decisions.map((d) => d.predictedWinProbability);
  const auc = aucWithSe(labels, scores);
  const stab = stability(decisions, policy.stabilitySegments);
  const suff = sampleSufficiency(decisions, policy.minDetectableEffect);
  const winRate = wilsonInterval(wins.length, n);
  const calibGap = mean(decisions.map((d) => d.predictedExpectedR)) - meanR;
  const failures = [];
  if (n < policy.minTrades) failures.push({ gate: 'SAMPLE_SIZE', detail: `${n} < ${policy.minTrades}` });
  if (!(profitFactor >= policy.profitFactorFloor)) failures.push({ gate: 'PROFIT_FACTOR', detail: `PF ${profitFactor.toFixed(4)} < ${policy.profitFactorFloor}` });
  if (!(sharpe >= policy.sharpeFloor)) failures.push({ gate: 'RISK_NORMALIZED_EXPECTANCY', detail: `sharpe ${sharpe} < ${policy.sharpeFloor}` });
  if (!(drawdown.maxDd <= policy.maxDrawdownCap * Math.max(1, drawdown.peakR + Math.abs(drawdown.terminalR)))) failures.push({ gate: 'MAX_DRAWDOWN', detail: `maxDD R ${drawdown.maxDd.toFixed(3)}` });
  if (!(calib.ece <= policy.eceCeiling)) failures.push({ gate: 'CALIBRATION', detail: `ECE ${calib.ece.toFixed(4)} > ${policy.eceCeiling}` });
  if (stab.evaluated && !(stab.positiveFraction >= policy.stabilityMinPositiveFraction)) failures.push({ gate: 'STABILITY', detail: `positive segments ${stab.positiveFraction} < ${policy.stabilityMinPositiveFraction}` });
  if (!suff.sufficient) failures.push({ gate: 'SUFFICIENCY', detail: `n ${suff.n} < required ${suff.requiredN} for MDE ${policy.minDetectableEffect}R` });
  const status = failures.length === 0 ? 'QUALIFIED_FOR_REVIEW' : 'GATE_FAILURES';
  return {
    status,
    policy,
    failures,
    metrics: {
      settledTrades: n,
      wins: wins.length,
      losses: losses.length,
      winRate, // reported for context; NEVER a gate
      netAfterCostR: netR,
      meanR,
      stdevR: sdR,
      riskNormalizedExpectancy: riskNormExpectancy,
      sharpe,
      profitFactor,
      grossWinR: grossWin,
      grossLossR: grossLoss,
      maxDrawdownR: drawdown.maxDd,
      drawdownFraction: ddFraction,
      terminalR: drawdown.terminalR,
      calibration: { brier: calib.brier, ece: calib.ece, reliabilityBins: calib.bins, auc },
      predictedVsRealizedGapR: calibGap,
      stability: stab,
      sufficiency: suff,
    },
    chronology: { issues: chrono, overlapCount: chrono.filter((c) => c.kind === 'OVERLAPPING_EXPOSURE').length },
    caveats: [
      'Win rate is descriptive only and is never a qualification gate.',
      'Results are computed over the supplied fixture set; they carry no external validity.',
      'Overlapping same-instrument exposure and correlated pairs are reported as bias risks, not corrected.',
    ],
  };
}

module.exports = {
  DEFAULT_POLICY,
  evaluate,
  wilsonInterval,
  aucWithSe,
  calibrationMetrics,
  maxDrawdownR,
  stability,
  sampleSufficiency,
  chronologicalIssues,
};
