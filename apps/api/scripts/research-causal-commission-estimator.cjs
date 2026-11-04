'use strict';

// Research-only: no broker orders, user state or execution imports.
const MIN_PRIOR = 5;
const LOOKBACK_MS = 7 * 86400_000;
function finite(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function when(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = new Date(x).getTime();
  return Number.isFinite(n) ? n : null;
}
function percentile(values, p) {
  if (!Array.isArray(values) || !values.length || !(p >= 0 && p <= 1)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index),
    hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
function commissionShadowAtEntry(candidate, history, options = {}) {
  const minPrior = options.minPrior ?? MIN_PRIOR;
  const lookbackMs = options.lookbackMs ?? LOOKBACK_MS;
  if (
    !Number.isInteger(minPrior) ||
    minPrior < 5 ||
    minPrior > 200 ||
    !Number.isFinite(lookbackMs) ||
    lookbackMs <= 0 ||
    lookbackMs > LOOKBACK_MS
  ) {
    throw new Error('INVALID_RESEARCH_CONFIG');
  }
  const entryAt = when(candidate.openedAt);
  const lots = finite(candidate.lots);
  const initialRisk = finite(candidate.initialCashRisk);
  const accountCurrency = String(candidate.accountCurrency || '').toUpperCase();
  const instrument = String(candidate.instrument || '').toUpperCase();
  const brokerConnectionId = String(candidate.brokerConnectionId || '');
  if (
    entryAt === null ||
    lots === null ||
    lots <= 0 ||
    initialRisk === null ||
    initialRisk <= 0 ||
    !accountCurrency ||
    !instrument ||
    !brokerConnectionId
  ) {
    return { state: 'INVALID_CANDIDATE', historicalCount: 0, predictedCommissionR: null };
  }
  const available = history
    .filter((trade) => {
      const closedAt = when(trade.closedAt),
        historicalLots = finite(trade.lots);
      const recordedCommission = finite(trade.commission);
      return (
        closedAt !== null &&
        closedAt < entryAt &&
        closedAt >= entryAt - lookbackMs &&
        historicalLots !== null &&
        historicalLots > 0 &&
        recordedCommission !== null &&
        String(trade.accountCurrency || '').toUpperCase() === accountCurrency &&
        String(trade.instrument || '').toUpperCase() === instrument &&
        String(trade.brokerConnectionId || '') === brokerConnectionId
      );
    })
    .map((trade) => Math.abs(finite(trade.commission)) / finite(trade.lots));
  if (available.length < minPrior) {
    return {
      state: 'INSUFFICIENT_HISTORY',
      historicalCount: available.length,
      predictedCommissionR: null,
    };
  }
  const p90CommissionPerLot = percentile(available, 0.9);
  const predictedCommission = p90CommissionPerLot * lots;
  const predictedCommissionR = predictedCommission / initialRisk;
  const preExistingExpectedNetR = finite(candidate.preExistingExpectedNetR);
  return {
    state: 'SHADOW_ESTIMATE',
    historicalCount: available.length,
    costSource: 'STRICTLY_PRIOR_CLOSED_TRADES_P90_PER_LOT',
    p90CommissionPerLot,
    predictedCommission,
    predictedCommissionR,
    predictedAfterCommissionR:
      preExistingExpectedNetR === null ? null : preExistingExpectedNetR - predictedCommissionR,
  };
}
function backtestCommissionShadow(trades, options = {}) {
  if (!Array.isArray(trades) || trades.length > 2000) throw new Error('INVALID_HISTORY_LENGTH');
  const accounts = new Set(trades.map((t) => String(t.brokerConnectionId || '')));
  if (accounts.size !== 1 || accounts.has('')) throw new Error('MIXED_OR_UNSCOPED_ACCOUNTS');
  const sorted = [...trades].sort((a, b) => when(a.openedAt) - when(b.openedAt));
  const evaluated = [];
  for (const candidate of sorted) {
    const result = commissionShadowAtEntry(candidate, sorted, options);
    if (result.state !== 'SHADOW_ESTIMATE') continue;
    const risk = finite(candidate.initialCashRisk);
    const commission = finite(candidate.commission);
    if (commission === null || risk === null || risk <= 0) continue;
    evaluated.push({
      instrument: String(candidate.instrument).toUpperCase(),
      accountCurrency: String(candidate.accountCurrency).toUpperCase(),
      predictedR: result.predictedCommissionR,
      actualR: Math.abs(commission) / risk,
      expectedAfterCommissionR: result.predictedAfterCommissionR,
    });
  }
  const perPair = {};
  for (const v of evaluated) {
    const key = v.accountCurrency + ' | ' + v.instrument;
    const g = (perPair[key] ??= {
      n: 0,
      sumPredictionR: 0,
      sumActualR: 0,
      sumAbsoluteErrorR: 0,
      belowExpectedNet008: 0,
      expectedNetSamples: 0,
    });
    g.n++;
    g.sumPredictionR += v.predictedR;
    g.sumActualR += v.actualR;
    g.sumAbsoluteErrorR += Math.abs(v.predictedR - v.actualR);
    if (v.expectedAfterCommissionR !== null) {
      g.expectedNetSamples++;
      if (v.expectedAfterCommissionR < 0.08) g.belowExpectedNet008++;
    }
  }
  const summary = Object.fromEntries(
    Object.entries(perPair).map(([name, g]) => [
      name,
      {
        historicalSamples: g.n,
        meanForecastCommissionR: +(g.sumPredictionR / g.n).toFixed(4),
        meanObservedCommissionR: +(g.sumActualR / g.n).toFixed(4),
        meanAbsoluteErrorR: +(g.sumAbsoluteErrorR / g.n).toFixed(4),
        expectedNetSamples: g.expectedNetSamples,
        shadowBelow008R: g.belowExpectedNet008,
      },
    ]),
  );
  return {
    artifact: 'causal-commission-per-lot-shadow-v1',
    researchOnly: true,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    minPrior: options.minPrior ?? MIN_PRIOR,
    evaluated: evaluated.length,
    byPair: summary,
    warning:
      'Historical selected DEMO trades only. Fees are predicted using earlier closed trades; hypothetical threshold outcomes are not causal realized savings or approved execution vetoes.',
  };
}
module.exports = {
  MIN_PRIOR,
  LOOKBACK_MS,
  percentile,
  commissionShadowAtEntry,
  backtestCommissionShadow,
};
