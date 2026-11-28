#!/usr/bin/env node
'use strict';
/**
 * V2 E-10 full-scale campaign runner (CLI). Executes:
 *
 *   1. null false-positive campaign, 1,000 replays;
 *   2. known-edge detection-power campaign, 1,000 trials per target;
 *   3. multi-instrument paired replay matrix (EURUSD + GBPUSD x 4 regimes,
 *      250 replays per cell = 2,000 paired replays) with per-cell
 *      uncertainty intervals;
 *   4. chronological walk-forward variant (both instruments, 7,200 bars,
 *      6 folds each);
 *   5. controlled ablation campaign (winner truncation / turnover /
 *      cost drag; seed family 43xxxxx, disjoint from E-10 families and
 *      from the untouched final held-out family 47xxxxx).
 *
 * Deterministic: two runs print identical SHA-256 hashes.
 * Usage: node v2-e10-run.cjs [--null-replays N] [--edge-trials N]
 *   [--cell-replays N] [--ablation-replays N] [--out DIR]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  runNullCampaign,
  runKnownEdgeCampaign,
} = require('./v2-offline-evaluation-harness.cjs');
const {
  runMultiInstrumentMatrix,
  runWalkForwardCampaign,
} = require('./v2-e10-campaign.cjs');
const {
  runWinnerTruncationAblation,
  runTurnoverAblation,
  runCostDragAblation,
} = require('./v2-ablation-campaign.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function arg(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index !== -1 && process.argv[index + 1] !== undefined) {
    const value = Number(process.argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  }
  return fallback;
}

const nullReplays = arg('null-replays', 1000);
const edgeTrials = arg('edge-trials', 1000);
const cellReplays = arg('cell-replays', 250);
const ablationReplays = arg('ablation-replays', 250);
const outDir = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(repoRoot, 'runs', 'v2-e10-campaign-20261128');

console.log('iRexPro V2 — E-10 full-scale campaign');
console.log(`null=${nullReplays} edgeTrials=${edgeTrials} cellReplays=${cellReplays} ablationReplays=${ablationReplays}`);
console.log(`out=${outDir}`);

// 1. Null campaign (P3-1 at full scale).
console.log('[null] running...');
const nullCampaign = runNullCampaign({
  replays: nullReplays, nBars: 900, seedBase: 900000,
});
console.log(`[null] FP rates: champion=${nullCampaign.falsePositiveRate.champion} challenger=${nullCampaign.falsePositiveRate.challenger} paired=${nullCampaign.falsePositiveRate.pairedWinRate}`);

// 2. Known-edge campaign (P3-2 at full scale).
console.log('[edge] running...');
const edgeCampaign = runKnownEdgeCampaign({
  aucTargets: [0.55, 0.60], trials: edgeTrials, seedBase: 700000,
});
for (const c of edgeCampaign.campaigns) {
  console.log(`[edge] planted=${c.plantedAuc} measured=${c.meanMeasuredAuc.toFixed(4)} detection=${c.detectionRate.toFixed(3)}`);
}

// 3. Multi-instrument matrix.
console.log('[matrix] running...');
const matrix = runMultiInstrumentMatrix({
  instruments: ['EURUSD', 'GBPUSD'],
  scenarios: ['TREND_REGIMES', 'EDGE_ZERO', 'REVERSION', 'PLANTED_DRIFT'],
  replaysPerCell: cellReplays,
  nBars: 1200,
  seedBase: 4100000,
});
for (const cell of matrix.cells) {
  const agg = cell.aggregate.challengerNetR;
  console.log(`[matrix] ${cell.instrument} ${cell.scenario}: challenger netR ${agg.mean !== null ? agg.mean.toFixed(3) : 'refused'} [${agg.interval95 ? agg.interval95.map((v) => v.toFixed(3)).join(', ') : '—'}]`);
}

// 4. Walk-forward variant (chronological, leakage-controlled).
console.log('[walk-forward] running...');
const walkForward = [
  runWalkForwardCampaign({ instrument: 'EURUSD', seed: 4510001, nBars: 7200, folds: 6 }),
  runWalkForwardCampaign({ instrument: 'GBPUSD', seed: 4520002, nBars: 7200, folds: 6 }),
];
for (const wf of walkForward) {
  console.log(`[walk-forward] ${wf.instrument}: cumulative paired delta ${wf.cumulativeDeltaNetR.toFixed(3)} R over ${wf.folds} folds (${wf.scenario})`);
}

// 5. Controlled ablations (seed family 43xxxxx; disjoint from 41/45/47).
console.log('[ablation] running...');
const ablationOptions = { replays: ablationReplays, nBars: 1200, seedBase: 4350000 };
const ablations = {
  winnerTruncation: runWinnerTruncationAblation(ablationOptions),
  turnover: runTurnoverAblation(ablationOptions),
  costDrag: runCostDragAblation(ablationOptions),
};
for (const block of Object.values(ablations)) {
  for (const arm of block.arms) {
    console.log(`[ablation:${block.channel}] ${arm.arm}: trades=${arm.tradesPerReplay.mean !== null ? arm.tradesPerReplay.mean.toFixed(1) : 'ref'} netR=${arm.meanNetR.mean !== null ? arm.meanNetR.mean.toFixed(3) : 'ref'} costR=${arm.meanCostR.mean !== null ? arm.meanCostR.mean.toFixed(3) : 'ref'}`);
  }
}

const results = {
  artifact: 'v2-e10-campaign-v1',
  date: '2026-11-28',
  nullCampaign,
  edgeCampaign,
  matrix,
  walkForward: Object.freeze(walkForward),
  ablations,
  independentReplayTotals: Object.freeze({
    nullReplays,
    matrixPairedReplays: matrix.totalPairedReplays,
    ablationReplays: (ablations.winnerTruncation.arms.length +
      ablations.turnover.arms.length + ablations.costDrag.arms.length) * ablationReplays,
    edgeTrialsPerTarget: edgeTrials,
    walkForwardFoldReplays: walkForward.reduce((s, wf) => s + wf.folds, 0),
  }),
  seedDiscipline: 'null=9xxxxxx (harness base); matrix=41xxxxx; ' +
    'walk-forward=45xxxxx; ablations=43xxxxx; final held-out evaluation ' +
    'family 47xxxxx is untouched by this campaign (no optimization against ' +
    'the held-out dataset; ablation arms are experimental and the frozen ' +
    'pre-registered challenger preset/policy is never modified).',
  constraintSemantics: 'All markets synthetic; broker-calibrated costs ' +
    'always charged; champion side is the simplified S1 mirror ' +
    '(SIMPLIFIED_S1_MIRROR), not the deployed V1 Champion; the only ' +
    'actual-V1 datum is the broker-confirmed evidence window (E-7). ' +
    'Negative results are reported exactly as positive ones; no ' +
    'profitability claim is made or implied.',
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'e10-results.json'), JSON.stringify(results, null, 2));

const hash = (name) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(outDir, name))).digest('hex');
console.log('[artifacts] SHA-256:');
console.log(`  e10-results.json: ${hash('e10-results.json')}`);
console.log('done.');
