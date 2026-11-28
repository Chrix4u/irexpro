#!/usr/bin/env node
'use strict';
/**
 * V2 Champion–Challenger DEMO evaluation run — the end-to-end offline
 * pipeline for independent review:
 *
 *   environment assembly (R1/R2/R4, fail-closed)
 *     -> paired campaign (7 metric families + ledger)
 *     -> null / known-edge / exit-dominance validation campaigns
 *     -> V1 broker evidence window (real data)
 *     -> comparative dashboard (read-only ledger projection)
 *     -> artifacts: results.json, attribution-ledger.jsonl,
 *        comparative-dashboard.html, REVIEW-CHECKLIST.md
 *
 * Deterministic for a given seed: two runs print identical SHA-256 hashes.
 * Usage: node v2-demo-evaluation-run.cjs [--seed N] [--out DIR]
 *   [--campaign-bars N] [--null-replays N] [--edge-trials N]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { generateMarketPath } = require('./v2-synthetic-market.cjs');
const {
  runCampaign,
  runNullCampaign,
  runKnownEdgeCampaign,
  runExitDominanceCampaign,
  exportLedgerJSONL,
} = require('./v2-offline-evaluation-harness.cjs');
const { renderComparativeDashboard } = require('./v2-comparative-dashboard.cjs');
const { loadBrokerEvidenceWindow } = require('./v2-broker-evidence-window.cjs');
const {
  assembleDemoEvaluationEnvironment,
  renderReviewChecklist,
} = require('./v2-demo-evaluation-environment.cjs');
const { verifyExitEnginePaths } = require('./v2-exit-intelligence-contract.cjs');
const { verifyComponentPaths, ENGINE_COMPONENT_MAP } = require('./v2-engine-component-map.cjs');
const { scanRedundantCode, reconcileRedundantCodeInventory } = require('./v2-redundant-code-inventory.cjs');

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

const seed = arg('seed', 20261128);
const campaignBars = arg('campaign-bars', 3000);
const nullReplays = arg('null-replays', 200);
const edgeTrials = arg('edge-trials', 60);
const outDir = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(repoRoot, 'runs', `v2-demo-evaluation-${seed}`);

console.log(`iRexPro V2 Challenger — DEMO evaluation run`);
console.log(`seed=${seed} campaignBars=${campaignBars} nullReplays=${nullReplays} edgeTrials=${edgeTrials}`);
console.log(`out=${outDir}`);

// 0. Contract revalidation (drift detectors) — fail-closed before anything.
const exitPaths = verifyExitEnginePaths(repoRoot);
const componentPaths = verifyComponentPaths(ENGINE_COMPONENT_MAP, repoRoot);
console.log(`[audit] exit-engine paths: ${exitPaths.verified}/${exitPaths.total}; component-map paths: ${componentPaths.verified}/${componentPaths.total}`);
const redundancy = scanRedundantCode(repoRoot, {
  componentFilePaths: ENGINE_COMPONENT_MAP.components.map((c) => c.path),
});
const redundancyReconciliation = reconcileRedundantCodeInventory(redundancy);
if (!redundancyReconciliation.reconciled) {
  throw new Error(`P1_6_RECONCILIATION_FAILED:${redundancyReconciliation.problems.join(';')}`);
}
console.log(`[audit] P1-6 inventory reconciled (${redundancy.deadImports.length} dead imports, ${redundancy.deprecatedShims.length} shims, ${redundancy.duplicateConstants.length} duplicate-constant groups)`);

// 1. Environment assembly — fail-closed (R1/R2/R4).
const environment = assembleDemoEvaluationEnvironment({
  startingBalanceUsd: 50000,
  leverage: 30,
  instruments: ['EURUSD'],
});
console.log('[env] R1 isolation + R4 equivalence asserted; identities registered (generation 1)');

// 2. Paired campaign.
const market = generateMarketPath({ seed, nBars: campaignBars, scenario: 'TREND_REGIMES' });
const campaign = runCampaign({ market });
console.log(`[campaign] champion trades=${campaign.champion.tradeCount} challenger trades=${campaign.challenger.tradeCount} ledger rows=${campaign.ledger.count()}`);

// 3. Validation campaigns.
const nullCampaign = runNullCampaign({ replays: nullReplays, nBars: 900, seedBase: 900000 + seed % 1000 });
console.log(`[null] FP rates: champion=${nullCampaign.falsePositiveRate.champion} challenger=${nullCampaign.falsePositiveRate.challenger} paired=${nullCampaign.falsePositiveRate.pairedWinRate}`);
const edgeCampaign = runKnownEdgeCampaign({ aucTargets: [0.55, 0.60], trials: edgeTrials, seedBase: 700000 });
for (const c of edgeCampaign.campaigns) {
  console.log(`[edge] planted=${c.plantedAuc} measured=${c.meanMeasuredAuc.toFixed(4)} detection=${c.detectionRate.toFixed(3)}`);
}
const dominance = runExitDominanceCampaign({ seed: seed + 2, nBars: Math.max(1500, campaignBars / 2) });
console.log(`[dominance] truncation share=${dominance.controlledTruncation.attributionShare.toFixed(4)} extension share=${dominance.controlledExtension.attributionShare.toFixed(4)}`);

// 4. V1 broker evidence window (real data).
const evidence = loadBrokerEvidenceWindow(repoRoot);
console.log(`[evidence] ${evidence.dealCount} deals, net=${evidence.netUsd} USD, verification=${JSON.stringify(evidence.verification)}`);

// 5. Dashboard + artifacts.
const dashboard = renderComparativeDashboard({
  campaign,
  nullCampaign,
  edgeCampaign,
  dominance,
  evidence,
  meta: {
    generatedFor: 'v2-demo-evaluation-run (offline evaluation harness)',
    branch: 'research/ai-engine-v2-champion-challenger-20261127',
  },
});
const ledgerJsonl = exportLedgerJSONL(campaign.ledger);
const checklist = renderReviewChecklist(environment, {
  seed,
  startingBalanceUsd: 50000,
  leverage: 30,
  instruments: ['EURUSD'],
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'comparative-dashboard.html'), dashboard);
fs.writeFileSync(path.join(outDir, 'attribution-ledger.jsonl'), ledgerJsonl);
fs.writeFileSync(path.join(outDir, 'REVIEW-CHECKLIST.md'), checklist);

const results = {
  artifact: 'v2-demo-evaluation-run-v1',
  seed,
  campaignBars,
  nullReplays,
  edgeTrials,
  environment: {
    championIdentity: environment.championIdentity,
    challengerIdentity: environment.challengerIdentity,
    isolation: environment.isolation,
    equivalence: environment.equivalence,
    requirements: environment.requirements,
    blockedPendingReview: environment.blockedPendingReview,
  },
  audits: {
    exitEnginePaths: exitPaths,
    componentMapPaths: componentPaths,
    p1_6Redundancy: {
      deadImports: redundancy.deadImports,
      deprecatedShims: redundancy.deprecatedShims,
      duplicateConstantGroups: redundancy.duplicateConstants.length,
      unusedExportCandidates: redundancy.unusedExportCandidates.length,
      nearDuplicateFilePairs: redundancy.nearDuplicateFiles.length,
      reconciled: redundancyReconciliation.reconciled,
    },
  },
  campaign: {
    market: campaign.market,
    champion: campaign.champion,
    challenger: campaign.challenger,
    reversalDetection: campaign.reversalDetection,
    winRateComparison: campaign.winRateComparison,
    replayNetTotals: campaign.replayNetTotals,
  },
  nullCampaign,
  edgeCampaign,
  dominance,
  evidence: {
    provenance: evidence.provenance,
    file: evidence.file,
    dealCount: evidence.dealCount,
    netUsd: evidence.netUsd,
    winRate: evidence.winRate,
    profitFactor: evidence.profitFactor,
    expectancyUsdPerTrade: evidence.expectancyUsdPerTrade,
    firstBalanceUsd: evidence.firstBalanceUsd,
    lastBalanceUsd: evidence.lastBalanceUsd,
    summaryBalanceUsd: evidence.summaryBalanceUsd,
    windowVsAccountGapUsd: evidence.windowVsAccountGapUsd,
    medianImpliedFrictionPipsPerLot: evidence.medianImpliedFrictionPipsPerLot,
    verification: evidence.verification,
    splitSecondPair: evidence.splitSecondPair,
    deals: evidence.deals,
  },
  ledgerRowCount: campaign.ledger.count(),
  ledgerSummary: campaign.ledger.summarize(),
};
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));

const hash = (name) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(outDir, name))).digest('hex');
console.log('[artifacts] SHA-256:');
for (const name of ['comparative-dashboard.html', 'attribution-ledger.jsonl',
  'results.json', 'REVIEW-CHECKLIST.md']) {
  console.log(`  ${name}: ${hash(name)}`);
}
console.log('done.');
