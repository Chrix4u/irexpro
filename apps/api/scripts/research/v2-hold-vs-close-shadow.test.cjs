'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  freezeProtocol, evaluateHoldVsClose, exactTwoSidedSignTest,
  DEFAULT_PROTOCOL, VERDICTS, DISCLAIMER,
} = require('./v2-hold-vs-close-shadow.cjs');

// Fixture A: TP (1.6R) first-touch at minute 10; mae never reaches -1R.
// Observed close at minute 5 with realized +0.4R.
function pathA(lastMinute = 70) {
  const path = [];
  for (let m = 0; m <= lastMinute; m++) {
    path.push({
      minute: m,
      mfeR: Math.min(0.16 * m, 1.6),
      maeR: -0.2,
      closeR: m === 6 ? 0.35 : 0.3,
    });
  }
  return path;
}

function caseA(id, observedNetR = 0.4, lastMinute = 70) {
  return {
    caseId: id,
    instrument: 'EURUSD',
    direction: 'BUY',
    observed: { closeMinute: 5, exitType: 'PROFIT_PROTECTION', realizedNetR: observedNetR },
    path: pathA(lastMinute),
  };
}

// Fixture B: running excursions reach BOTH the stop (-1.2R mae) and the
// target (1.7R mfe) at minute 8: the pre-registered worst-case rule resolves
// the same-minute double touch as STOP first.
function caseB(id) {
  const path = [];
  for (let m = 0; m <= 30; m++) {
    path.push({
      minute: m,
      mfeR: Math.min(0.2 * m, 1.7),
      maeR: Math.max(-0.15 * m, -1.2),
      closeR: 0.1,
    });
  }
  return {
    caseId: id,
    instrument: 'GBPUSD',
    direction: 'SELL',
    observed: { closeMinute: 5, exitType: 'BROKER_CLOSE', realizedNetR: 0.3 },
    path,
  };
}

function frozen() {
  const f = freezeProtocol(DEFAULT_PROTOCOL);
  assert.ok(!f.error, JSON.stringify(f));
  return f;
}

test('the protocol freezes: canonical, SHA-pinned, and the pinned hash re-verifies', () => {
  const f = frozen();
  assert.match(f.protocolSha, /^[0-9a-f]{64}$/);
  const f2 = freezeProtocol(DEFAULT_PROTOCOL);
  assert.equal(f.protocolSha, f2.protocolSha);
});

test('hold-vs-close horizons are hand-computed: +1min mark-to-path, +15/+60min first-touch target', () => {
  const out = evaluateHoldVsClose(frozen(), [caseA('cA')]);
  assert.ok(out.ok, JSON.stringify(out));
  const h1 = out.horizons[1];
  // (5,6]: no touch, closeR(6)=0.35, cost 0.2 -> hold 0.15; observed 0.4 -> diff -0.25
  assert.equal(h1.horizonMinutes, 1);
  assert.ok(Math.abs(h1.meanHoldMinusObservedR - (0.15 - 0.4)) < 1e-12);
  const h15 = out.horizons[15];
  // TP first touch at minute 10: 1.6 - 0.2 = 1.4; diff 1.4 - 0.4 = +1.0
  assert.ok(Math.abs(h15.meanHoldMinusObservedR - 1.0) < 1e-12);
  const h60 = out.horizons[60];
  assert.ok(Math.abs(h60.meanHoldMinusObservedR - 1.0) < 1e-12);
  assert.equal(h15.signTest.n, 1);
});

test('worst-case same-minute rule: a minute touching both bracket arms resolves as the STOP', () => {
  const out = evaluateHoldVsClose(frozen(), [caseB('cB')]);
  const h15 = out.horizons[15];
  // stop first at minute 7 (maeR -1.05 <= -1.0; mfeR still below target):
  // -1.0 - 0.2 = -1.2 vs observed +0.3 -> diff -1.5
  assert.ok(Math.abs(h15.meanHoldMinusObservedR - (-1.5)) < 1e-12);
  // the path ends at minute 30: the +60 horizon is a PATH_GAP, excluded and counted
  assert.equal(out.horizons[60].excludedCount, 1);
  assert.equal(out.horizons[60].excluded[0].reason, 'PATH_GAP');
});

test('path gaps exclude ONLY the affected horizon and are counted, never imputed', () => {
  const out = evaluateHoldVsClose(frozen(), [caseA('cA', 0.4, 40)]); // path ends at minute 40
  assert.equal(out.horizons[1].excludedCount, 0); // minute 6 exists
  assert.equal(out.horizons[15].excludedCount, 0); // (5,20] exists
  assert.equal(out.horizons[60].excludedCount, 1); // (5,65] missing 25 minutes
  assert.equal(out.horizons[60].pairedCases, 0);
  assert.equal(out.horizons[60].excluded[0].reason, 'PATH_GAP');
});

test('exact two-sided sign test p-values match hand-computed binomial tails', () => {
  const s1 = exactTwoSidedSignTest([1, 2, -1, 3, 4, -2, 5, 6], 0.05); // 6 pos / 2 neg of 8
  assert.ok(Math.abs(s1.pValue - 2 * 37 / 256) < 1e-12); // 2*(C(8,0)+C(8,1)+C(8,2))/2^8
  const s2 = exactTwoSidedSignTest([5, 5, 5, 5, 5], 0.05);
  assert.ok(Math.abs(s2.pValue - 2 / 32) < 1e-12); // 5/5 positives: 2/2^5
  const s3 = exactTwoSidedSignTest([1, -1, 1, -1], 0.05); // symmetric: p = 1
  assert.ok(Math.abs(s3.pValue - 1) < 1e-12);
  const s4 = exactTwoSidedSignTest([0, 0, 1], 0.05); // zeros excluded from the test
  assert.equal(s4.n, 1);
  assert.equal(s4.zeros, 2);
});

test('amending the protocol after freeze is refused: PROTOCOL_MISMATCH', () => {
  const f = frozen();
  const amended = { ...f, protocol: { ...f.protocol, horizonsMinutes: [1, 15, 60, 240] } };
  const out = evaluateHoldVsClose(amended, [caseA('cA')]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PROTOCOL_MISMATCH');
});

test('malformed inputs: duplicate caseId removes the case entirely; bad paths are refused', () => {
  const out = evaluateHoldVsClose(frozen(), [caseA('cA'), caseA('cA')]);
  assert.equal(out.ok, true); // evaluation proceeds for the clean cases
  assert.equal(out.refusals.filter((r) => r.code === 'DUPLICATE_CASE').length, 1);
  assert.equal(out.horizons[15].pairedCases, 0); // the duplicated identity is ambiguous: excluded

  const broken = evaluateHoldVsClose(frozen(), [
    { ...caseA('cX'), path: [{ minute: 0, mfeR: 0, maeR: 0, closeR: 0 }, { minute: 0, mfeR: 0, maeR: 0, closeR: 0 }] },
    caseA('cA'),
  ]);
  assert.equal(broken.refusals.filter((r) => r.code === 'MALFORMED_PATH').length, 1);
  assert.equal(broken.horizons[15].pairedCases, 1); // the clean case still evaluates
});

test('sample sufficiency: fewer than minPairedCases yields INSUFFICIENT_PAIRED_CASES, never a verdict', () => {
  const out = evaluateHoldVsClose(frozen(), [caseA('cA'), caseB('cB')]);
  assert.equal(out.verdict, 'INSUFFICIENT_PAIRED_CASES');
  assert.equal(out.horizons[15].pairedCases, 2); // 2 < 30: described, not judged
  assert.equal(typeof out.horizons[15].signTest.pValue, 'number');
  assert.equal(out.horizons[15].signTest.rejectAtAlpha, false); // 1 pos / 1 neg of 2: p=1, not significant
});

test('with 30 paired cases the verdict is DESCRIBED_PAIRED_DIFFERENCE and never an adoption claim', () => {
  const cases = Array.from({ length: 30 }, (_, i) => caseA(`c${i}`));
  const out = evaluateHoldVsClose(frozen(), cases);
  assert.equal(out.verdict, 'DESCRIBED_PAIRED_DIFFERENCE');
  assert.equal(out.horizons[15].pairedCases, 30);
  assert.ok(Math.abs(out.horizons[15].meanHoldMinusObservedR - 1.0) < 1e-12);
  assert.equal(out.horizons[15].signTest.rejectAtAlpha, true); // 30/30 positives
  assert.ok(VERDICTS.includes(out.verdict));
  const json = JSON.stringify(out);
  assert.equal(json.includes('ADOPT'), false);
  assert.equal(json.includes('RECOMMEND'), false);
  assert.equal(out.disclaimer, DISCLAIMER);
});

test('evaluation is deterministic: identical inputs give identical outputs', () => {
  const cases = [caseA('cA'), caseB('cB'), caseA('cZ', 0.2, 40)];
  const a = evaluateHoldVsClose(frozen(), cases);
  const b = evaluateHoldVsClose(frozen(), cases);
  assert.deepEqual(a, b);
});

test('observed exit classes are reported per horizon so the exit-side decomposition stays visible', () => {
  const out = evaluateHoldVsClose(frozen(), [caseA('cA'), caseB('cB')]);
  assert.deepEqual(out.horizons[15].observedExitClasses, { PROFIT_PROTECTION: 1, BROKER_CLOSE: 1 });
});

test('an unfrozen or malformed protocol is refused before any case is examined', () => {
  const notFrozen = evaluateHoldVsClose({ protocol: DEFAULT_PROTOCOL }, [caseA('cA')]);
  assert.equal(notFrozen.ok, false);
  assert.equal(notFrozen.code, 'PROTOCOL_NOT_FROZEN');
  const badStats = freezeProtocol({ ...DEFAULT_PROTOCOL, statistics: { ...DEFAULT_PROTOCOL.statistics, signTest: 'T_TEST' } });
  assert.equal(badStats.error, 'STATISTICS_INVALID');
  const claimsOverrun = freezeProtocol({ ...DEFAULT_PROTOCOL, claims: 'ADOPTION_READY' });
  assert.equal(claimsOverrun.error, 'CLAIMS_OVERRUN');
});
