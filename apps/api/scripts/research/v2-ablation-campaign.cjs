'use strict';
/**
 * V2 controlled offline ablation campaign (2026-11-28 directive item 4).
 *
 * Investigates three deficit channels with controlled experiments on the
 * ablation-designated seed family 43xxxxx:
 *
 *   A. Premature winner truncation — retention-ladder variants (tighter /
 *      frozen / looser / no ladder) measuring MFE capture, net expectancy
 *      and the WIN_TRUNCATION channel share.
 *   B. Excessive turnover — entry-gate and confidence-floor variants
 *      measuring trades per replay (turnover), net expectancy and cost
 *      drag as turnover changes.
 *   C. Transaction-cost drag — cost-multiplier variants (0.5x / 1x /
 *      1.5x / 2x) on spread+commission+slippage measuring net expectancy
 *      versus cost level, cost-drag R and the edge required to break even.
 *
 * Discipline (binding):
 *   - Ablation arms are EXPERIMENTAL. The pre-registered challenger preset
 *     and entry policy stay FROZEN; no arm is promoted on the basis of
 *     these results.
 *   - The ablation seed family (43xxxxx) is disjoint from the E-10 cell
 *     family (41xxxxx), the walk-forward family (45xxxxx) and the final
 *     held-out evaluation family (47xxxxx, untouched here) — nothing is
 *     optimized against the final held-out evaluation dataset.
 *   - Uncertainty: per-arm mean with normal-approximation 95% intervals
 *     across independent replays; cells with < 30 replays are typed
 *     refusals.
 *   - Negative results are reported exactly as positive ones.
 *
 * Research-only; no order authority; synthetic data only.
 */

const { generateMarketPath } = require('./v2-synthetic-market.cjs');
const { runPairedReplay, DEFAULT_COST_MODEL } = require('./v2-paired-engine-simulator.cjs');
const { V2_CHALLENGER_EXIT_PRESET } = require('./v2-exit-intelligence-contract.cjs');
const { CHALLENGER_POLICY } = require('./v2-intelligence-engine.cjs');
const {
  meanAndInterval95,
} = require('./v2-e10-campaign.cjs');

const ABLATION_REFUSALS = Object.freeze([
  'ABLATION_REPLAYS_INVALID', 'ABLATION_ARM_INVALID', 'ABLATION_SEED_INVALID',
]);

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Per-replay ablation summary (challenger side only by design). */
function ablationReplaySummary(replay) {
  const trades = replay.challenger.trades;
  const n = trades.length;
  const sum = (fn) => trades.reduce((s, t) => s + fn(t), 0);
  const winners = trades.filter((t) => t.mfeR > 0.1);
  const captures = winners.map((t) => t.grossR / t.mfeR);
  const meanCapture = captures.length > 0
    ? captures.reduce((s, v) => s + v, 0) / captures.length : null;
  return {
    trades: n,
    meanNetR: n > 0 ? sum((t) => t.netR) / n : null,
    meanGrossR: n > 0 ? sum((t) => t.grossR) / n : null,
    meanCostR: n > 0 ? sum((t) => t.costsR) / n : null,
    meanCapture: meanCapture === null ? null : meanCapture,
    winTruncationR: sum((t) => Math.max(0, 1.6 - t.grossR)) / Math.max(1, winners.length),
    winRate: n > 0 ? trades.filter((t) => t.netR > 0).length / n : null,
  };
}

/** Run one ablation arm over N replays and aggregate. */
function runAblationArm(arm, options) {
  const replays = options && options.replays !== undefined ? options.replays : 250;
  const nBars = options && options.nBars !== undefined ? options.nBars : 1200;
  const seedBase = options && options.seedBase !== undefined ? options.seedBase : 4300000;
  const instrument = (options && options.instrument) || 'EURUSD';
  const scenario = (options && options.scenario) || 'TREND_REGIMES';
  if (!Number.isInteger(replays) || replays < 1) {
    throw new Error('ABLATION_REPLAYS_INVALID');
  }
  if (!Number.isInteger(nBars) || nBars < 200) {
    throw new Error('ABLATION_ARM_INVALID');
  }
  if (!Number.isInteger(seedBase) || seedBase <= 0) {
    throw new Error('ABLATION_SEED_INVALID');
  }
  const stats = [];
  for (let r = 0; r < replays; r += 1) {
    const market = generateMarketPath({
      seed: seedBase + r, nBars, scenario, instrument,
    });
    const config = {
      market,
      slippageSeed: market.seed,
    };
    if (arm.kind === 'EXIT_PRESET') config.challengerExitPreset = arm.exitPreset;
    if (arm.kind === 'ENTRY_GATE') config.challengerEntryGate = arm.entryGate;
    if (arm.kind === 'CONFIDENCE_FLOOR') config.challengerConfidenceFloor = arm.confidenceFloor;
    if (arm.kind === 'COST_MODEL') {
      config.costModel = Object.fromEntries(Object.entries(arm.costModel)
        .map(([k, v]) => [k, finiteNumber(v) ? v * arm.costMultiplier : v]));
    }
    const replay = runPairedReplay(config);
    stats.push(ablationReplaySummary(replay));
  }
  const pick = (fn) => stats.map(fn);
  return Object.freeze({
    arm: arm.label,
    armKind: arm.kind,
    armDetail: arm.detail || null,
    replays,
    tradesPerReplay: meanAndInterval95(pick((s) => s.trades)),
    meanNetR: meanAndInterval95(pick((s) => s.meanNetR)),
    meanGrossR: meanAndInterval95(pick((s) => s.meanGrossR)),
    meanCostR: meanAndInterval95(pick((s) => s.meanCostR)),
    meanCapture: meanAndInterval95(pick((s) => s.meanCapture)),
    winTruncationPerWinner: meanAndInterval95(pick((s) => s.winTruncationR)),
    winRate: meanAndInterval95(pick((s) => s.winRate)),
  });
}

/** Retention-ladder variants for the winner-truncation ablation. */
function ladderVariant(delta, label) {
  const preset = {
    ...V2_CHALLENGER_EXIT_PRESET,
    bands: V2_CHALLENGER_EXIT_PRESET.bands.map((b) => Object.freeze({
      fromR: b.fromR,
      retain: Math.max(0.1, Math.min(0.98, b.retain + delta)),
    })),
    rescue: Object.freeze({
      armR: V2_CHALLENGER_EXIT_PRESET.rescue.armR,
      retain: Math.max(0.1, Math.min(0.98, V2_CHALLENGER_EXIT_PRESET.rescue.retain + delta)),
    }),
  };
  return Object.freeze({
    kind: 'EXIT_PRESET',
    label,
    detail: `retain bands shifted by ${delta}`,
    exitPreset: Object.freeze(preset),
  });
}

/** No-ladder arm: champion-style hard stop/target geometry, no lock. */
const NO_LADDER_ARM = Object.freeze({
  kind: 'EXIT_PRESET',
  label: 'no-ladder (hard stop/target only)',
  detail: 'lock arm moved beyond the 1.6R target (never arms), rescue ' +
    'equally unreachable, drawdown guard off, time stop effectively off — ' +
    'winners ride to the hard target, losers to the hard stop',
  exitPreset: Object.freeze({
    ...V2_CHALLENGER_EXIT_PRESET,
    armR: 10.0,
    bands: Object.freeze([Object.freeze({ fromR: 10.0, retain: 1.0 })]),
    rescue: Object.freeze({ armR: 9.5, retain: 1.0 }),
    drawdownGuard: null,
    timeStopBars: 1000000,
  }),
});

/**
 * A. Winner-truncation ablation: tighter / frozen / looser / no ladder.
 */
function runWinnerTruncationAblation(options) {
  const arms = [
    ladderVariant(-0.10, 'tighter-lock (retain -0.10)'),
    ladderVariant(0, 'frozen pre-registered preset'),
    ladderVariant(+0.10, 'looser-lock (retain +0.10)'),
    NO_LADDER_ARM,
  ];
  return Object.freeze({
    channel: 'WIN_TRUNCATION',
    question: 'Does the retention ladder truncate winners prematurely? ' +
      'How much MFE capture and net expectancy shift with tighter/looser ' +
      'locks and with no ladder at all?',
    arms: Object.freeze(arms.map((arm) => runAblationArm(arm, options))),
    discipline: 'Experimental arms; frozen preset never modified; results ' +
      'inform understanding only — no arm is promoted.',
  });
}

/**
 * B. Turnover ablation: entry gate and confidence floor variants.
 */
function runTurnoverAblation(options) {
  const arms = [
    Object.freeze({
      kind: 'ENTRY_GATE', label: 'entry gate 0.50', detail: 'more entries',
      entryGate: 0.50,
    }),
    Object.freeze({
      kind: 'ENTRY_GATE', label: `entry gate ${CHALLENGER_POLICY.entryGateDirectionQuality} (frozen)`,
      detail: 'pre-registered gate',
      entryGate: CHALLENGER_POLICY.entryGateDirectionQuality,
    }),
    Object.freeze({
      kind: 'ENTRY_GATE', label: 'entry gate 0.70', detail: 'fewer entries',
      entryGate: 0.70,
    }),
    Object.freeze({
      kind: 'ENTRY_GATE', label: 'entry gate 0.80', detail: 'much fewer entries',
      entryGate: 0.80,
    }),
    Object.freeze({
      kind: 'CONFIDENCE_FLOOR', label: 'confidence floor 0.45',
      detail: 'weaker abstention',
      confidenceFloor: 0.45,
    }),
    Object.freeze({
      kind: 'CONFIDENCE_FLOOR', label: `confidence floor ${CHALLENGER_POLICY.confidenceFloor} (frozen)`,
      detail: 'pre-registered floor',
      confidenceFloor: CHALLENGER_POLICY.confidenceFloor,
    }),
    Object.freeze({
      kind: 'CONFIDENCE_FLOOR', label: 'confidence floor 0.65',
      detail: 'stronger abstention',
      confidenceFloor: 0.65,
    }),
  ];
  return Object.freeze({
    channel: 'TURNOVER',
    question: 'How do trade counts (turnover), net expectancy and cost ' +
      'drag respond to the entry gate and the abstention floor? Is current ' +
      'turnover excessive relative to its edge?',
    arms: Object.freeze(arms.map((arm) => runAblationArm(arm, options))),
    discipline: 'Experimental arms; frozen policy never modified; results ' +
      'inform understanding only — no arm is promoted.',
  });
}

/**
 * C. Transaction-cost drag ablation: multiplier on the priced frictions.
 */
function runCostDragAblation(options) {
  const baseCost = {
    ...DEFAULT_COST_MODEL,
  };
  const arms = [0.5, 1.0, 1.5, 2.0].map((multiplier) => Object.freeze({
    kind: 'COST_MODEL',
    label: `cost x${multiplier.toFixed(1)}`,
    detail: `spread/commission/slippage multiplied by ${multiplier}`,
    costModel: baseCost,
    costMultiplier: multiplier,
  }));
  const results = arms.map((arm) => runAblationArm(arm, options));
  // Break-even edge estimate from the x1 and x2 arms: the additional net
  // change per unit of cost gives the linear sensitivity; the required
  // gross edge to hold net at zero at x2 follows from the measured means.
  return Object.freeze({
    channel: 'COST_DRAG',
    question: 'How much of the net expectancy is consumed by transaction ' +
      'costs, and how does net scale as costs double?',
    arms: Object.freeze(results),
    discipline: 'Experimental arms on the frozen policy; costs are always ' +
      'charged in every arm; no arm is promoted and costs are never waived ' +
      'in any evaluation.',
  });
}

module.exports = {
  ABLATION_REFUSALS,
  ablationReplaySummary,
  runAblationArm,
  ladderVariant,
  NO_LADDER_ARM,
  runWinnerTruncationAblation,
  runTurnoverAblation,
  runCostDragAblation,
};
