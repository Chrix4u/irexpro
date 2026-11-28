'use strict';
/**
 * V2 offline evaluation harness (P2 + P3). Computes the seven metric
 * families over paired replays and runs the pre-registered validation
 * campaigns:
 *
 *   1. entry discrimination      — Mann-Whitney AUC of registered
 *                                   confidence vs realized outcome;
 *   2. confidence calibration     — Brier / ECE / reliability
 *                                   (v2-statistical-evaluation);
 *   3. reversal detection        — challenger gate vs regime ground truth;
 *   4. exit efficiency            — capture of favorable excursion by exit
 *                                   reason (EI-1 reasons);
 *   5. profit retention           — realized gross R / MFE R;
 *   6. cost-adjusted expectancy   — after-cost net R per trade with
 *                                   uncertainty (v2-statistical-evaluation);
 *   7. drawdown                   — trade-level R and equity-level USD.
 *
 * Campaigns: null false-positive calibration (P3-1), binormal known-edge
 * detection power (P3-2), exit-dominance attribution (P3-3), plus the
 * attribution-ledger JSONL persistence round-trip (P2-3).
 *
 * Research-only: synthetic markets; no profitability claims are derivable
 * from this harness — its purpose is to measure the MEASUREMENT MACHINERY
 * and the paired policy deltas, with stated uncertainty.
 */

const {
  evaluateAfterCostPerformance,
  evaluateCalibration,
  aucStandardError,
  requiredNPerClassForAucDetection,
  wilsonInterval,
  compareWinRates,
  maxDrawdown,
} = require('./v2-statistical-evaluation.cjs');
const {
  decomposeTradeOutcome,
  classifyEconomicDeficit,
} = require('./v2-entry-exit-decomposition.cjs');
const { generateMarketPath } = require('./v2-synthetic-market.cjs');
const { runPairedReplay } = require('./v2-paired-engine-simulator.cjs');
const { createAttributionLedger } = require('./v2-challenger-attribution.cjs');
const { mulberry32 } = require('./v2-synthetic-market.cjs');

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Standard normal CDF (Abramowitz-Stegun 7.1.26). */
function normalCdf(z) {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.3989422804014327;
  const a = Math.abs(z);
  const t = 1 / (1 + p * a);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const pdf = c * Math.exp(-a * a / 2);
  const upper = pdf * poly;
  return z >= 0 ? 1 - upper : upper;
}

/** Inverse standard normal CDF by bisection (deterministic). */
function normalQuantile(p) {
  if (!finiteNumber(p) || p <= 0 || p >= 1) {
    throw new Error('HARNESS_QUANTILE_INVALID');
  }
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function gaussianPair(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Mann-Whitney AUC of a score against a binary outcome. */
function mannWhitneyAUC(items) {
  const positives = items.filter((i) => i.outcome === 1).map((i) => i.score);
  const negatives = items.filter((i) => i.outcome === 0).map((i) => i.score);
  if (positives.length === 0 || negatives.length === 0) {
    throw new Error('HARNESS_AUC_CLASS_EMPTY');
  }
  let concordant = 0;
  let ties = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) concordant += 1;
      else if (p === n) ties += 1;
    }
  }
  const total = positives.length * negatives.length;
  return (concordant + 0.5 * ties) / total;
}

/** Settle pre-outcome registrations against realized forward outcomes. */
function settleRegistrations(registrations, bars) {
  if (!Array.isArray(registrations) || !Array.isArray(bars)) {
    throw new Error('HARNESS_REGISTRATIONS_REQUIRED');
  }
  const settled = [];
  for (const r of registrations) {
    const target = r.bar + r.windowBars;
    if (target >= bars.length) continue;
    const forward = bars[target].close - bars[r.bar].close;
    const outcome = forward * (r.direction === 'BUY' ? 1 : -1) > 0 ? 1 : 0;
    settled.push({ probability: r.probability, outcome, score: r.probability });
  }
  return settled;
}

/** Entry discrimination: AUC + Hanley-McNeil SE of registered confidence. */
function evaluateEntryDiscrimination(trades) {
  const items = trades
    .filter((t) => finiteNumber(t.entryConfidence))
    .map((t) => ({ score: t.entryConfidence, outcome: t.netR > 0 ? 1 : 0 }));
  if (items.length === 0) {
    throw new Error('HARNESS_DISCRIMINATION_EMPTY');
  }
  const auc = mannWhitneyAUC(items);
  const n1 = items.filter((i) => i.outcome === 1).length;
  const n2 = items.length - n1;
  const se = aucStandardError(auc, n1, n2);
  const z = (auc - 0.5) / se;
  return Object.freeze({
    n: items.length, auc, se, z, n1, n2,
    note: 'AUC of pre-outcome registered confidence vs settled outcome; ' +
      'z is the two-sided signal vs chance.',
  });
}

/** Exit efficiency + profit retention from settled trades (R units). */
function evaluateExitEfficiency(trades) {
  const winners = trades.filter((t) => t.mfeR > 0.1);
  const captures = winners.map((t) => t.grossR / t.mfeR);
  const losers = trades.filter((t) => t.grossR < 0);
  const lossCuts = losers.filter((t) => t.maeR < 0)
    .map((t) => Math.abs(t.grossR) / Math.abs(t.maeR));
  const mean = (xs) => xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  const byReason = {};
  for (const t of trades) {
    if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, netR: 0 };
    byReason[t.exitReason].count += 1;
    byReason[t.exitReason].netR += t.netR;
  }
  return Object.freeze({
    n: trades.length,
    meanCapture: mean(captures),
    captureN: captures.length,
    // profit retention: fraction of max favorable excursion realized.
    meanRetention: mean(captures),
    meanGiveback: captures.length > 0 ? 1 - mean(captures) : null,
    meanLossCut: mean(lossCuts),
    lossCutN: lossCuts.length,
    exitReasons: Object.freeze(
      Object.fromEntries(Object.entries(byReason).map(([k, v]) => [k, Object.freeze({
        count: v.count,
        meanNetR: v.netR / v.count,
      })])),
    ),
    note: 'capture = realized gross R / MFE R (exit efficiency = retention); ' +
      'lossCut = |realized loss| / |MAE R| (closer to 0 = cut earlier).',
  });
}

/** Drawdown: trade-level R and equity-curve USD. */
function evaluateDrawdown(trades, equityCurve, startingBalanceUsd) {
  const netRs = trades.map((t) => t.netR);
  const tradeLevelMaxDDR = netRs.length > 0 ? maxDrawdown(netRs) : null;
  let peak = equityCurve.length > 0 ? equityCurve[0] : startingBalanceUsd;
  let maxDdUsd = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDdUsd) maxDdUsd = dd;
  }
  return Object.freeze({
    tradeLevelMaxDDR,
    equityMaxDDUsd: maxDdUsd,
    equityMaxDDPercentOfStart: startingBalanceUsd > 0
      ? (maxDdUsd / startingBalanceUsd) : null,
    nEquityPoints: equityCurve.length,
  });
}

/**
 * Cohort decomposition with explicit deficit semantics: win truncation and
 * loss extension enter the deficit budget clamped at zero; loss CUTTING
 * (the guard closing before 1R) is a benefit reported separately rather
 * than a negative deficit channel (the P0-5 classifier requires
 * non-negative channel totals by contract).
 */
function decomposeCohortExplicit(trades) {
  const rows = trades.map((t) => decomposeTradeOutcome(t));
  const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);
  const totalWinTruncationR = sum((r) => Math.max(0, r.winTruncationR));
  const totalLossExtensionR = sum((r) => Math.max(0, r.lossExtensionR));
  const totalCostDragR = sum((r) => r.costDragR);
  const lossCutBenefitR = sum((r) => Math.max(0, -r.lossExtensionR));
  const n = rows.length;
  return Object.freeze({
    n,
    winCount: rows.filter((r) => r.realizedGrossR >= 0).length,
    lossCount: rows.filter((r) => r.realizedGrossR < 0).length,
    totalRealizedNetR: sum((r) => r.realizedNetR),
    totalDesignPayoffR: sum((r) => r.designPayoffR),
    totalWinTruncationR,
    totalLossExtensionR,
    totalCostDragR,
    lossCutBenefitR,
    identityHoldsForAll: rows.every((r) => r.identityHolds),
    decomposition: classifyEconomicDeficit({
      totalWinTruncationR, totalLossExtensionR, totalCostDragR,
    }),
  });
}

/** Full metric block for one engine side of one paired replay. */
function evaluateEngineSide(side, market) {
  const netRows = side.trades.map((t) => ({ netR: t.netR }));
  const performance = evaluateAfterCostPerformance(netRows);
  const settled = settleRegistrations(side.registrations, market.bars);
  const calibration = settled.length > 0 ? evaluateCalibration(settled) : null;
  const discrimination = evaluateEntryDiscrimination(side.trades);
  const exitEfficiency = evaluateExitEfficiency(side.trades);
  const decomposition = side.trades.map((t) => ({
    direction: t.direction,
    entryPrice: t.entryMid,
    exitPrice: t.exitMid,
    stopDistance: t.stopDistance,
    designTargetR: 1.6,
    commissionR: (t.commissionUsd + t.slippageUsd) / t.riskAmountUsd,
    swapR: t.swapUsd / t.riskAmountUsd,
    spreadR: t.spreadUsd / t.riskAmountUsd,
  }));
  const cohort = decomposeCohortExplicit(decomposition);
  return Object.freeze({
    tradeCount: side.trades.length,
    performance,
    calibration,
    discrimination,
    exitEfficiency,
    decomposition: cohort,
    drawdown: evaluateDrawdown(side.trades, side.equityCurve,
      (side.equityCurve[0] !== undefined ? side.equityCurve[0] : null)),
  });
}

/** One paired campaign: both engines + comparative + reversal detection. */
function runCampaign(config) {
  const market = config && config.market
    ? config.market
    : generateMarketPath({
      seed: (config && config.seed) || 1,
      nBars: (config && config.nBars) || 2000,
      scenario: (config && config.scenario) || 'TREND_REGIMES',
    });
  const replay = runPairedReplay({
    market,
    startingBalanceUsd: config && config.startingBalanceUsd,
    slippageSeed: market.seed,
  });
  const champion = evaluateEngineSide(replay.champion, market);
  const challenger = evaluateEngineSide(replay.challenger, market);

  // Reversal detection: challenger gate events vs regime ground truth.
  const tolBars = (config && config.reversalTolBars) || 12;
  const points = market.groundTruth.reversalPoints.filter((p) => p.directional);
  const events = replay.challenger.reversalEvents;
  let matchedEvents = 0;
  const leads = [];
  const matchedPoints = new Set();
  for (const e of events) {
    let best = null;
    for (const point of points) {
      if (Math.abs(point.bar - e.bar) <= tolBars) {
        if (best === null || Math.abs(point.bar - e.bar) < Math.abs(best - e.bar)) {
          best = point.bar;
        }
      }
    }
    if (best !== null) {
      matchedEvents += 1;
      leads.push(e.bar - best);
      matchedPoints.add(best);
    }
  }
  const reversalDetection = points.length > 0 && events.length > 0
    ? Object.freeze({
      groundTruthPoints: points.length,
      events: events.length,
      precision: matchedEvents / events.length,
      recall: matchedPoints.size / points.length,
      medianLeadBars: leads.length > 0
        ? leads.slice().sort((a, b) => a - b)[Math.floor(leads.length / 2)] : null,
      tolBars,
    })
    : null;

  // Comparative win-rate (typed refusal under 30 per engine is expected
  // on short paths — recorded, never forced).
  let winRateComparison = null;
  try {
    winRateComparison = compareWinRates(
      { wins: replay.champion.trades.filter((t) => t.netR > 0).length,
        n: replay.champion.trades.length },
      { wins: replay.challenger.trades.filter((t) => t.netR > 0).length,
        n: replay.challenger.trades.length },
    );
  } catch (e) {
    winRateComparison = { refused: String(e.message) };
  }

  return Object.freeze({
    market: Object.freeze({
      instrument: market.instrument,
      scenario: market.scenario,
      seed: market.seed,
      nBars: market.nBars,
    }),
    champion,
    challenger,
    reversalDetection,
    winRateComparison,
    ledger: replay.ledger,
    replayNetTotals: Object.freeze({
      championUsd: replay.champion.trades.reduce((s, t) => s + t.netUsd, 0),
      challengerUsd: replay.challenger.trades.reduce((s, t) => s + t.netUsd, 0),
    }),
  });
}

/**
 * P3-1 null campaign: zero-edge markets; the false-positive rate of the
 * one-sided 95% expectancy declaration must be at or below nominal plus
 * binomial tolerance. Pre-registered: declaration = mean netR / (sd/sqrt(n))
 * > 1.645 with n >= minTrades (30).
 */
function runNullCampaign(config) {
  const replays = (config && config.replays) || 200;
  const nBars = (config && config.nBars) || 900;
  const seedBase = (config && config.seedBase) || 900000;
  const minTrades = 30;
  let declared = { champion: 0, challenger: 0, paired: 0 };
  let eligible = { champion: 0, challenger: 0, paired: 0 };
  for (let i = 0; i < replays; i += 1) {
    const market = generateMarketPath({
      seed: seedBase + i, nBars, scenario: 'EDGE_ZERO',
    });
    const replay = runPairedReplay({ market, slippageSeed: market.seed });
    for (const [name, side] of [['champion', replay.champion], ['challenger', replay.challenger]]) {
      const n = side.trades.length;
      if (n < minTrades) continue;
      eligible[name] += 1;
      const netRs = side.trades.map((t) => t.netR);
      const mean = netRs.reduce((s, v) => s + v, 0) / n;
      const variance = netRs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1);
      const t = mean / Math.sqrt(variance / n);
      if (t > 1.645) declared[name] += 1;
    }
    // Paired Newcombe false positive on win rates.
    try {
      const cmp = compareWinRates(
        { wins: replay.champion.trades.filter((t) => t.netR > 0).length, n: replay.champion.trades.length },
        { wins: replay.challenger.trades.filter((t) => t.netR > 0).length, n: replay.challenger.trades.length },
      );
      eligible.paired += 1;
      if (cmp.excludesZero) declared.paired += 1;
    } catch { /* insufficient sample — not eligible */ }
  }
  const rate = (d, e) => (e > 0 ? d / e : null);
  const [lo, hi] = wilsonInterval(declared.champion, eligible.champion || 1) || [null, null];
  return Object.freeze({
    replays, nBars, minTrades,
    falsePositiveRate: Object.freeze({
      champion: rate(declared.champion, eligible.champion),
      challenger: rate(declared.challenger, eligible.challenger),
      pairedWinRate: rate(declared.paired, eligible.paired),
    }),
    eligible: Object.freeze(eligible),
    declared: Object.freeze(declared),
    nominalOneSided: 0.05,
    championWilson95: [lo, hi],
    preRegisteredDeclaration: 'meanNetR / (sd/sqrt(n)) > 1.645, n >= 30, EDGE_ZERO market',
  });
}

/**
 * P3-2 known-edge campaign: equal-variance binormal planted AUC. Positives
 * score ~ N(a, 1), negatives ~ N(0, 1), so the true AUC = Phi(a / sqrt(2))
 * exactly; planting a = sqrt(2) * quantile(target) plants exactly the
 * target AUC. The framework must recover it and detect it at the predicted
 * power.
 */
function runKnownEdgeCampaign(config) {
  const targets = (config && config.aucTargets) || [0.55, 0.60];
  const trials = (config && config.trials) || 200;
  const seedBase = (config && config.seedBase) || 700000;
  const results = targets.map((target) => {
    const a = Math.sqrt(2) * normalQuantile(target);
    const plantedAuc = normalCdf(a / Math.sqrt(2));
    // Pre-registered per-class n from the framework's own power solver.
    const n = requiredNPerClassForAucDetection(target, 0.05, 0.8);
    let detected = 0;
    let aucSum = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      const rng = mulberry32(seedBase + trial + Math.round(target * 1000));
      const items = [];
      // Equal-variance binormal: positives N(a,1), negatives N(0,1).
      for (let i = 0; i < n; i += 1) {
        items.push({ score: a + gaussianPair(rng), outcome: 1 });
      }
      for (let i = 0; i < n; i += 1) {
        items.push({ score: gaussianPair(rng), outcome: 0 });
      }
      const auc = mannWhitneyAUC(items);
      aucSum += auc;
      const se = aucStandardError(auc, n, n);
      if ((auc - 0.5) / se > 1.959964) detected += 1;
    }
    return Object.freeze({
      plantedAuc: target,
      verifiedPlantedAuc: plantedAuc,
      perClassN: n,
      trials,
      meanMeasuredAuc: aucSum / trials,
      detectionRate: detected / trials,
      predictedPower: 0.8,
    });
  });
  return Object.freeze({
    campaigns: Object.freeze(results),
    note: 'Equal-variance binormal planting: positives N(a,1), negatives ' +
      'N(0,1); true AUC = Phi(a/sqrt(2)) exactly. Detection: one-sided ' +
      'z > 1.96 at the framework\'s own required-N. Framework validation, ' +
      'not engine performance.',
  });
}

/**
 * P3-3 exit-dominance. Two controlled planted-deficit arms where the
 * planted deficit is exact and deterministic, plus the observational arm
 * (the live paired simulator's decomposition on a trend-regime market).
 * Acceptance: >= 90% of each planted deficit attributed to the correct
 * channel. The controlled arms trade the SAME entry design (1.6R target,
 * 1R stop) with only the planted behavior applied.
 */
function buildPlantedTrades({ winners, losers, plantedR, channel }) {
  const trades = [];
  const costR = 0.05;
  for (let i = 0; i < winners; i += 1) {
    // Winner: realized = design 1.6R minus plantedR (truncation arm).
    const realizedGrossR = channel === 'WIN_TRUNCATION' ? 1.6 - plantedR : 1.6;
    trades.push({ realizedGrossR, costR, kind: 'win' });
  }
  for (let i = 0; i < losers; i += 1) {
    // Loser: realized = -1R minus plantedR (extension arm).
    const realizedGrossR = channel === 'LOSS_EXTENSION' ? -1 - plantedR : -1;
    trades.push({ realizedGrossR, costR, kind: 'loss' });
  }
  return trades;
}

function decomposePlantedCohort(planted) {
  // Map planted synthetic outcomes into the P0-5 decomposition inputs.
  const inputs = planted.map((t) => ({
    direction: 'BUY',
    entryPrice: 1.10,
    exitPrice: 1.10 + t.realizedGrossR * 0.001, // R in price via stop 0.001
    stopDistance: 0.001,
    designTargetR: 1.6,
    commissionR: t.costR,
    swapR: 0,
    spreadR: 0,
  }));
  const rows = inputs.map((t) => decomposeTradeOutcome(t));
  const totalWinTruncationR = rows.reduce((s, r) => s + Math.max(0, r.winTruncationR), 0);
  const totalLossExtensionR = rows.reduce((s, r) => s + Math.max(0, r.lossExtensionR), 0);
  const totalCostDragR = rows.reduce((s, r) => s + r.costDragR, 0);
  return classifyEconomicDeficit({
    totalWinTruncationR, totalLossExtensionR, totalCostDragR,
  });
}

function runExitDominanceCampaign(config) {
  // Controlled arm A: 100 winners truncated by 1.0R each, losers at -1R.
  const truncationArm = buildPlantedTrades({
    winners: 100, losers: 100, plantedR: 1.0, channel: 'WIN_TRUNCATION',
  });
  const truncation = decomposePlantedCohort(truncationArm);
  const plantedTruncationR = 100 * 1.0;
  // Controlled arm B: 100 losers extended by 1.0R each, winners at design.
  const extensionArm = buildPlantedTrades({
    winners: 100, losers: 100, plantedR: 1.0, channel: 'LOSS_EXTENSION',
  });
  const extension = decomposePlantedCohort(extensionArm);
  const plantedExtensionR = 100 * 1.0;

  // Observational arm: the live paired simulator on a trend-regime market.
  const seed = (config && config.seed) || 20261130;
  const nBars = (config && config.nBars) || 4000;
  const market = generateMarketPath({ seed, nBars, scenario: 'TREND_REGIMES' });
  const campaign = runCampaign({ market });

  return Object.freeze({
    controlledTruncation: Object.freeze({
      plantedDeficitR: plantedTruncationR,
      dominant: truncation.dominant,
      shares: truncation.shares,
      attributionShare: truncation.shares.WIN_TRUNCATION,
    }),
    controlledExtension: Object.freeze({
      plantedDeficitR: plantedExtensionR,
      dominant: extension.dominant,
      shares: extension.shares,
      attributionShare: extension.shares.LOSS_EXTENSION,
    }),
    observational: Object.freeze({
      market: campaign.market,
      challengerDominantChannel: campaign.challenger.decomposition.decomposition.dominant,
      challengerShares: campaign.challenger.decomposition.decomposition.shares,
      championDominantChannel: campaign.champion.decomposition.decomposition.dominant,
      winTruncationShare:
        campaign.challenger.decomposition.decomposition.shares.WIN_TRUNCATION || 0,
    }),
    lossExtensionNote: 'the simulator fills stops at-level (bounded at 1R ' +
      '+ slip), so loss extension is planted only in the controlled arm; ' +
      'the observational arm reports live shares.',
  });
}

/** P2-3: attribution-ledger JSONL persistence with round-trip proof. */
function exportLedgerJSONL(ledger) {
  if (!ledger || typeof ledger.count !== 'function') {
    throw new Error('HARNESS_LEDGER_REQUIRED');
  }
  return ledger.rows().map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function importLedgerJSONL(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('HARNESS_LEDGER_JSONL_EMPTY');
  }
  const ledger = createAttributionLedger();
  const lines = text.trim().split('\n');
  const badLines = [];
  lines.forEach((line, index) => {
    try {
      const row = JSON.parse(line);
      ledger.register({
        engineIdentity: row.engineIdentity,
        tradeId: row.tradeId,
        instrument: row.instrument,
        direction: row.direction,
        lots: row.lots,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        grossPnl: row.grossPnl,
        commission: row.commission,
        swap: row.swap,
        riskAmount: row.riskAmount,
        settlementProvenance: row.settlementProvenance,
      });
    } catch (e) {
      badLines.push({ index, reason: String(e.message) });
    }
  });
  return { ledger, badLines: Object.freeze(badLines) };
}

/** Round-trip integrity: net totals and row count must be identical. */
function verifyLedgerRoundTrip(original, imported) {
  const sum = (rows) => rows.reduce((s, r) => s + r.netPnl, 0);
  const countA = original.count();
  const countB = imported.count();
  return Object.freeze({
    rowsEqual: countA === countB,
    netTotalsEqual: Math.abs(sum(original.rows()) - sum(imported.rows())) < 1e-9,
    originalCount: countA,
    importedCount: countB,
  });
}

module.exports = {
  normalCdf,
  normalQuantile,
  mannWhitneyAUC,
  settleRegistrations,
  evaluateEntryDiscrimination,
  evaluateExitEfficiency,
  evaluateDrawdown,
  evaluateEngineSide,
  runCampaign,
  runNullCampaign,
  runKnownEdgeCampaign,
  runExitDominanceCampaign,
  exportLedgerJSONL,
  importLedgerJSONL,
  verifyLedgerRoundTrip,
};
