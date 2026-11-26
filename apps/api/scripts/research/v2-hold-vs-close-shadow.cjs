'use strict';

// Independent research artifact: V2 hold-vs-close counterfactual shadow
// (iRexPro AI V2 research, WS3.2). Pure logic over SYNTHETIC fixtures. No
// database access, no model execution, no broker calls, no trading authority.
//
// Why this exists (audit finding: the loss is exit-side): exit-type
// decomposition of settled DEMO trades measured PROFIT_PROTECTION +0.4155R vs
// BROKER_CLOSE -0.8821R and 5m-guard -0.7571R against a uniform 1.6R design
// target. Before ANY exit policy is changed, its counterfactual must be
// measured on the same observed paths under a protocol FROZEN BEFORE the
// paths are examined (pre-registration; no retrospective threshold fitting).
//
// Protocol discipline implemented here:
//   * freezeProtocol() canonicalizes and SHA-pins the protocol; evaluation
//     REFUSES to run under a protocol whose hash does not match the pinned
//     value (PROTOCOL_MISMATCH). You cannot quietly amend the protocol after
//     seeing the cases.
//   * The protocol fixes: horizons (+1/+15/+60 minutes past the observed
//     close), first-touch bracket evaluation with the WORST-CASE stop-first
//     rule when target and stop touch in the same minute, the uniform R
//     bracket (1.6R target / 1.0R stop), the commission-inclusive round-trip
//     cost in R, and the statistics (paired hold-minus-observed differences,
//     exact two-sided sign test, alpha, minimum paired cases).
//   * Verdicts are DESCIPTIVE ONLY: this module structurally cannot emit an
//     adoption, retirement or recommendation verdict. Fixed verdict enums and
//     a standing disclaimer are enforced by the tests.
//
// Case format (synthetic fixture):
//   { caseId, instrument, direction, observed: { closeMinute, exitType,
//     realizedNetR }, path: [{ minute, mfeR, maeR, closeR }] }
// path.minutes are strictly increasing from 0; mfeR/maeR are the running
// excursion highs/lows in R; closeR is the mark at that minute in R.

const crypto = require('node:crypto');
const { canonicalJson, sha256 } = require('./v2-calibrator-bundle.cjs');

const PROTOCOL_ID = 'V2_HOLD_VS_CLOSE_SHADOW_V1';
const VERDICTS = Object.freeze(['DESCRIBED_PAIRED_DIFFERENCE', 'INSUFFICIENT_PAIRED_CASES', 'REFUSED_INPUT']);
const DISCLAIMER = 'Descriptive counterfactual shadow only: no exit policy is adopted, retired, or threshold-changed by this report; paired differences are not performance claims.';

const DEFAULT_PROTOCOL = Object.freeze({
  protocolId: PROTOCOL_ID,
  registeredAt: '2026-11-27T00:00:00Z', // frozen before any fixture path is examined
  rationale: 'Measure the counterfactual value of holding past the observed exit class under a uniform bracket, pre-registered before path examination; answers the corpus question of whether protective/guard exits are destroying expectancy.',
  horizonsMinutes: [1, 15, 60],
  evaluationRule: 'FIRST_TOUCH_BRACKET_WORST_CASE_STOP',
  bracket: { takeProfitR: 1.6, stopR: 1.0 },
  perTradeCostR: 0.2, // commission-inclusive round trip, audit-measured 0.146-0.202R
  statistics: {
    pairedDifference: 'HOLD_MINUS_OBSERVED',
    signTest: 'EXACT_TWO_SIDED_BINOMIAL',
    alpha: 0.05,
    minPairedCases: 30,
  },
  claims: 'DESCRIPTIVE_ONLY',
});

function freezeProtocol(protocol = DEFAULT_PROTOCOL) {
  const p = { ...protocol };
  if (p.protocolId !== PROTOCOL_ID) return { error: 'PROTOCOL_ID_REQUIRED', detail: `protocolId must be ${PROTOCOL_ID}` };
  if (!Array.isArray(p.horizonsMinutes) || p.horizonsMinutes.length === 0
    || p.horizonsMinutes.some((h) => !Number.isInteger(h) || h <= 0)) {
    return { error: 'HORIZONS_INVALID', detail: 'horizonsMinutes must be positive integers (pre-registered)' };
  }
  const sorted = [...p.horizonsMinutes].sort((a, b) => a - b);
  if (p.horizonsMinutes.some((h, i) => h !== sorted[i]) || new Set(p.horizonsMinutes).size !== p.horizonsMinutes.length) {
    return { error: 'HORIZONS_INVALID', detail: 'horizonsMinutes must be unique and sorted ascending' };
  }
  if (!p.bracket || typeof p.bracket.takeProfitR !== 'number' || p.bracket.takeProfitR <= 0
    || typeof p.bracket.stopR !== 'number' || p.bracket.stopR <= 0) {
    return { error: 'BRACKET_INVALID', detail: 'bracket requires positive takeProfitR and stopR magnitudes' };
  }
  if (typeof p.perTradeCostR !== 'number' || p.perTradeCostR < 0) {
    return { error: 'COST_REQUIRED', detail: 'perTradeCostR must be a non-negative number (commission-inclusive)' };
  }
  if (!p.statistics || p.statistics.signTest !== 'EXACT_TWO_SIDED_BINOMIAL' || typeof p.statistics.alpha !== 'number'
    || p.statistics.alpha <= 0 || p.statistics.alpha >= 1
    || !Number.isInteger(p.statistics.minPairedCases) || p.statistics.minPairedCases < 0) {
    return { error: 'STATISTICS_INVALID', detail: 'statistics block is incomplete or malformed' };
  }
  if (p.claims !== 'DESCRIPTIVE_ONLY') {
    return { error: 'CLAIMS_OVERRUN', detail: 'this protocol may only claim DESCRIPTIVE_ONLY outcomes' };
  }
  const canonical = canonicalJson(p);
  return { protocol: p, protocolSha: sha256(canonical) };
}

// --- first-touch bracket evaluation over a hold window -----------------------

function holdOutcome(caseData, h, protocol) {
  const { path, observed } = caseData;
  const windowStart = observed.closeMinute; // minute of the observed close
  const windowEnd = windowStart + h;
  const extension = path.filter((m) => m.minute > windowStart && m.minute <= windowEnd);
  if (extension.length < h) {
    // The synthetic path must provide every minute of the hold window; a gap
    // makes the counterfactual undefined for this horizon.
    return { excluded: 'PATH_GAP', detail: `path covers ${extension.length}/${h} minutes of the hold window` };
  }
  const tp = protocol.bracket.takeProfitR;
  const st = protocol.bracket.stopR;
  for (const m of extension) {
    const tpTouch = m.mfeR >= tp;
    const stTouch = m.maeR <= -st;
    if (stTouch) return { holdNetR: -st - protocol.perTradeCostR, exit: 'STOP_FIRST_TOUCH' }; // worst-case rule
    if (tpTouch) return { holdNetR: tp - protocol.perTradeCostR, exit: 'TARGET_FIRST_TOUCH' };
  }
  // No touch: mark-to-path at the horizon end, net of the same round-trip cost.
  const last = extension[extension.length - 1];
  return { holdNetR: last.closeR - protocol.perTradeCostR, exit: 'UNTOUCHED_MARK_TO_PATH' };
}

function exactTwoSidedSignTest(diffs, alpha) {
  const nonZero = diffs.filter((d) => d !== 0);
  const n = nonZero.length;
  const k = nonZero.filter((d) => d > 0).length; // positives
  if (n === 0) return { n: 0, positives: 0, negatives: 0, zeros: diffs.length, pValue: 1, rejectAtAlpha: false };
  // Exact two-sided binomial tail around 0.5, doubled, capped at 1.
  const pmf = (kk, nn) => binomCoef(nn, kk) * 0.5 ** nn;
  let tail = 0;
  const small = Math.min(k, n - k);
  for (let i = 0; i <= small; i++) tail += pmf(i, n);
  const pValue = Math.min(1, 2 * tail);
  return { n, positives: k, negatives: n - k, zeros: diffs.length - n, pValue, rejectAtAlpha: pValue < alpha };
}

function binomCoef(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

function evaluateHoldVsClose(frozen, cases) {
  if (!frozen || frozen.error) return { ok: false, code: 'PROTOCOL_NOT_FROZEN', detail: 'supply a frozen protocol from freezeProtocol()' };
  const protocol = frozen.protocol;
  const expectedSha = frozen.protocolSha;
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    return { ok: false, code: 'PROTOCOL_NOT_FROZEN', detail: 'a frozen protocol carries a 64-hex SHA pin: pass the freezeProtocol() result, not a hand-built object' };
  }

  if (!Array.isArray(cases) || cases.length === 0) {
    return { ok: false, code: 'NO_CASES', detail: 'evaluation requires a non-empty case array' };
  }
  // Re-derive the hash from the protocol we are actually executing under:
  // any amendment after freeze shows up here.
  if (sha256(canonicalJson(protocol)) !== expectedSha) {
    return { ok: false, code: 'PROTOCOL_MISMATCH', detail: 'protocol content does not hash to the pinned protocolSha: refusing to evaluate under an amended protocol' };
  }
  const seenIds = new Set();
  const verdictPerHorizon = {};
  const refusals = [];

  for (const c of cases) {
    if (c === null || typeof c !== 'object') { refusals.push({ caseId: '(unknown)', code: 'MALFORMED_CASE', detail: 'not an object' }); continue; }
    if (typeof c.caseId !== 'string' || c.caseId.length === 0) { refusals.push({ caseId: '(unknown)', code: 'CASE_ID_REQUIRED', detail: 'caseId must be a non-empty string' }); continue; }
    if (seenIds.has(c.caseId)) { refusals.push({ caseId: c.caseId, code: 'DUPLICATE_CASE', detail: 'caseId appears twice: paired evaluation requires unique cases' }); continue; }
    seenIds.add(c.caseId);
    if (!Array.isArray(c.path) || c.path.length === 0) { refusals.push({ caseId: c.caseId, code: 'MALFORMED_PATH', detail: 'path is required' }); continue; }
    for (let i = 1; i < c.path.length; i++) {
      if (c.path[i].minute <= c.path[i - 1].minute) {
        refusals.push({ caseId: c.caseId, code: 'MALFORMED_PATH', detail: `path minutes not strictly increasing at index ${i}` });
        break;
      }
    }
    if (!c.observed || !Number.isFinite(c.observed.realizedNetR) || !Number.isInteger(c.observed.closeMinute)) {
      refusals.push({ caseId: c.caseId, code: 'OBSERVED_REQUIRED', detail: 'observed.closeMinute (integer) and realizedNetR (finite) are required' });
    }
  }
  if (refusals.length === cases.length) {
    return { ok: false, code: 'REFUSED_INPUT', detail: 'every case was malformed or duplicated', refusals };
  }

  for (const h of protocol.horizonsMinutes) {
    const diffs = [];
    const excluded = [];
    const exitClasses = {};
    for (const c of cases) {
      if (refusals.some((r) => r.caseId === c.caseId)) continue; // malformed cases never contribute
      exitClasses[c.observed.exitType] = (exitClasses[c.observed.exitType] || 0) + 1;
      const hold = holdOutcome(c, h, protocol);
      if (hold.excluded) { excluded.push({ caseId: c.caseId, reason: hold.excluded, detail: hold.detail }); continue; }
      diffs.push(hold.holdNetR - c.observed.realizedNetR);
    }
    const sign = exactTwoSidedSignTest(diffs, protocol.statistics.alpha);
    const meanDiff = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : undefined;
    verdictPerHorizon[h] = {
      horizonMinutes: h,
      pairedCases: diffs.length,
      meanHoldMinusObservedR: meanDiff,
      excludedCount: excluded.length,
      excluded: excluded.slice(0, 20), // bounded echo; full accounting via counts
      observedExitClasses: exitClasses,
      signTest: sign,
    };
  }

  const totalPaired = Object.values(verdictPerHorizon).reduce((acc, v) => acc + v.pairedCases, 0);
  const anyInsufficient = Object.values(verdictPerHorizon).some((v) => v.pairedCases < protocol.statistics.minPairedCases);
  const verdict = refusals.length === 0 && !anyInsufficient ? 'DESCRIBED_PAIRED_DIFFERENCE'
    : (refusals.length > 0 && totalPaired === 0 ? 'REFUSED_INPUT' : 'INSUFFICIENT_PAIRED_CASES');

  return {
    ok: true,
    protocolId: protocol.protocolId,
    protocolSha: expectedSha,
    horizons: verdictPerHorizon,
    verdict,
    disclaimer: DISCLAIMER,
    refusals,
  };
}

module.exports = {
  PROTOCOL_ID,
  DEFAULT_PROTOCOL,
  VERDICTS,
  DISCLAIMER,
  freezeProtocol,
  evaluateHoldVsClose,
  exactTwoSidedSignTest,
  holdOutcome,
};
