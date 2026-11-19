/**
 * Descriptive, matched-day analysis of owner DEMO M1 research labels.
 * No model changes, brokerage fills, execution authority or automatic
 * promotion. Matching is by instrument / side / Plan-B route / M1 route /
 * UTC market day; causal inference is NOT possible from this cohort.
 */
'use strict';

const DRIFT_STATES = ['NORMAL', 'OUT_OF_DISTRIBUTION'];
const round = n => Number(n.toFixed(4));

function summarize(rows, labelOf, asOfMs) {
  const complete = rows.map(r => labelOf(r, asOfMs)).filter(Boolean);
  const net = complete.map(r => r.netR);
  return {
    episodes: rows.length,
    completedLabels: complete.length,
    missingLabels: rows.length - complete.length,
    coverage: rows.length ? round(complete.length / rows.length) : null,
    meanEstimatedNetR: net.length ? round(net.reduce((a, b) => a + b, 0) / net.length) : null,
  };
}

function compareMatchedDriftDays(selected, labelOf, asOfMs, options = {}) {
  const minSettledPerStateStratum = options.minSettledPerStateStratum ?? 2;
  const minQualifiedStrata = options.minQualifiedStrata ?? 5;
  const minQualifiedDays = options.minQualifiedDays ?? 3;
  const minQualifiedTotalPerState = options.minQualifiedTotalPerState ?? 20;
  const minCoverage = options.minCoverage ?? 0.65;
  const sourceTruncated = options.sourceTruncated === true;

  const byStratum = new Map();
  for (const row of selected) {
    if (!DRIFT_STATES.includes(row.drift)) continue;
    const ms = new Date(row.bar_time).getTime();
    if (!Number.isFinite(ms)) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    const key = [
      day,
      row.instrument,
      row.direction,
      row.strategy_route,
      row.m1_route,
    ].join('|');
    if (!byStratum.has(key)) {
      byStratum.set(key, { key, day, NORMAL: [], OUT_OF_DISTRIBUTION: [] });
    }
    byStratum.get(key)[row.drift].push(row);
  }
  const pairedStrata = [];
  const comparableStrata = [];
  for (const entry of byStratum.values()) {
    if (entry.NORMAL.length === 0 || entry.OUT_OF_DISTRIBUTION.length === 0) continue;
    const normal = summarize(entry.NORMAL, labelOf, asOfMs);
    const outOfDistribution = summarize(entry.OUT_OF_DISTRIBUTION, labelOf, asOfMs);
    const comparable =
      normal.completedLabels >= minSettledPerStateStratum &&
      outOfDistribution.completedLabels >= minSettledPerStateStratum;
    const stratum = {
      key: entry.key,
      marketDay: entry.day,
      normal,
      outOfDistribution,
      comparable,
      oodMinusNormalMeanEstimatedNetR:
        comparable
          ? round(outOfDistribution.meanEstimatedNetR - normal.meanEstimatedNetR)
          : null,
    };
    pairedStrata.push(stratum);
    if (comparable) comparableStrata.push(stratum);
  }
  const days = [...new Set(comparableStrata.map(s => s.marketDay))].sort();
  const pairedEpisodes = state => comparableStrata.reduce(
    (sum, s) => sum + (
      state === 'NORMAL' ? s.normal.completedLabels : s.outOfDistribution.completedLabels
    ), 0,
  );
  const normalLabels = pairedEpisodes('NORMAL');
  const oodLabels = pairedEpisodes('OUT_OF_DISTRIBUTION');
  const normalCoverage = comparableStrata.reduce((s, x) => s + x.normal.completedLabels, 0) /
    (comparableStrata.reduce((s, x) => s + x.normal.episodes, 0) || 1);
  const oodCoverage = comparableStrata.reduce((s, x) => s + x.outOfDistribution.completedLabels, 0) /
    (comparableStrata.reduce((s, x) => s + x.outOfDistribution.episodes, 0) || 1);
  let status = 'DESCRIPTIVE_ONLY_NO_POLICY_AUTHORITY';
  if (sourceTruncated) status = 'SOURCE_TRUNCATED';
  else if (comparableStrata.length === 0) status = 'NO_COMPARABLE_SETTLED_STRATA';
  else if (comparableStrata.length < minQualifiedStrata ||
           normalLabels < minQualifiedTotalPerState ||
           oodLabels < minQualifiedTotalPerState ||
           days.length < minQualifiedDays) status = 'INSUFFICIENT_INDEPENDENT_MARKET_EVIDENCE';
  else if (normalCoverage < minCoverage || oodCoverage < minCoverage)
    status = 'LOW_OUTCOME_COVERAGE';

  const balancedDifference = comparableStrata.length
    ? round(comparableStrata.reduce(
      (s, x) => s + x.oodMinusNormalMeanEstimatedNetR, 0,
    ) / comparableStrata.length)
    : null;

  return {
    artifact: 'owner-demo-matched-drift-shadow-comparison-v1',
    status,
    interpretation: 'DESCRIPTIVE_QUOTE_ONLY_NOT_CAUSAL',
    executionAuthority: 'NONE',
    modelTrainingStatus: 'NOT_TRAINED',
    modifiesExecution: false,
    comparableStrata: comparableStrata.length,
    bothDriftStatesPresentStrata: pairedStrata.length,
    observedComparableDays: days,
    comparableNormalLabels: normalLabels,
    comparableOutOfDistributionLabels: oodLabels,
    normalCoverageInComparableStrata: round(normalCoverage),
    outOfDistributionCoverageInComparableStrata: round(oodCoverage),
    // Equal weight per same-instrument/side/route/day stratum: volume of
    // repeated one-minute scanning must not dominate the comparison.
    balancedOodMinusNormalMeanEstimatedNetR: balancedDifference,
    matchedStrata: pairedStrata.slice(0, 100),
    matchedStrataTruncated: pairedStrata.length > 100,
    limitations: [
      'Matched-day observational quote results do not establish causation or broker executability.',
      'Unlabelled scenarios may be missing non-randomly; compare coverage by state.',
      'All estimates include only shadow-estimated cost, not actual commission/slippage fills.',
      'Evidence cannot promote drift thresholds, reversal models or live trading.',
    ],
  };
}

module.exports = { compareMatchedDriftDays, summarize };
