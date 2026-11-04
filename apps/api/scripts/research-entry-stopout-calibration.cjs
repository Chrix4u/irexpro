'use strict';

// Pure research only: no broker, trade-execution or database-writer imports.
const ARTIFACT = 'entry-stopout-calibration-shadow-v1';
const MAX_ROWS = 2000;
const PURGE_MS = 60 * 60 * 1000;
function numberOrNull(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function time(x) {
  if (x === null || x === undefined || x === '') return null;
  const ms = new Date(x).getTime();
  return Number.isFinite(ms) ? ms : null;
}
function confidenceBin(value) {
  if (value === null) return 'UNKNOWN';
  if (value < 0.6) return '<0.60';
  if (value < 0.7) return '0.60-0.69';
  return '>=0.70';
}
function extensionBin(value) {
  if (value === null) return 'UNKNOWN';
  if (value < 0.75) return '<0.75_ATR';
  if (value <= 1.25) return '0.75-1.25_ATR';
  return '>1.25_ATR';
}
function wilson(k, n, z = 1.96) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) return null;
  const p = k / n,
    z2 = z * z,
    denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lower: +Math.max(0, center - margin).toFixed(4),
    upper: +Math.min(1, center + margin).toFixed(4),
  };
}
function normalize(row) {
  const opened = time(row.openedAt),
    closed = time(row.closedAt);
  const risk = numberOrNull(row.finalRiskAtStop);
  const gross = numberOrNull(row.realisedPnl);
  const commission = numberOrNull(row.commission);
  const swap = numberOrNull(row.swap);
  const confidence = numberOrNull(row.confidenceScore);
  const extension = numberOrNull(row.extensionAtr);
  const m1ExpectedR = numberOrNull(row.preEntryExpectedR);
  const stop = String(row.closeReason || '') === 'STOP_LOSS_HIT';
  const valid =
    opened !== null &&
    closed !== null &&
    closed >= opened &&
    risk !== null &&
    risk > 0 &&
    gross !== null &&
    commission !== null &&
    swap !== null &&
    ['BUY', 'SELL'].includes(row.direction) &&
    String(row.instrument || '').length > 0 &&
    String(row.accountCurrency || '').length > 0;
  return {
    opened,
    closed,
    valid,
    instrument: String(row.instrument || '').toUpperCase(),
    direction: row.direction,
    accountCurrency: String(row.accountCurrency || '').toUpperCase(),
    route: String(row.route || 'UNKNOWN').toUpperCase(),
    regime: String(row.marketRegime || 'UNKNOWN').toUpperCase(),
    engine: String(row.engine || 'UNKNOWN'),
    closeReason: String(row.closeReason || 'UNKNOWN'),
    stop,
    netR: valid ? (gross - Math.abs(commission) + swap) / risk : null,
    grossR: valid ? gross / risk : null,
    feeR: valid ? Math.abs(commission) / risk : null,
    confidence,
    extension,
    m1ExpectedR,
    confidenceBin: confidenceBin(confidence),
    extensionBin: extensionBin(extension),
  };
}
function report(rows) {
  const valid = rows.filter((x) => x.valid);
  const n = valid.length,
    stopouts = valid.filter((x) => x.stop).length;
  const sum = (k) => valid.reduce((v, x) => v + x[k], 0);
  const netR = n ? sum('netR') / n : null,
    grossR = n ? sum('grossR') / n : null,
    feeR = n ? sum('feeR') / n : null;
  return {
    total: rows.length,
    matched: n,
    invalid: rows.length - n,
    stopouts,
    stopoutRate: n ? +(stopouts / n).toFixed(4) : null,
    stopout95pctWilson: wilson(stopouts, n),
    meanNetR: netR === null ? null : +netR.toFixed(4),
    meanGrossR: grossR === null ? null : +grossR.toFixed(4),
    meanCommissionR: feeR === null ? null : +feeR.toFixed(4),
    netWinners: valid.filter((x) => x.netR > 0).length,
    netLosers: valid.filter((x) => x.netR < 0).length,
    meanPreEntryExpectedR: (() => {
      const a = valid.map((x) => x.m1ExpectedR).filter((x) => x !== null);
      return a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(4) : null;
    })(),
  };
}
function group(rows, getKey) {
  return Object.fromEntries(
    [...Map.groupBy(rows, getKey)]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, items]) => [key, report(items)]),
  );
}
function analyze(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('INVALID_RESEARCH_ROW_LIMIT');
  const normalized = rows
    .map(normalize)
    .sort((a, b) => (a.opened ?? Infinity) - (b.opened ?? Infinity));
  const valid = normalized.filter((x) => x.valid);
  const cutoffIndex = Math.floor(valid.length * 0.7);
  const trainCutoff = cutoffIndex > 0 ? valid[cutoffIndex - 1].opened : null;
  const cutoff = cutoffIndex < valid.length ? valid[cutoffIndex].opened : null;
  const train = valid.filter(
    (x) => trainCutoff !== null && x.opened <= trainCutoff && x.closed <= trainCutoff,
  );
  const holdout = valid.filter(
    (x) => cutoff !== null && x.opened >= cutoff + PURGE_MS && x.closed !== null,
  );
  const excludedPurge = valid.length - train.length - holdout.length;
  const minGroup = options.minGroup ?? 10;
  if (!Number.isInteger(minGroup) || minGroup < 10 || minGroup > 500)
    throw new Error('INVALID_MIN_GROUP');
  const grouped = (slice) => ({
    byRoute: group(slice, (x) => x.accountCurrency + ' | ' + x.route),
    byPairSide: group(slice, (x) => x.accountCurrency + ' | ' + x.instrument + '/' + x.direction),
    byRouteConfidence: group(
      slice,
      (x) => x.accountCurrency + ' | ' + x.route + '/' + x.confidenceBin,
    ),
    byRouteExtension: group(
      slice,
      (x) => x.accountCurrency + ' | ' + x.route + '/' + x.extensionBin,
    ),
    byEngineRoute: group(slice, (x) => x.accountCurrency + ' | ' + x.engine + '/' + x.route),
    byRouteRegime: group(slice, (x) => x.accountCurrency + ' | ' + x.route + '/' + x.regime),
    byRouteExitReason: group(
      slice,
      (x) => x.accountCurrency + ' | ' + x.route + '/' + x.closeReason,
    ),
  });
  const trainGroups = grouped(train),
    holdoutGroups = grouped(holdout);
  const qualifying = Object.entries(trainGroups.byRouteConfidence).filter(
    ([, v]) => v.matched >= minGroup,
  );
  const heldOutComparisons = qualifying.map(([name, v]) => {
    const other = holdoutGroups.byRouteConfidence[name] ?? null;
    return {
      cohort: name,
      researchTrainSample: v.matched,
      researchTrainStopoutRate: v.stopoutRate,
      researchTrainMeanNetR: v.meanNetR,
      unseenHoldoutSample: other?.matched ?? 0,
      unseenHoldoutStopoutRate: other?.stopoutRate ?? null,
      unseenHoldoutMeanNetR: other?.meanNetR ?? null,
      eligibleForExecution: false,
    };
  });
  return {
    artifact: ARTIFACT,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    researchOnly: true,
    promotionEligible: false,
    entireCohort: report(normalized),
    chronologicalSplit: {
      trainFractionTarget: 0.7,
      purgeMinutes: PURGE_MS / 60000,
      trainCutoffAt: trainCutoff === null ? null : new Date(trainCutoff).toISOString(),
      holdoutAfter: cutoff === null ? null : new Date(cutoff + PURGE_MS).toISOString(),
      trainSamples: train.length,
      holdoutSamples: holdout.length,
      excludedForPurgeOrOverlap: excludedPurge,
    },
    train: trainGroups,
    holdout: holdoutGroups,
    heldOutRouteConfidenceComparisons: heldOutComparisons,
    warnings: [
      'This is a small, selected set of closed executed DEMO trades, not the complete market opportunity distribution.',
      'All group thresholds are fixed descriptive bins; the train sample selects no trading cutoff or executable model.',
      'Non-overlapping chronology purges the 60-minute boundary and ongoing positions; portfolio dependencies remain.',
      'Low-sample cohorts have wide Wilson intervals and cannot establish prospective edge.',
      'No loss guard, lot sizing, market timing, broker order or model promotion is changed.',
    ],
  };
}
module.exports = {
  ARTIFACT,
  PURGE_MS,
  confidenceBin,
  extensionBin,
  wilson,
  normalize,
  report,
  analyze,
};
