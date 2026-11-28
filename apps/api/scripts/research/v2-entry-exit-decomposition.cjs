'use strict';
/**
 * V2 entry-vs-exit decomposition contract. The directive requires entry
 * intelligence and exit management to be assessed SEPARATELY. This module
 * decomposes a settled trade's realized R into the design payoff, the
 * exit-management delta (win truncation / loss extension, in R) and the
 * cost drag (in R), preserving the identity:
 *
 *   realizedNetR + winTruncationR + lossExtensionR + costDragR
 *     = designPayoffR            (+designTargetR win / -1R loss)
 *
 * Research-only. Missing stop distance is a typed refusal, never a guess.
 * Never grants order authority.
 */

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const DIRECTIONS = new Set(['BUY', 'SELL']);

/**
 * Decompose one settled trade.
 * Input (price units): direction, entryPrice, exitPrice, stopDistance
 * (absolute price distance of the protective stop), designTargetR
 * (intended reward multiple, e.g. 1.6), costs in R units:
 * commissionR, swapR, spreadR (each >= 0, fractions of the stop distance).
 */
function decomposeTradeOutcome(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('DECOMPOSITION_INPUT_REQUIRED');
  }
  const {
    direction, entryPrice, exitPrice, stopDistance, designTargetR,
    commissionR = 0, swapR = 0, spreadR = 0,
  } = input;
  if (!DIRECTIONS.has(direction)) {
    throw new Error('DECOMPOSITION_DIRECTION_INVALID');
  }
  if (!finiteNumber(entryPrice) || entryPrice <= 0 ||
      !finiteNumber(exitPrice) || exitPrice <= 0) {
    throw new Error('DECOMPOSITION_PRICES_INVALID');
  }
  if (!finiteNumber(stopDistance) || stopDistance <= 0) {
    throw new Error('DECOMPOSITION_MISSING_STOP_DISTANCE');
  }
  if (!finiteNumber(designTargetR) || designTargetR <= 0) {
    throw new Error('DECOMPOSITION_DESIGN_TARGET_INVALID');
  }
  for (const [name, value] of [['commissionR', commissionR],
    ['swapR', swapR], ['spreadR', spreadR]]) {
    if (!finiteNumber(value) || value < 0) {
      throw new Error(`DECOMPOSITION_${name.toUpperCase()}_INVALID`);
    }
  }
  const sign = direction === 'BUY' ? 1 : -1;
  const realizedGrossR = (sign * (exitPrice - entryPrice)) / stopDistance;
  const costDragR = commissionR + swapR + spreadR;
  const realizedNetR = realizedGrossR - costDragR;
  let winTruncationR = 0;
  let lossExtensionR = 0;
  let designPayoffR;
  if (realizedGrossR >= 0) {
    designPayoffR = designTargetR;
    // Signed: positive = win cut short of design; negative = win exceeded design.
    winTruncationR = designTargetR - realizedGrossR;
  } else {
    designPayoffR = -1;
    // Positive = loss extended beyond the designed 1R.
    lossExtensionR = Math.abs(realizedGrossR) - 1;
  }
  return Object.freeze({
    realizedGrossR,
    costDragR,
    realizedNetR,
    designPayoffR,
    winTruncationR,
    lossExtensionR,
    identityHolds: Math.abs(
      (realizedNetR + winTruncationR + lossExtensionR + costDragR) - designPayoffR,
    ) < 1e-9,
  });
}

/**
 * Cohort-level decomposition: totals, means and the ranked shares of the
 * three deficit channels (win truncation, loss extension, cost drag).
 * Trades use the same input shape as decomposeTradeOutcome.
 */
function decomposeCohort(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    throw new Error('DECOMPOSITION_COHORT_EMPTY');
  }
  const rows = trades.map((t) => decomposeTradeOutcome(t));
  const n = rows.length;
  const wins = rows.filter((r) => r.realizedGrossR >= 0);
  const losses = rows.filter((r) => r.realizedGrossR < 0);
  const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);
  const totalWinTruncationR = sum((r) => Math.max(0, r.winTruncationR));
  const totalLossExtensionR = sum((r) => r.lossExtensionR);
  const totalCostDragR = sum((r) => r.costDragR);
  const totalDesignPayoffR = sum((r) => r.designPayoffR);
  const totalRealizedNetR = sum((r) => r.realizedNetR);
  return Object.freeze({
    n,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: wins.length / n,
    totalRealizedNetR,
    totalDesignPayoffR,
    totalWinTruncationR,
    totalLossExtensionR,
    totalCostDragR,
    meanRealizedNetR: totalRealizedNetR / n,
    avgWinR: wins.length > 0
      ? wins.reduce((s, r) => s + r.realizedNetR, 0) / wins.length : null,
    avgLossR: losses.length > 0
      ? losses.reduce((s, r) => s + r.realizedNetR, 0) / losses.length : null,
    payoffRatio: wins.length > 0 && losses.length > 0
      ? (wins.reduce((s, r) => s + r.realizedNetR, 0) / wins.length) /
        Math.abs(losses.reduce((s, r) => s + r.realizedNetR, 0) / losses.length)
      : null,
    decomposition: Object.freeze(
      classifyEconomicDeficit({
        totalWinTruncationR, totalLossExtensionR, totalCostDragR,
      }),
    ),
    identityHoldsForAll: rows.every((r) => r.identityHolds),
  });
}

/**
 * Rank the three deficit channels by their share of the total deficit
 * budget. MIXED when the top two channels are within 5 percentage points.
 */
function classifyEconomicDeficit({ totalWinTruncationR, totalLossExtensionR, totalCostDragR }) {
  const channels = {
    WIN_TRUNCATION: totalWinTruncationR,
    LOSS_EXTENSION: totalLossExtensionR,
    COST_DRAG: totalCostDragR,
  };
  for (const value of Object.values(channels)) {
    if (!finiteNumber(value) || value < 0) {
      throw new Error('DEFICIT_INPUT_INVALID');
    }
  }
  const total = channels.WIN_TRUNCATION + channels.LOSS_EXTENSION + channels.COST_DRAG;
  if (total <= 0) {
    return Object.freeze({
      dominant: 'NONE', ranked: [], shares: Object.freeze({}),
      note: 'No deficit observed in R budget.',
    });
  }
  const shares = {};
  for (const [name, value] of Object.entries(channels)) {
    shares[name] = value / total;
  }
  const ranked = Object.entries(channels)
    .sort((x, y) => y[1] - x[1])
    .map(([name]) => name);
  const top = shares[ranked[0]];
  const second = shares[ranked[1]];
  const dominant = top - second < 0.05 ? 'MIXED' : ranked[0];
  return Object.freeze({
    dominant,
    ranked: Object.freeze(ranked),
    shares: Object.freeze(shares),
    note: 'Unit: R (fractions of the initial stop distance). Shares are of ' +
      'the total observed deficit budget, not of gross return.',
  });
}

module.exports = {
  decomposeTradeOutcome,
  decomposeCohort,
  classifyEconomicDeficit,
};
