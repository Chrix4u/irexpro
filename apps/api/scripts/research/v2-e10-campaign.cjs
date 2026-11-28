'use strict';
/**
 * V2 E-10 full-scale evaluation campaign (P3 extension, 2026-11-28).
 *
 * Executes the directive: at least 1,000 independent replays, multiple
 * instruments, realistic market regimes, transaction costs and appropriate
 * uncertainty estimates, plus the walk-forward variant of the paired
 * simulator:
 *
 *   1. null false-positive campaign (>= 1,000 replays, EDGE_ZERO);
 *   2. known-edge detection-power campaign (>= 1,000 trials per target);
 *   3. multi-instrument paired replay matrix — EURUSD + GBPUSD ×
 *      { TREND_REGIMES, EDGE_ZERO, REVERSION, PLANTED_DRIFT } with the
 *      broker-calibrated frozen cost model; per-cell per-replay
 *      aggregation with t-based 95% intervals and typed refusals for
 *      insufficient replay counts (< 30);
 *   4. chronological walk-forward variant — long paths split into folds,
 *      per-fold paired deltas and a cumulative stitched curve; positions
 *      are force-closed at fold boundaries; nothing is re-fitted (the
 *      policies are frozen), so this validates TEMPORAL STABILITY of the
 *      paired delta, not a fitting procedure.
 *
 * Seed discipline: E-10 uses the designated seed families 41xxxxx (cells),
 * 45xxxxx (walk-forward) and 9xxxxxx (null, from runNullCampaign's own
 * base). The ablation campaign uses family 43xxxxx; the final held-out
 * evaluation dataset (family 47xxxxx, not touched by ablations) is
 * reserved for any later decision analysis. Research-only; no order
 * authority; synthetic results are never profitability claims.
 */

const {
  runCampaign,
  runNullCampaign,
  runKnownEdgeCampaign,
} = require('./v2-offline-evaluation-harness.cjs');
const { generateMarketPath } = require('./v2-synthetic-market.cjs');
const { runPairedReplay } = require('./v2-paired-engine-simulator.cjs');
const { evaluateEngineSide } = require('./v2-offline-evaluation-harness.cjs');

const E10_CAMPAIGN_REFUSALS = Object.freeze([
  'E10_REPLAYS_INVALID', 'E10_CELL_INVALID', 'E10_FOLDS_INVALID',
  'E10_SEED_INVALID', 'E10_INSUFFICIENT_REPLAYS',
]);

const Z975 = 1.959964; // two-sided 95% normal quantile

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Mean and normal-approximation 95% interval across independent replays. */
function meanAndInterval95(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('E10_REPLAYS_INVALID');
  }
  const n = samples.length;
  if (n < 30) {
    return Object.freeze({
      n, mean: null, interval95: null,
      refused: 'E10_INSUFFICIENT_REPLAYS:<30 replays is not an estimable cell',
    });
  }
  const mean = samples.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1
    ? samples.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n);
  return Object.freeze({
    n,
    mean,
    se,
    interval95: Object.freeze([mean - Z975 * se, mean + Z975 * se]),
  });
}

/** Aggregate one cell of the multi-instrument matrix. */
function aggregateCell(replayStats) {
  if (!Array.isArray(replayStats) || replayStats.length === 0) {
    throw new Error('E10_CELL_INVALID');
  }
  const pick = (fn) => replayStats.map(fn);
  return Object.freeze({
    replays: replayStats.length,
    championNetR: meanAndInterval95(pick((r) => r.championMeanNetR)),
    challengerNetR: meanAndInterval95(pick((r) => r.challengerMeanNetR)),
    pairedDeltaNetR: meanAndInterval95(pick((r) => r.challengerMeanNetR - r.championMeanNetR)),
    championTradesPerReplay: meanAndInterval95(pick((r) => r.championTrades)),
    challengerTradesPerReplay: meanAndInterval95(pick((r) => r.challengerTrades)),
    challengerTurnoverPer1000Bars: meanAndInterval95(pick((r) =>
      r.challengerTrades / (r.nBars / 1000))),
    championTurnoverPer1000Bars: meanAndInterval95(pick((r) =>
      r.championTrades / (r.nBars / 1000))),
    challengerCostDragR: meanAndInterval95(pick((r) => r.challengerCostDragR)),
    championCostDragR: meanAndInterval95(pick((r) => r.championCostDragR)),
    challengerWinRate: meanAndInterval95(pick((r) => r.challengerWinRate)),
    championWinRate: meanAndInterval95(pick((r) => r.championWinRate)),
    reversalPrecision: meanAndInterval95(pick((r) => r.reversalPrecision)),
    reversalRecall: meanAndInterval95(pick((r) => r.reversalRecall)),
    reversalFalseAlarmShare: meanAndInterval95(pick((r) => r.reversalFalseAlarmShare)),
    commonOpportunityAuc: meanAndInterval95(pick((r) => r.commonOpportunityAuc)),
    abstentionWinRateDelta: meanAndInterval95(pick((r) => r.abstentionWinRateDelta)),
  });
}

/** One replay's summary stats for the matrix (collected per replay). */
function replaySummaryStats(campaign) {
  const nBars = campaign.market.nBars;
  const c = campaign.champion;
  const k = campaign.challenger;
  const reversal = campaign.reversalDetection;
  const ei = campaign.entryIntelligence;
  return {
    nBars,
    championMeanNetR: c.performance.meanNetR,
    challengerMeanNetR: k.performance.meanNetR,
    championTrades: c.tradeCount,
    challengerTrades: k.tradeCount,
    championWinRate: c.performance.winRate,
    challengerWinRate: k.performance.winRate,
    championCostDragR: c.decomposition.totalCostDragR / Math.max(1, c.tradeCount),
    challengerCostDragR: k.decomposition.totalCostDragR / Math.max(1, k.tradeCount),
    reversalPrecision: reversal ? reversal.precision : null,
    reversalRecall: reversal ? reversal.recall : null,
    reversalFalseAlarmShare: reversal ? reversal.falseAlarms / reversal.events : null,
    commonOpportunityAuc: ei.sharedScoreDiscrimination
      ? ei.sharedScoreDiscrimination.auc : null,
    abstentionWinRateDelta: ei.challengerAbstention
      ? ei.challengerAbstention.takenWinRate - ei.challengerAbstention.abstainedWinRate
      : null,
  };
}

/**
 * Multi-instrument paired replay matrix. config: { instruments, scenarios,
 * replaysPerCell, nBars, seedBase (default 4100000) }.
 */
function runMultiInstrumentMatrix(config) {
  const instruments = (config && config.instruments) || ['EURUSD', 'GBPUSD'];
  const scenarios = (config && config.scenarios) || [
    'TREND_REGIMES', 'EDGE_ZERO', 'REVERSION', 'PLANTED_DRIFT',
  ];
  const replaysPerCell = config && config.replaysPerCell !== undefined
    ? config.replaysPerCell : 250;
  const nBars = config && config.nBars !== undefined ? config.nBars : 1200;
  const seedBase = config && config.seedBase !== undefined ? config.seedBase : 4100000;
  if (!Number.isInteger(replaysPerCell) || replaysPerCell < 1) {
    throw new Error('E10_REPLAYS_INVALID');
  }
  if (!Number.isInteger(nBars) || nBars < 200) {
    throw new Error('E10_CELL_INVALID');
  }
  if (!Number.isInteger(seedBase) || seedBase <= 0) {
    throw new Error('E10_SEED_INVALID');
  }
  const cells = [];
  for (let ii = 0; ii < instruments.length; ii += 1) {
    for (let si = 0; si < scenarios.length; si += 1) {
      const stats = [];
      for (let r = 0; r < replaysPerCell; r += 1) {
        // Distinct, non-overlapping seed per cell and replay.
        const seed = seedBase + ii * 100000 + si * 10000 + r;
        const market = generateMarketPath({
          seed, nBars, scenario: scenarios[si], instrument: instruments[ii],
        });
        const campaign = runCampaign({ market });
        stats.push(replaySummaryStats(campaign));
      }
      cells.push(Object.freeze({
        instrument: instruments[ii],
        scenario: scenarios[si],
        costModel: 'frozen broker-calibrated (spread 0.8 pip, commission $3/lot/side, slippage 0.1 pip, swap -0.55/lot/night)',
        aggregate: aggregateCell(stats),
      }));
    }
  }
  return Object.freeze({
    cells: Object.freeze(cells),
    replaysPerCell,
    nBars,
    totalPairedReplays: cells.length * replaysPerCell,
    note: 'Per-cell means with normal-approximation 95% intervals across ' +
      'independent replays; cells with < 30 replays are typed refusals, ' +
      'never silently reported. Cells with null reversal fields have no ' +
      'directional ground truth (EDGE_ZERO/REVERSION/PLANTED_DRIFT).',
  });
}

/** Slice a market path chronologically (bar re-indexing included). */
function sliceMarket(market, fromBar, toBar) {
  const bars = market.bars.slice(fromBar, toBar);
  const offset = fromBar;
  const reversalPoints = market.groundTruth.reversalPoints
    .filter((p) => p.bar >= fromBar && p.bar < toBar)
    .map((p) => Object.freeze({ ...p, bar: p.bar - offset }));
  return Object.freeze({
    instrument: market.instrument,
    scenario: market.scenario,
    seed: market.seed,
    nBars: bars.length,
    barSeconds: market.barSeconds,
    t0: market.t0,
    spec: market.spec,
    bars: Object.freeze(bars),
    groundTruth: Object.freeze({
      regimeEpisodes: market.groundTruth.regimeEpisodes,
      reversalPoints: Object.freeze(reversalPoints),
      plantedParameters: market.groundTruth.plantedParameters,
    }),
  });
}

/**
 * Chronological walk-forward campaign: one long path per instrument split
 * into `folds` chronological segments; each fold is a fresh paired replay
 * (positions force-closed at the fold boundary by the simulator's
 * HORIZON_CLOSE); per-fold deltas with uncertainty; a cumulative stitched
 * paired-delta curve. NOTHING is re-fitted between folds (policies are
 * frozen) — this is a temporal-stability check, not a fitting procedure.
 */
function runWalkForwardCampaign(config) {
  const instrument = (config && config.instrument) || 'EURUSD';
  const scenario = (config && config.scenario) || 'TREND_REGIMES';
  const nBars = (config && config.nBars) || 7200;
  const folds = (config && config.folds) || 6;
  const seed = config && config.seed !== undefined ? config.seed : 4510000;
  if (!Number.isInteger(folds) || folds < 2) {
    throw new Error('E10_FOLDS_INVALID');
  }
  if (!Number.isInteger(seed) || seed <= 0) {
    throw new Error('E10_SEED_INVALID');
  }
  const market = generateMarketPath({ seed, nBars, scenario, instrument });
  const foldLen = Math.floor(nBars / folds);
  const foldResults = [];
  let cumulativeDeltaR = 0;
  const cumulativeCurve = [0];
  for (let f = 0; f < folds; f += 1) {
    const from = f * foldLen;
    const to = f === folds - 1 ? nBars : (f + 1) * foldLen;
    const foldMarket = sliceMarket(market, from, to);
    const replay = runPairedReplay({ market: foldMarket, slippageSeed: market.seed });
    const championNetR = replay.champion.trades.length > 0
      ? replay.champion.trades.reduce((s, t) => s + t.netR, 0) : 0;
    const challengerNetR = replay.challenger.trades.length > 0
      ? replay.challenger.trades.reduce((s, t) => s + t.netR, 0) : 0;
    const delta = challengerNetR - championNetR;
    cumulativeDeltaR += delta;
    cumulativeCurve.push(cumulativeDeltaR);
    foldResults.push(Object.freeze({
      fold: f,
      fromBar: from,
      toBar: to,
      championTrades: replay.champion.trades.length,
      challengerTrades: replay.challenger.trades.length,
      championNetR,
      challengerNetR,
      pairedDeltaNetR: delta,
    }));
  }
  const deltas = foldResults.map((r) => r.pairedDeltaNetR);
  return Object.freeze({
    instrument,
    scenario,
    seed,
    nBars,
    folds,
    foldResults: Object.freeze(foldResults),
    cumulativeDeltaNetR: cumulativeDeltaR,
    cumulativeCurve: Object.freeze(cumulativeCurve),
    aggregateDelta: meanAndInterval95(deltas),
    leakageControl: 'Chronological segmentation only; each fold is evaluated ' +
      'in order; positions are force-closed at fold boundaries; no ' +
      'parameter is re-fitted between folds (policies frozen) — this is a ' +
      'temporal-stability check, not a fitting procedure validation.',
  });
}

module.exports = {
  E10_CAMPAIGN_REFUSALS,
  meanAndInterval95,
  aggregateCell,
  replaySummaryStats,
  runMultiInstrumentMatrix,
  sliceMarket,
  runWalkForwardCampaign,
};
