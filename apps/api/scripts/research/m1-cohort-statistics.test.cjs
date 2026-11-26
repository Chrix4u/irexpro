'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  wilsonInterval,
  fisherExact2x2,
  aucStandardError,
  aucTest,
  minDetectableAucDelta,
  nNeededForAuc,
  analyzeCohort,
} = require('./m1-cohort-statistics.cjs');

// Reference values were independently computed with scipy (Fisher exact,
// Hanley-McNeil SE, Wilson intervals) before this file was written; the
// tests pin the agreement so the pure-JS math cannot silently drift.

test('Wilson intervals match independent scipy references', () => {
  const cases = [
    [105, 192, 0.4762, 0.6157],
    [86, 154, 0.4795, 0.6345],
    [19, 38, 0.3485, 0.6515],
  ];
  for (const [k, n, lo, hi] of cases) {
    const r = wilsonInterval(k, n);
    assert.ok(Math.abs(r.ci95[0] - lo) < 0.0006, `lower ${k}/${n}`);
    assert.ok(Math.abs(r.ci95[1] - hi) < 0.0006, `upper ${k}/${n}`);
  }
  // boundary sanity
  assert.equal(wilsonInterval(5, 0), null);
  assert.equal(wilsonInterval(-1, 10), null);
  assert.equal(wilsonInterval(11, 10), null);
});

test('two-sided Fisher exact matches scipy on three reference tables', () => {
  assert.ok(Math.abs(fisherExact2x2(86, 68, 19, 19).p - 0.5865) < 0.0001);
  assert.ok(Math.abs(fisherExact2x2(10, 0, 0, 10).p - 1.0825e-5) < 1e-8);
  assert.ok(Math.abs(fisherExact2x2(3, 1, 1, 3).p - 0.485714) < 1e-4);
});

test('Hanley-McNeil AUC inference matches scipy: 0.4752 is chance-level', () => {
  const se = aucStandardError(0.4752, 105, 87);
  assert.ok(Math.abs(se - 0.04196) < 0.0004);
  const t = aucTest(0.4752, 105, 87);
  assert.ok(Math.abs(t.z + 0.591) < 0.005);
  assert.ok(Math.abs(t.p - 0.5545) < 0.005);
  assert.ok(Math.abs(t.ci95[0] - 0.393) < 0.002);
  assert.ok(Math.abs(t.ci95[1] - 0.5574) < 0.002);
  assert.equal(aucStandardError(0, 5, 5), null);
});

test('detectability: the study can only see effects far larger than observed', () => {
  const mde = minDetectableAucDelta(105, 87);
  assert.ok(Math.abs(mde - 0.113) < 0.002);
  // observed deviation |0.4752-0.5| = 0.0248 is ~4.6x below detectability
  assert.ok(0.0248 < mde / 4);
  assert.equal(nNeededForAuc(0.05), 518);
  assert.equal(nNeededForAuc(0.1), 125);
});

test('cohort analysis reproduces the reported abstention review aggregates', () => {
  const r = analyzeCohort({
    total: 192,
    wins: 105,
    losses: 87,
    abstainedWins: 86,
    abstainedLosses: 68,
    auc: 0.4752,
    aucWinners: 105,
    aucLosers: 87,
  });
  assert.equal(r.counts.nonAbstained, 38);
  assert.equal(r.counts.nonAbstainedWins, 19);
  assert.equal(r.counts.nonAbstainedLosses, 19);
  assert.equal(r.group.overall.p.toFixed(4), '0.5469');
  assert.equal(r.group.abstained.p.toFixed(4), '0.5584');
  assert.equal(r.group.nonAbstained.p.toFixed(4), '0.5000');
  assert.ok(Math.abs(r.fisherExactAbstainedVsNonAbstained.p - 0.5865) < 1e-4);
  assert.ok(Math.abs(r.auc.p - 0.5545) < 0.005);
  // payoff asymmetry bound from net-negative cohorts
  assert.ok(Math.abs(r.payoffAsymmetry.breakevenAvgLossOverAvgWin - 1.2069) < 0.001);
  assert.ok(Math.abs(r.payoffAsymmetry.designBreakevenWinRate - 1 / 2.6) < 1e-12);
  // research-only posture
  assert.equal(r.executionAuthority, 'NONE');
  assert.equal(r.researchOnly, true);
  assert.ok(
    r.limitations.includes('selection bias') ||
      r.limitations.toLowerCase().includes('selection bias'),
  );
});

test('invalid aggregates are rejected instead of silently scored', () => {
  assert.equal(
    analyzeCohort({ total: 192, wins: 90, losses: 90, abstainedWins: 86, abstainedLosses: 68 }),
    null,
  ); // wins+losses != total
  assert.equal(
    analyzeCohort({ total: 100, wins: 60, losses: 40, abstainedWins: 70, abstainedLosses: 20 }),
    null,
  ); // abstainedWins > wins
  assert.equal(
    analyzeCohort({ total: 100, wins: 60, losses: 40, abstainedWins: 60.5, abstainedLosses: 0 }),
    null,
  ); // non-integer
  assert.equal(analyzeCohort({ total: 100, wins: 60, losses: 40 }), null); // missing abstention split
  // degenerate but internally consistent: every trade abstained
  const all = analyzeCohort({
    total: 100,
    wins: 60,
    losses: 40,
    abstainedWins: 60,
    abstainedLosses: 40,
  });
  assert.equal(all.counts.nonAbstained, 0);
  assert.equal(all.group.nonAbstained, null); // 0/0 has no interval; stays visible, never imputed
});
