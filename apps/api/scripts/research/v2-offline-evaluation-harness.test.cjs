'use strict';
/** Tests for the offline evaluation harness (P2/P3 metric families
 * and validation campaigns). */

const test = require('node:test');
const assert = require('node:assert');

const {
  normalCdf,
  normalQuantile,
  mannWhitneyAUC,
  settleRegistrations,
  matchReversalEvents,
  evaluateCommonOpportunityEntries,
  evaluateEntryDiscrimination,
  evaluateExitEfficiency,
  runCampaign,
  runNullCampaign,
  runKnownEdgeCampaign,
  runExitDominanceCampaign,
  exportLedgerJSONL,
  importLedgerJSONL,
  verifyLedgerRoundTrip,
} = require('./v2-offline-evaluation-harness.cjs');

test('normal CDF and quantile invert each other', () => {
  for (const p of [0.01, 0.05, 0.3, 0.5, 0.7, 0.95, 0.99]) {
    const q = normalQuantile(p);
    assert.ok(Math.abs(normalCdf(q) - p) < 1e-6, `p=${p}`);
  }
  assert.throws(() => normalQuantile(0), /HARNESS_QUANTILE_INVALID/);
  assert.throws(() => normalQuantile(1), /HARNESS_QUANTILE_INVALID/);
});

test('Mann-Whitney AUC is exact on pinned cases', () => {
  assert.strictEqual(mannWhitneyAUC([
    { score: 3, outcome: 1 }, { score: 2, outcome: 1 },
    { score: 1, outcome: 0 }, { score: 0, outcome: 0 },
  ]), 1);
  assert.strictEqual(mannWhitneyAUC([
    { score: 1, outcome: 1 }, { score: 1, outcome: 0 },
  ]), 0.5);
  assert.throws(() => mannWhitneyAUC([{ score: 1, outcome: 1 }]),
    /HARNESS_AUC_CLASS_EMPTY/);
});

test('registrations settle against realized forward outcomes', () => {
  const bars = [
    { close: 1.10 }, { close: 1.10 }, { close: 1.10 }, { close: 1.10 },
    { close: 1.10 }, { close: 1.10 }, { close: 1.11 },
  ];
  const settled = settleRegistrations([
    { bar: 0, direction: 'BUY', probability: 0.7, windowBars: 6 },
    { bar: 0, direction: 'SELL', probability: 0.4, windowBars: 6 },
    { bar: 1, direction: 'BUY', probability: 0.6, windowBars: 6 },
  ], bars);
  assert.strictEqual(settled[0].outcome, 1); // up 1 pip over 6 bars
  assert.strictEqual(settled[1].outcome, 0);
  assert.strictEqual(settled.length, 2); // bar 1 target out of range
});

test('runCampaign computes all seven metric families per engine', () => {
  const campaign = runCampaign({ seed: 20261128, nBars: 1500, scenario: 'TREND_REGIMES' });
  for (const side of ['champion', 'challenger']) {
    const m = campaign[side];
    assert.ok(m.tradeCount > 20);
    // 1 entry discrimination
    assert.ok(Number.isFinite(m.discrimination.auc));
    assert.ok(Number.isFinite(m.discrimination.se));
    // 2 confidence calibration
    assert.ok(m.calibration === null || Number.isFinite(m.calibration.brierScore));
    // 3 reversal detection (challenger only, campaign-level)
    // 4/5 exit efficiency + retention
    assert.ok(m.exitEfficiency.exitReasons);
    assert.ok(Number.isFinite(m.exitEfficiency.meanCapture));
    // 6 cost-adjusted expectancy
    assert.ok(Number.isFinite(m.performance.meanNetR));
    assert.ok(m.performance.winRateWilson95[0] !== null);
    // 7 drawdown
    assert.ok(Number.isFinite(m.drawdown.equityMaxDDUsd));
    assert.ok(m.drawdown.tradeLevelMaxDDR !== null);
    // decomposition identity holds for every settled trade
    assert.strictEqual(m.decomposition.identityHoldsForAll, true);
  }
  assert.ok(campaign.reversalDetection !== null);
  assert.ok(campaign.reversalDetection.recall >= 0);
  assert.ok(campaign.ledger.count() ===
    campaign.champion.tradeCount + campaign.challenger.tradeCount);
});

test('null campaign false-positive rate is within tolerance (60 replays)', () => {
  const nullC = runNullCampaign({ replays: 60, nBars: 900, seedBase: 910000 });
  assert.strictEqual(nullC.eligible.champion, 60);
  // Deterministic subset: FP counts pinned; nominal 5%, tolerance bound.
  assert.ok(nullC.falsePositiveRate.champion <= 0.15,
    `champion FP ${nullC.falsePositiveRate.champion}`);
  assert.ok(nullC.falsePositiveRate.challenger <= 0.15,
    `challenger FP ${nullC.falsePositiveRate.challenger}`);
  assert.ok(nullC.falsePositiveRate.pairedWinRate <= 0.15,
    `paired FP ${nullC.falsePositiveRate.pairedWinRate}`);
});

test('known-edge campaign recovers planted AUC and detection power', () => {
  const edge = runKnownEdgeCampaign({ aucTargets: [0.55], trials: 60, seedBase: 720000 });
  const c = edge.campaigns[0];
  assert.ok(Math.abs(c.meanMeasuredAuc - c.plantedAuc) < 0.02,
    `measured ${c.meanMeasuredAuc} vs planted ${c.plantedAuc}`);
  assert.ok(c.detectionRate > 0.5, `detection ${c.detectionRate}`);
  assert.ok(c.perClassN > 0);
});

test('exit-dominance attributes >= 90% of each planted deficit', () => {
  const dom = runExitDominanceCampaign({ seed: 20261130, nBars: 1500 });
  assert.strictEqual(dom.controlledTruncation.dominant, 'WIN_TRUNCATION');
  assert.ok(dom.controlledTruncation.attributionShare >= 0.9,
    `truncation share ${dom.controlledTruncation.attributionShare}`);
  assert.strictEqual(dom.controlledExtension.dominant, 'LOSS_EXTENSION');
  assert.ok(dom.controlledExtension.attributionShare >= 0.9,
    `extension share ${dom.controlledExtension.attributionShare}`);
  assert.ok(dom.observational.winTruncationShare > 0);
});

test('ledger JSONL persistence round-trips exactly', () => {
  const campaign = runCampaign({ seed: 5150, nBars: 1200, scenario: 'TREND_REGIMES' });
  const jsonl = exportLedgerJSONL(campaign.ledger);
  const { ledger: imported, badLines } = importLedgerJSONL(jsonl);
  assert.strictEqual(badLines.length, 0);
  const proof = verifyLedgerRoundTrip(campaign.ledger, imported);
  assert.strictEqual(proof.rowsEqual, true);
  assert.strictEqual(proof.netTotalsEqual, true);
  // Tampering with a settled value changes the recomputed net on import —
  // detected by the round-trip comparison, never silently accepted.
  const tampered = jsonl.split('\n').map((line, i) => {
    if (i === 0) {
      const row = JSON.parse(line);
      row.grossPnl += 100;
      return JSON.stringify(row);
    }
    return line;
  }).join('\n');
  const { ledger: tamperedLedger } = importLedgerJSONL(tampered);
  const tamperProof = verifyLedgerRoundTrip(campaign.ledger, tamperedLedger);
  assert.strictEqual(tamperProof.netTotalsEqual, false);
});

test('persistence refusals', () => {
  assert.throws(() => exportLedgerJSONL(null), /HARNESS_LEDGER_REQUIRED/);
  assert.throws(() => importLedgerJSONL(''), /HARNESS_LEDGER_JSONL_EMPTY/);
});

test('exit efficiency captures retention and loss-cut asymmetries', () => {
  const trades = [
    { grossR: 0.8, mfeR: 1.6, maeR: -0.2, netR: 0.6, exitReason: 'LOCK_TRAIL' },
    { grossR: -0.4, mfeR: 0.3, maeR: -0.8, netR: -0.6, exitReason: 'DRAWDOWN_GUARD' },
    { grossR: -1.0, mfeR: 0.1, maeR: -1.0, netR: -1.2, exitReason: 'STOP_LOSS' },
  ];
  const eff = evaluateExitEfficiency(trades);
  // Capture includes give-back trades: (0.8/1.6 + (-0.4/0.3)) / 2.
  assert.ok(Math.abs(eff.meanCapture - (0.5 + (-0.4 / 0.3)) / 2) < 1e-9);
  assert.ok(Math.abs(eff.meanLossCut - (0.4 / 0.8 + 1.0 / 1.0) / 2) < 1e-9);
  assert.strictEqual(eff.exitReasons.LOCK_TRAIL.count, 1);
  assert.ok(Math.abs(eff.exitReasons.DRAWDOWN_GUARD.meanNetR - (-0.6)) < 1e-9);
});

test('entry discrimination refuses empty inputs', () => {
  assert.throws(() => evaluateEntryDiscrimination([]), /HARNESS_DISCRIMINATION_EMPTY/);
});

test('reversal one-to-one matching: repeated observations are not true positives', () => {
  // One ground-truth point at bar 100; three events in tolerance; one far.
  const events = [{ bar: 98 }, { bar: 99 }, { bar: 103 }, { bar: 500 }];
  const points = [{ bar: 100, directional: true }];
  const m = matchReversalEvents(events, points, 12);
  // Nearest event (99) claims the point; 98 and 103 are repeated
  // observations; 500 has no point in tolerance -> false alarm.
  assert.strictEqual(m.truePositives, 1);
  assert.strictEqual(m.repeatedObservations, 2);
  assert.strictEqual(m.falseAlarms, 1);
  assert.strictEqual(m.pairs[0].eventBar, 99);
  assert.strictEqual(m.pairs[0].pointBar, 100);
  assert.strictEqual(m.pairs[0].leadBars, -1);
  // Conservation: every event is exactly one of TP/repeated/falseAlarm.
  assert.strictEqual(m.truePositives + m.repeatedObservations + m.falseAlarms,
    events.length);
});

test('reversal one-to-one matching: two points two events pair one-to-one', () => {
  const events = [{ bar: 200 }, { bar: 410 }];
  const points = [{ bar: 190, directional: true }, { bar: 400, directional: true }];
  const m = matchReversalEvents(events, points, 12);
  assert.strictEqual(m.truePositives, 2);
  assert.strictEqual(m.repeatedObservations, 0);
  assert.strictEqual(m.falseAlarms, 0);
  assert.deepStrictEqual(m.pairs.map((p) => p.leadBars), [10, 10]);
});

test('reversal one-to-one matching refusals', () => {
  assert.throws(() => matchReversalEvents(null, [], 5), /HARNESS_REVERSAL_INPUT_REQUIRED/);
  assert.throws(() => matchReversalEvents([], null, 5), /HARNESS_REVERSAL_INPUT_REQUIRED/);
  assert.throws(() => matchReversalEvents([], [], -1), /HARNESS_REVERSAL_TOL_INVALID/);
  assert.throws(() => matchReversalEvents([], [], 1.5), /HARNESS_REVERSAL_TOL_INVALID/);
});

test('common-opportunity entry evaluation: identical outcomes, abstention split', () => {
  // Fabricated replay with windowBars=1 so forward outcomes are directly
  // controlled by the bar sequence. Champion registers bars 0..4; the
  // challenger takes 0,2,4 and abstains on 1,3.
  const closes = [1.10, 1.11, 1.09, 1.10, 1.09, 1.10];
  const bars = closes.map((c, i) => ({ i, close: c }));
  const reg = (bar, direction, probability) => ({
    bar, direction, probability, windowBars: 1,
  });
  const replay = {
    champion: { registrations: [
      reg(0, 'BUY', 0.7), reg(1, 'BUY', 0.65), reg(2, 'SELL', 0.6),
      reg(3, 'BUY', 0.55), reg(4, 'BUY', 0.5),
    ] },
    // challenger takes bars 0 (BUY up -> win), 2 (SELL on up -> loss),
    // 4 (BUY up -> win); abstains bars 1, 3 (both BUY on down -> losses).
    challenger: { registrations: [
      reg(0, 'BUY', 0.7), reg(2, 'SELL', 0.6), reg(4, 'BUY', 0.5),
    ] },
  };
  const ei = evaluateCommonOpportunityEntries(replay, { bars });
  assert.strictEqual(ei.method, 'COMMON_OPPORTUNITY_GRID');
  assert.strictEqual(ei.commonOpportunities, 3);
  // Identical outcome definition for both engines on the common grid.
  assert.strictEqual(ei.challengerAbstention.takenCount, 3);
  assert.strictEqual(ei.challengerAbstention.takenWinRate, 2 / 3);
  assert.strictEqual(ei.challengerAbstention.abstainedCount, 2);
  assert.strictEqual(ei.challengerAbstention.abstainedWinRate, 0);
  // Small-sample difference comparison is a typed refusal, never forced.
  assert.ok(ei.challengerAbstention.winRateDifference.refused !== undefined);
  // AUC on the common set: positives {0.7, 0.5}, negative {0.6} -> 0.5.
  assert.ok(Math.abs(ei.sharedScoreDiscrimination.auc - 0.5) < 1e-12);
  assert.strictEqual(ei.sharedScoreDiscrimination.n, 3);
  assert.throws(() => evaluateCommonOpportunityEntries(null, { bars }),
    /HARNESS_COMMON_OPPORTUNITY_INPUT_REQUIRED/);
});

test('runCampaign reports one-to-one reversal stats and entry intelligence', () => {
  const campaign = runCampaign({ seed: 20261128, nBars: 1500, scenario: 'TREND_REGIMES' });
  const rd = campaign.reversalDetection;
  assert.strictEqual(rd.truePositives + rd.repeatedObservations + rd.falseAlarms,
    rd.events);
  assert.ok(Math.abs(rd.precision - rd.truePositives / rd.events) < 1e-12);
  assert.ok(Math.abs(rd.recall - rd.truePositives / rd.groundTruthPoints) < 1e-12);
  assert.ok(Number.isFinite(rd.medianDetectionLatencyBars));
  // Entry intelligence: common grid with identical outcomes.
  const ei = campaign.entryIntelligence;
  assert.strictEqual(ei.method, 'COMMON_OPPORTUNITY_GRID');
  assert.ok(ei.commonOpportunities > 0);
  assert.ok(Number.isFinite(ei.sharedScoreDiscrimination.auc));
  assert.ok(ei.challengerAbstention.takenCount > 0);
  assert.ok(ei.challengerAbstention.takenCount + ei.challengerAbstention.abstainedCount > 0);
  // Comparison semantics: the champion side is labeled a simplified mirror.
  assert.strictEqual(campaign.comparisonSemantics.championSide, 'SIMPLIFIED_S1_MIRROR');
  assert.ok(campaign.comparisonSemantics.note.includes('NOT the complete deployed V1 Champion'));
});
