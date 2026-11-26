'use strict';

// Independent research artifact: V2 calibrator-in-bundle format (iRexPro AI V2
// research, WS2.1). Pure logic over SYNTHETIC fixtures. No database access,
// no model execution, no broker calls, no trading authority.
//
// V1 defect D-01 being addressed: calibrators exist ONLY in offline
// experiments; the shipped engine consumes uncalibrated scores. Principle P2
// of the V2 architecture: calibration is a LOAD-TIME VERIFIED ARTIFACT, not an
// offline experiment. This module defines and enforces that artifact contract:
//
//   1. A calibrator (isotonic via PAVA, or Platt scaling) is fitted and
//      serialized into a canonical, deterministic JSON bundle.
//   2. The bundle is pinned by the SHA-256 of its canonical serialization
//      (real digest — node:crypto — not a fixture stand-in).
//   3. loadCalibratorBundle re-derives the hash from the parsed bundle:
//      any value change, addition or removal anywhere in the bundle is
//      refused (TAMPERED_BUNDLE). Field ORDER and whitespace do not matter
//      because loading re-canonicalizes; VALUES are the integrity surface.
//   4. Structural invariants are re-verified at load: monotone non-decreasing
//      isotonic output (V1's cap-0.738 monotone transform defect class is
//      refused), finite Platt parameters, non-empty fits, declared horizon
//      and outcome definition, provenance meta present.
//   5. Calibration state derives ONLY from recorded holdout evidence: a
//      bundle without holdout stats can apply but is UNCALIBRATED and can
//      never stamp a CALIBRATED confidence field (decision-record C1).
//
// These are research artifacts for the V2 decision core; nothing here trains,
// loads or serves a model in any production path.

const crypto = require('node:crypto');

const BUNDLE_FORMAT = 'V2_CALIBRATOR_BUNDLE_V1';
const CALIBRATOR_KINDS = Object.freeze(['ISOTONIC', 'PLATT']);
const OUTCOME_DEFINITIONS = Object.freeze(['NET_R_POSITIVE_AT_HORIZON']);
// Minimum hold-out sample before a bundle may declare CALIBRATED (mirrors the
// documented >=100-per-(pair,route) calibration-sample requirement).
const MIN_HOLDOUT_FOR_CALIBRATED = 100;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// --- isotonic regression (pool-adjacent-violators) ---------------------------

// Returns bins: [{ hi: number|null, p }], non-decreasing p, boundaries at
// midpoints between adjacent training scores, equal-valued neighbours merged.
// hi is the exclusive upper score bound; the final bin (hi === null) catches
// everything above the last boundary. Deterministic; ties in scores keep
// first-seen order (caller must supply deterministically ordered fixtures).
function fitIsotonic(scores, outcomes) {
  if (!Array.isArray(scores) || scores.length === 0 || !Array.isArray(outcomes) || outcomes.length !== scores.length) {
    return { error: 'EMPTY_FIT_INPUT', detail: 'isotonic fit requires non-empty parallel arrays of equal length' };
  }
  for (let i = 0; i < scores.length; i++) {
    if (typeof scores[i] !== 'number' || !Number.isFinite(scores[i]) || typeof outcomes[i] !== 'number' || !Number.isFinite(outcomes[i])) {
      return { error: 'NON_FINITE_FIT_INPUT', detail: `scores[${i}] / outcomes[${i}] must be finite numbers` };
    }
  }
  const pts = scores.map((s, i) => ({ score: s, y: outcomes[i] }))
    .sort((a, b) => a.score - b.score || a.y - b.y); // deterministic total order

  // PAVA: pool adjacent violators of non-decreasing y.
  const blocks = [];
  for (const p of pts) {
    blocks.push({ sum: p.y, n: 1, lastScore: p.score, firstScore: p.score });
    while (blocks.length >= 2) {
      const a = blocks[blocks.length - 2]; const b = blocks[blocks.length - 1];
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n, lastScore: b.lastScore, firstScore: a.firstScore });
    }
  }
  const fitted = blocks.map((blk) => ({ p: blk.sum / blk.n, firstScore: blk.firstScore, lastScore: blk.lastScore }));

  // Bin boundaries: midpoints between the last score of a block and the first
  // score of the next block, quantized to 12 significant digits so IEEE-754
  // noise (e.g. (0.1+0.2)/2 = 0.15000000000000002) cannot make the canonical
  // serialization nondeterministic. Merge adjacent bins whose fitted p is equal.
  const bins = [];
  for (let i = 0; i < fitted.length; i++) {
    const isLast = i === fitted.length - 1;
    const boundary = isLast ? null : Number(((fitted[i].lastScore + fitted[i + 1].firstScore) / 2).toPrecision(12));
    const prev = bins[bins.length - 1];
    if (prev && prev.p === fitted[i].p) prev.hi = boundary; // merge equal-valued neighbours
    else bins.push({ hi: boundary, p: fitted[i].p });
  }
  return { kind: 'ISOTONIC', bins };
}

// --- Platt scaling (deterministic Newton, ridge-regularized) ----------------

// p = sigmoid(a * score + b). Newton-Raphson on the logistic log-likelihood
// with a small ridge so separation stays numerically finite. Iterations are
// capped and tolerance fixed: deterministic, no convergence roulette.
function fitPlatt(scores, outcomes, opts = {}) {
  const maxIter = opts.maxIter ?? 200;
  const tol = opts.tol ?? 1e-10;
  const ridge = opts.ridge ?? 1e-6;
  if (!Array.isArray(scores) || scores.length === 0 || outcomes.length !== scores.length) {
    return { error: 'EMPTY_FIT_INPUT', detail: 'platt fit requires non-empty parallel arrays of equal length' };
  }
  if (outcomes.some((y) => y !== 0 && y !== 1)) {
    return { error: 'INVALID_OUTCOMES', detail: 'platt outcomes must be 0/1' };
  }
  let a = 0; let b = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    let g1 = 0; let g2 = 0; let h11 = ridge; let h12 = 0; let h22 = ridge;
    for (let i = 0; i < scores.length; i++) {
      const z = a * scores[i] + b;
      const p = 1 / (1 + Math.exp(-z));
      const e = p - outcomes[i];
      g1 += e * scores[i];
      g2 += e;
      const w = Math.max(p * (1 - p), 1e-9);
      h11 += w * scores[i] * scores[i];
      h12 += w * scores[i];
      h22 += w;
    }
    const det = h11 * h22 - h12 * h12;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-30) break;
    const da = (h22 * g1 - h12 * g2) / det;
    const db = (h11 * g2 - h12 * g1) / det;
    a -= da; b -= db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) { a = capFinite(a); b = capFinite(b); break; }
    if (Math.abs(da) < tol && Math.abs(db) < tol) break;
  }
  a = capFinite(a); b = capFinite(b);
  return { kind: 'PLATT', params: { a, b } };
}

function capFinite(x) {
  return Number.isFinite(x) ? x : Math.sign(x || 1) * 1e6;
}

// --- bundle serialization, pinning, load-time verification ---------------------

function serializeCalibratorBundle({ kind, bins, params, meta }) {
  if (!CALIBRATOR_KINDS.includes(kind)) return { error: 'UNKNOWN_CALIBRATOR_KIND', detail: kind };
  const bundle = { format: BUNDLE_FORMAT, kind, calibrator: kind === 'ISOTONIC' ? { bins } : { params }, meta };
  const canonical = canonicalJson(bundle);
  return { bundle, canonical, bundleSha: sha256(canonical) };
}

function pinCalibratorBundle(bundleObject) {
  const canonical = canonicalJson(bundleObject);
  if (bundleObject.format !== BUNDLE_FORMAT) return { error: 'UNSUPPORTED_BUNDLE_VERSION', detail: `format must be ${BUNDLE_FORMAT}` };
  return { bundle: bundleObject, canonical, bundleSha: sha256(canonical) };
}

// Load-time verification. Returns an APPLYABLE calibrator with its
// calibration state, or a structured refusal. Every failure mode has a code.
function loadCalibratorBundle({ bundle, bundleSha }) {
  if (bundle === null || typeof bundle !== 'object') return refuse('NOT_AN_OBJECT', 'bundle must be an object');
  if (bundle.format !== BUNDLE_FORMAT) return refuse('UNSUPPORTED_BUNDLE_VERSION', `format "${bundle.format}" is not ${BUNDLE_FORMAT}`);
  const canonical = canonicalJson(bundle);
  if (sha256(canonical) !== bundleSha) {
    return refuse('TAMPERED_BUNDLE', 'SHA-256 of the canonical bundle does not match the pinned hash: the artifact has been altered or the pin is wrong');
  }
  if (!CALIBRATOR_KINDS.includes(bundle.kind)) return refuse('UNKNOWN_CALIBRATOR_KIND', String(bundle.kind));

  const meta = bundle.meta || {};
  if (!OUTCOME_DEFINITIONS.includes(meta.outcomeDefinition)) {
    return refuse('OUTCOME_DEFINITION_REQUIRED', `meta.outcomeDefinition must be one of ${OUTCOME_DEFINITIONS.join('|')}`);
  }
  if (typeof meta.horizonMinutes !== 'number' || !Number.isInteger(meta.horizonMinutes) || meta.horizonMinutes <= 0) {
    return refuse('HORIZON_REQUIRED', 'meta.horizonMinutes must be a positive integer (the outcome window being calibrated)');
  }
  if (typeof meta.trainedOnCount !== 'number' || !Number.isInteger(meta.trainedOnCount) || meta.trainedOnCount <= 0) {
    return refuse('TRAINED_ON_COUNT_REQUIRED', 'meta.trainedOnCount must be a positive integer');
  }
  if (typeof meta.fittedAt !== 'string' || meta.fittedAt.length < 10) {
    return refuse('FITTED_AT_REQUIRED', 'meta.fittedAt must be an ISO-8601 instant');
  }

  let apply;
  if (bundle.kind === 'ISOTONIC') {
    const bins = bundle.calibrator.bins;
    if (!Array.isArray(bins) || bins.length === 0) return refuse('EMPTY_FIT_INPUT', 'isotonic bundle has no bins');
    for (const bin of bins) {
      if (typeof bin.p !== 'number' || !Number.isFinite(bin.p) || bin.p < 0 || bin.p > 1) {
        return refuse('BIN_PROBABILITY_OUT_OF_RANGE', `bin p=${bin.p} outside [0,1]`);
      }
    }
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].p < bins[i - 1].p) {
        // V1 defect class: the capped-0.738 monotone transform. A calibrator
        // whose output DECREASES as the score rises is structurally refused.
        return refuse('NON_MONOTONIC_CALIBRATOR', `isotonic output decreases from ${bins[i - 1].p} to ${bins[i].p}: monotone calibration is mandatory`);
      }
    }
    apply = (score) => {
      for (const bin of bins) {
        if (bin.hi === null || score <= bin.hi) return bin.p;
      }
      return bins[bins.length - 1].p; // unreachable; last bin has hi===null
    };
  } else {
    const { a, b } = bundle.calibrator.params;
    if (typeof a !== 'number' || !Number.isFinite(a) || typeof b !== 'number' || !Number.isFinite(b)) {
      return refuse('NON_FINITE_PLATT_PARAMS', 'platt parameters must be finite numbers');
    }
    apply = (score) => 1 / (1 + Math.exp(-(a * score + b)));
  }

  // Calibration state: only recorded hold-out evidence can stamp CALIBRATED.
  const holdout = meta.holdout;
  let calibrationState = 'UNCALIBRATED';
  if (holdout === null || holdout === undefined) {
    calibrationState = 'UNCALIBRATED';
  } else if (
    typeof holdout === 'object'
    && Number.isInteger(holdout.holdoutSize) && holdout.holdoutSize >= MIN_HOLDOUT_FOR_CALIBRATED
    && typeof holdout.brier === 'number' && Number.isFinite(holdout.brier)
    && typeof holdout.ece === 'number' && Number.isFinite(holdout.ece)
  ) {
    calibrationState = 'CALIBRATED';
  }

  return {
    ok: true,
    kind: bundle.kind,
    apply,
    calibrationState,
    bundleSha,
    format: BUNDLE_FORMAT,
    meta,
  };
}

function refuse(code, detail) {
  return { ok: false, code, detail };
}

module.exports = {
  BUNDLE_FORMAT,
  MIN_HOLDOUT_FOR_CALIBRATED,
  fitIsotonic,
  fitPlatt,
  serializeCalibratorBundle,
  pinCalibratorBundle,
  loadCalibratorBundle,
  canonicalJson,
  sha256,
};
