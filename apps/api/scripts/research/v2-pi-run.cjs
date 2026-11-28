#!/usr/bin/env node
'use strict';
/**
 * V2 predictive-intelligence full-scale campaign runner (CLI, PI-5).
 * Executes the PI campaign at full scale on fully synthetic fixtures:
 *
 *   six symbols (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF),
 *   50 days of M1 base bars aggregated to M5/M15/H1/H4 context,
 *   three scenarios (null / planted continuation edge 0.56 / trend regimes),
 *   six-fold chronological walk-forward with purge + embargo,
 *   20% held-out preserved against tuning (final evaluation only),
 *   candidate classes: prior, L2 logistic, recency-weighted logistic,
 *   boosted stumps (25/100 rounds); ridge, AR(5), boosted regression.
 *
 * Deterministic: two runs produce byte-identical JSON.
 * Usage: node v2-pi-run.cjs [--days N] [--out DIR]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { runPiCampaign } = require('./v2-pi-campaign.cjs');

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

const days = arg('days', 50);
const outDir = path.join(
  repoRoot,
  'runs',
  'v2-pi-campaign-20261128',
);

console.log('[pi-run] full-scale campaign: days=%d symbols=6 folds=6 stumps=25/100', days);
console.log('[pi-run] scenarios: PI_NULL, PI_PLANTED_CONTINUATION (0.56), PI_TREND_REGIMES');

const result = runPiCampaign({
  days,
  symbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'],
  nFolds: 6,
  stumpsSmall: 25,
  stumpsLarge: 100,
  heldOutFraction: 0.2,
  plantedContinuationProb: 0.56,
  seedBases: {
    PI_NULL: 8100000,
    PI_PLANTED_CONTINUATION: 8200000,
    PI_TREND_REGIMES: 8300000,
  },
});

const json = JSON.stringify(result, null, 2);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'pi-results.json');
fs.writeFileSync(outFile, json + '\n');
const sha256 = crypto.createHash('sha256').update(json).digest('hex');

console.log('[pi-run] artifact: %s', path.relative(repoRoot, outFile));
console.log('[pi-run] bytes: %d', Buffer.byteLength(json));
console.log('[pi-run] sha256: %s', sha256);

// Key honest numbers for the record.
const fp = result.nullFpControl;
const sens = result.plantedSensitivity;
console.log('[pi-run] null FP control: %d/%d direction-task cells significant; family-wise rejections=%d (%s)',
  fp.significantPerCell, fp.cells, fp.familySignificant, fp.verdict);
const logi = sens.perModel['logistic-l2'];
console.log('[pi-run] planted sensitivity (direction task, logistic): null AUC %s, planted AUC %s (z=%s); fixture rate %s (planted 0.56)',
  logi.nullDirAuc === null ? 'null' : logi.nullDirAuc.toFixed(4),
  logi.plantedDirAuc === null ? 'null' : logi.plantedDirAuc.toFixed(4),
  logi.plantedDirZ === null ? 'null' : logi.plantedDirZ.toFixed(2),
  sens.fixtureContinuationRateAtTriggers === null ? 'null' : sens.fixtureContinuationRateAtTriggers.toFixed(4));
console.log('[pi-run] gate: %s (anyModelPasses=%s)',
  result.gate.recommendation, result.gate.anyModelPasses);
console.log('[pi-run] done.');
