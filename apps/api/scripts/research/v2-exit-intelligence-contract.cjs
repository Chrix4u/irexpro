'use strict';
/**
 * V2 exit-intelligence consolidation (P1-5). Six production exit engines
 * protect the same concept (favorable-excursion retention) with six
 * divergent constant sets (component map §5). This contract:
 *
 *   1. pins the six-engine inventory with path-verified, line-cited
 *      constants as the comparison baseline (NO constants changed);
 *   2. defines EI-1, the unified parameterized retention/force-close
 *      policy schema that subsumes the parameterizable engines (X1, X2,
 *      X4, X5) and records the two evaluation-based engines (X3, X6) as
 *      documented divergences rather than pretending they are ladders;
 *   3. exposes the pre-registered V2 challenger exit preset.
 *
 * Research-only. Never grants order authority, never edits runtime files.
 */

const fs = require('node:fs');
const path = require('node:path');

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** Stop/target geometry and every lock/guard slot of the unified policy. */
const EI1_COLUMNS = Object.freeze([
  'stopAtrMultiple', 'minStopPips', 'targetR',
  'armR', 'bands', 'rescue',
  'routeArmOverrides', 'tpOverlayFraction',
  'drawdownGuard', 'unprotectedBand', 'timeStopBars',
]);

const EXIT_REASONS = Object.freeze([
  'STOP_LOSS', 'TARGET', 'LOCK_TRAIL', 'RESCUE_LOCK',
  'DRAWDOWN_GUARD', 'UNPROTECTED_BAND_RESCUE', 'TIME_STOP',
  'HORIZON_CLOSE', 'HOLD',
]);

const EI1_REFUSALS = Object.freeze([
  'EI1_POLICY_REQUIRED', 'EI1_STOP_INVALID', 'EI1_MIN_STOP_PIPS_INVALID',
  'EI1_TARGET_INVALID', 'EI1_ARM_INVALID', 'EI1_BANDS_EMPTY',
  'EI1_BANDS_NOT_ASCENDING', 'EI1_BANDS_MISALIGNED_WITH_ARM',
  'EI1_RETAIN_INVALID', 'EI1_RESCUE_INVALID', 'EI1_ROUTE_OVERRIDE_INVALID',
  'EI1_TP_OVERLAY_INVALID', 'EI1_DRAWDOWN_GUARD_INVALID',
  'EI1_UNPROTECTED_BAND_INVALID', 'EI1_TIME_STOP_INVALID',
  'EI1_EMULATION_NOT_PARAMETERIZED',
]);

/**
 * Six-engine inventory (component map §5), constants copied byte-exact from
 * the cited lines. `semantics` records whether the engine is a pure
 * parameterized ladder (expressible in EI-1) or an evaluation-based policy.
 */
const EXIT_ENGINE_INVENTORY = Object.freeze([
  Object.freeze({
    key: 'X1',
    path: 'apps/api/src/modules/broker/adapters/paper-broker.adapter.ts',
    semantics: 'PARAMETERIZED',
    provenance: 'ladder block l.660-680; route arms l.668-669; arm floors l.719-725',
    constants: Object.freeze({
      standardArmR: 0.50,
      m1RescueArmR: 0.395,
      m1RescueRetain: 0.40,
      bands: Object.freeze([
        Object.freeze({ fromR: 0.50, retain: 0.70 }),
        Object.freeze({ fromR: 0.75, retain: 0.75 }),
        Object.freeze({ fromR: 1.00, retain: 0.80 }),
        Object.freeze({ fromR: 1.50, retain: 0.85 }),
        Object.freeze({ fromR: 2.00, retain: 0.90 }),
      ]),
      routeArmOverrides: Object.freeze({
        CONFIRMED_REVERSAL: 1.00,
        EARLY_TRANSITION: 0.75,
      }),
    }),
  }),
  Object.freeze({
    key: 'X2',
    path: 'apps/api/src/modules/execution/reconciliation/pepperstone-demo-net-profit-lock.ts',
    semantics: 'PARAMETERIZED',
    provenance: 'pepperstoneDemoTieredPeakRetention l.30-34; TP overlay l.88-93,107',
    constants: Object.freeze({
      armR: 0.0,
      bands: Object.freeze([
        Object.freeze({ fromR: 0.0, retain: 0.55 }),
        Object.freeze({ fromR: 0.5, retain: 0.65 }),
        Object.freeze({ fromR: 0.75, retain: 0.75 }),
        Object.freeze({ fromR: 1.0, retain: 0.80 }),
      ]),
      tpOverlayFraction: 0.91,
    }),
  }),
  Object.freeze({
    key: 'X3',
    path: 'apps/api/src/modules/execution/reconciliation/live-demo-profit-protection.service.ts',
    semantics: 'EVALUATION_BASED',
    provenance: 'continuation recovery grace l.48',
    constants: Object.freeze({ continuationRecoveryGraceMinutes: 4.5 }),
    note: 'thesis/adverse evaluation policy, not a retention ladder; recorded divergence.',
  }),
  Object.freeze({
    key: 'X4',
    path: 'apps/api/src/modules/ai/post-entry-demo-drawdown-guard.service.ts',
    semantics: 'PARAMETERIZED',
    provenance: 'exported constants l.12-15',
    constants: Object.freeze({
      checkpointMinutes: 5,
      deadlineMinutes: 7,
      closeR: -0.4,
      intervalMs: 15000,
    }),
  }),
  Object.freeze({
    key: 'X5',
    path: 'apps/api/src/modules/execution/reconciliation/pepperstone-demo-post-peak-rescue.ts',
    semantics: 'PARAMETERIZED',
    provenance: 'unprotected band l.144-156',
    constants: Object.freeze({
      bandFromR: 0.30,
      bandToR: 0.50,
      givebackFraction: 0.30,
      currentRBleedFloorR: -0.7,
      minObservations: 12,
      minElapsedMinutes: 2,
    }),
  }),
  Object.freeze({
    key: 'X6',
    path: 'apps/api/src/modules/execution/reconciliation/verified-profit-stop-runner-policy.ts',
    semantics: 'EVALUATION_BASED',
    provenance: 'fee-inclusive floor l.226-232',
    constants: Object.freeze({
      feeFloorRiskFraction: 0.1,
      feeFloorMinUsd: 1.0,
      refusalCode: 'FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE',
    }),
    note: 'fail-closed fee-inclusive floor, not a retention ladder; recorded divergence.',
  }),
]);

/**
 * Champion (S1) exit design — the comparison baseline geometry
 * (m1-tactical-candidate.ts l.24-27): hard stop and target only, no
 * retention ladder. Frozen; the champion baseline is never modified.
 */
const EI1_CHAMPION_BASELINE = Object.freeze({
  artifact: 'v2-ei1-champion-baseline-v1',
  stopAtrMultiple: 1.1,
  minStopPips: 5,
  targetR: 1.6,
  armR: null,
  bands: Object.freeze([]),
  rescue: null,
  routeArmOverrides: null,
  tpOverlayFraction: null,
  drawdownGuard: null,
  unprotectedBand: null,
  timeStopBars: null,
});

/**
 * Pre-registered V2 challenger exit preset: the champion geometry plus the
 * X1 retention ladder, the X4 drawdown guard and a time stop. Pre-registered
 * before any campaign; research-only.
 */
const V2_CHALLENGER_EXIT_PRESET = Object.freeze({
  artifact: 'v2-ei1-challenger-preset-v1',
  stopAtrMultiple: 1.1,
  minStopPips: 5,
  targetR: 1.6,
  armR: 0.50,
  bands: Object.freeze([
    Object.freeze({ fromR: 0.50, retain: 0.70 }),
    Object.freeze({ fromR: 0.75, retain: 0.75 }),
    Object.freeze({ fromR: 1.00, retain: 0.80 }),
    Object.freeze({ fromR: 1.50, retain: 0.85 }),
    Object.freeze({ fromR: 2.00, retain: 0.90 }),
  ]),
  rescue: Object.freeze({ armR: 0.395, retain: 0.40 }),
  routeArmOverrides: null,
  tpOverlayFraction: null,
  drawdownGuard: Object.freeze({
    checkpointMinutes: 5,
    deadlineMinutes: 7,
    closeR: -0.4,
    intervalMs: 15000,
  }),
  unprotectedBand: null,
  timeStopBars: 288,
});

/** Typed validation of an EI-1 policy object. */
function validateEI1Policy(policy) {
  if (!policy || typeof policy !== 'object') {
    throw new Error('EI1_POLICY_REQUIRED');
  }
  if (!finiteNumber(policy.stopAtrMultiple) || policy.stopAtrMultiple <= 0) {
    throw new Error('EI1_STOP_INVALID');
  }
  if (!finiteNumber(policy.minStopPips) || policy.minStopPips < 0) {
    throw new Error('EI1_MIN_STOP_PIPS_INVALID');
  }
  if (!finiteNumber(policy.targetR) || policy.targetR <= 0) {
    throw new Error('EI1_TARGET_INVALID');
  }
  if (policy.armR !== null) {
    if (!finiteNumber(policy.armR) || policy.armR < 0) {
      throw new Error('EI1_ARM_INVALID');
    }
    if (!Array.isArray(policy.bands) || policy.bands.length === 0) {
      throw new Error('EI1_BANDS_EMPTY');
    }
    let previous = null;
    for (const band of policy.bands) {
      if (!finiteNumber(band.fromR)) {
        throw new Error('EI1_BANDS_NOT_ASCENDING');
      }
      if (previous !== null && band.fromR <= previous) {
        throw new Error('EI1_BANDS_NOT_ASCENDING');
      }
      previous = band.fromR;
      if (!finiteNumber(band.retain) || band.retain <= 0 || band.retain > 1) {
        throw new Error('EI1_RETAIN_INVALID');
      }
    }
    if (policy.bands[0].fromR !== policy.armR) {
      throw new Error('EI1_BANDS_MISALIGNED_WITH_ARM');
    }
  }
  if (policy.rescue !== null && policy.rescue !== undefined) {
    const { armR, retain } = policy.rescue;
    if (!finiteNumber(armR) || !finiteNumber(retain) || retain <= 0 ||
        retain > 1 || armR < 0 || armR >= policy.armR) {
      throw new Error('EI1_RESCUE_INVALID');
    }
  }
  if (policy.routeArmOverrides !== null && policy.routeArmOverrides !== undefined) {
    if (!policy.routeArmOverrides || typeof policy.routeArmOverrides !== 'object') {
      throw new Error('EI1_ROUTE_OVERRIDE_INVALID');
    }
    for (const value of Object.values(policy.routeArmOverrides)) {
      if (!finiteNumber(value) || value < 0 || value < policy.armR) {
        throw new Error('EI1_ROUTE_OVERRIDE_INVALID');
      }
    }
  }
  if (policy.tpOverlayFraction !== null && policy.tpOverlayFraction !== undefined) {
    if (!finiteNumber(policy.tpOverlayFraction) || policy.tpOverlayFraction <= 0 ||
        policy.tpOverlayFraction > 1) {
      throw new Error('EI1_TP_OVERLAY_INVALID');
    }
  }
  if (policy.drawdownGuard !== null && policy.drawdownGuard !== undefined) {
    const g = policy.drawdownGuard;
    if (!g || !finiteNumber(g.closeR) || g.closeR >= 0 ||
        !Number.isInteger(g.checkpointMinutes) || g.checkpointMinutes < 0 ||
        !Number.isInteger(g.deadlineMinutes) ||
        g.deadlineMinutes < g.checkpointMinutes) {
      throw new Error('EI1_DRAWDOWN_GUARD_INVALID');
    }
  }
  if (policy.unprotectedBand !== null && policy.unprotectedBand !== undefined) {
    const b = policy.unprotectedBand;
    if (!b || !finiteNumber(b.fromR) || !finiteNumber(b.toR) || b.fromR < 0 ||
        b.toR <= b.fromR || !finiteNumber(b.givebackFraction) ||
        b.givebackFraction <= 0 || b.givebackFraction > 1 ||
        !Number.isInteger(b.minObservations) || b.minObservations < 0 ||
        !Number.isInteger(b.minElapsedMinutes) || b.minElapsedMinutes < 0 ||
        !finiteNumber(b.currentRBleedFloorR)) {
      throw new Error('EI1_UNPROTECTED_BAND_INVALID');
    }
  }
  if (policy.timeStopBars !== null && policy.timeStopBars !== undefined) {
    if (!Number.isInteger(policy.timeStopBars) || policy.timeStopBars <= 0) {
      throw new Error('EI1_TIME_STOP_INVALID');
    }
  }
  return true;
}

/** Retention fraction for a peak (last band whose fromR <= peak). */
function retainFractionForPeak(bands, peakR) {
  let retain = null;
  for (const band of bands) {
    if (band.fromR <= peakR) retain = band.retain;
    else break;
  }
  return retain;
}

/**
 * Evaluate the consolidated exit policy on one position state.
 * state: { grossR, peakR, barsHeld?, elapsedMinutes?, route?,
 *          givebackR?, observationCount? }
 * Returns a frozen decision { action: 'HOLD'|'CLOSE', reason,
 * lockR } where lockR is the current trailing floor (LOCK only).
 * Precedence: TARGET > DRAWDOWN_GUARD > UNPROTECTED_BAND_RESCUE >
 * LOCK_TRAIL/RESCUE_LOCK > TIME_STOP > HOLD.
 */
function applyEI1Policy(state, policy) {
  if (!state || typeof state !== 'object') {
    throw new Error('EI1_POLICY_REQUIRED: state');
  }
  if (!finiteNumber(state.grossR) || !finiteNumber(state.peakR)) {
    throw new Error('EI1_POLICY_REQUIRED: state.grossR/state.peakR');
  }
  validateEI1Policy(policy);
  const elapsedMinutes = finiteNumber(state.elapsedMinutes)
    ? state.elapsedMinutes : 0;

  // 1. Target reached (hard TP; TP overlay is X2-only and applied at the
  //    engine's exit-price construction, not here).
  if (state.grossR >= policy.targetR) {
    return Object.freeze({ action: 'CLOSE', reason: 'TARGET', lockR: null });
  }

  // 2. X4-style drawdown guard (checked from the checkpoint minute).
  if (policy.drawdownGuard && elapsedMinutes >= policy.drawdownGuard.checkpointMinutes &&
      state.grossR <= policy.drawdownGuard.closeR) {
    return Object.freeze({ action: 'CLOSE', reason: 'DRAWDOWN_GUARD', lockR: null });
  }

  // 3. X5-style unprotected-band rescue.
  if (policy.unprotectedBand) {
    const b = policy.unprotectedBand;
    const inBand = state.peakR >= b.fromR && state.peakR < b.toR;
    const bleeding = state.grossR <= 0 && state.grossR > b.currentRBleedFloorR;
    const gaveBack = finiteNumber(state.givebackR) && state.givebackR >= b.givebackFraction;
    const enoughObs = Number.isInteger(state.observationCount) &&
      state.observationCount >= b.minObservations;
    const oldEnough = elapsedMinutes >= b.minElapsedMinutes;
    if (inBand && bleeding && gaveBack && enoughObs && oldEnough) {
      return Object.freeze({
        action: 'CLOSE', reason: 'UNPROTECTED_BAND_RESCUE', lockR: null,
      });
    }
  }

  // 4. Retention ladder (X1/X2 shape) with route arming overrides.
  if (policy.armR !== null && policy.bands.length > 0) {
    const override = policy.routeArmOverrides &&
      nonEmptyString(state.route) &&
      Object.prototype.hasOwnProperty.call(policy.routeArmOverrides, state.route)
      ? policy.routeArmOverrides[state.route] : null;
    const effectiveArmR = override !== null ? override : policy.armR;
    if (state.peakR >= effectiveArmR) {
      const retain = retainFractionForPeak(policy.bands, state.peakR);
      const lockR = state.peakR * retain;
      if (state.grossR <= lockR) {
        return Object.freeze({ action: 'CLOSE', reason: 'LOCK_TRAIL', lockR });
      }
      return Object.freeze({ action: 'HOLD', reason: 'HOLD', lockR });
    }
    // Rescue band strictly below the standard arm (X1: m1RescueArmed
    // requires !standardArmed, i.e. peak < armR, and isM1Strategy).
    if (policy.rescue && state.peakR >= policy.rescue.armR &&
        state.peakR < policy.armR && state.isM1Strategy !== false) {
      const lockR = state.peakR * policy.rescue.retain;
      if (state.grossR <= lockR) {
        return Object.freeze({ action: 'CLOSE', reason: 'RESCUE_LOCK', lockR });
      }
      return Object.freeze({ action: 'HOLD', reason: 'HOLD', lockR });
    }
  }

  // 5. Time stop (EI-1 slot; used by the challenger preset).
  if (policy.timeStopBars !== null && policy.timeStopBars !== undefined &&
      Number.isInteger(state.barsHeld) && state.barsHeld >= policy.timeStopBars) {
    return Object.freeze({ action: 'CLOSE', reason: 'TIME_STOP', lockR: null });
  }

  return Object.freeze({ action: 'HOLD', reason: 'HOLD', lockR: null });
}

/** EI-1 view of an inventory engine; X3/X6 are typed refusals. */
function emulateExitEngine(key, state) {
  const entry = EXIT_ENGINE_INVENTORY.find((e) => e.key === key);
  if (!entry) {
    throw new Error(`EI1_EMULATION_NOT_PARAMETERIZED: unknown engine ${String(key)}`);
  }
  if (entry.semantics !== 'PARAMETERIZED') {
    throw new Error(`EI1_EMULATION_NOT_PARAMETERIZED: ${key} is EVALUATION_BASED`);
  }
  const c = entry.constants;
  const armR = c.standardArmR !== undefined ? c.standardArmR
    : c.armR !== undefined ? c.armR : null;
  const policy = {
    stopAtrMultiple: 1.1,
    minStopPips: 5,
    targetR: 1.6,
    armR,
    bands: armR !== null && Array.isArray(c.bands) ? c.bands : [],
    rescue: c.m1RescueArmR !== undefined
      ? { armR: c.m1RescueArmR, retain: c.m1RescueRetain } : null,
    routeArmOverrides: c.routeArmOverrides || null,
    tpOverlayFraction: c.tpOverlayFraction || null,
    drawdownGuard: c.closeR !== undefined ? {
      checkpointMinutes: c.checkpointMinutes,
      deadlineMinutes: c.deadlineMinutes,
      closeR: c.closeR,
    } : null,
    unprotectedBand: c.bandFromR !== undefined ? {
      fromR: c.bandFromR,
      toR: c.bandToR,
      givebackFraction: c.givebackFraction,
      currentRBleedFloorR: c.currentRBleedFloorR,
      minObservations: c.minObservations,
      minElapsedMinutes: c.minElapsedMinutes,
    } : null,
    timeStopBars: null,
  };
  return applyEI1Policy(state, policy);
}

/** Path verification for every inventory engine (drift detector). */
function verifyExitEnginePaths(repoRoot) {
  if (!nonEmptyString(repoRoot)) {
    throw new Error('EI1_POLICY_REQUIRED: repoRoot');
  }
  let verified = 0;
  for (const entry of EXIT_ENGINE_INVENTORY) {
    const resolved = path.join(repoRoot, entry.path);
    if (!fs.existsSync(resolved)) {
      throw new Error(`EI1_ENGINE_PATH_NOT_FOUND: ${entry.path} (engine ${entry.key})`);
    }
    verified += 1;
  }
  return { verified, total: EXIT_ENGINE_INVENTORY.length };
}

/** Contract summary: counts, divergence classification, no-change pledge. */
function summarizeExitIntelligenceContract() {
  const parameterized = EXIT_ENGINE_INVENTORY.filter(
    (e) => e.semantics === 'PARAMETERIZED').length;
  const evaluationBased = EXIT_ENGINE_INVENTORY.length - parameterized;
  return Object.freeze({
    artifact: 'v2-exit-intelligence-contract-v1',
    engines: EXIT_ENGINE_INVENTORY.length,
    parameterized,
    evaluationBased,
    championBaseline: EI1_CHAMPION_BASELINE.artifact,
    challengerPreset: V2_CHALLENGER_EXIT_PRESET.artifact,
    exitReasons: EXIT_REASONS.length,
    noConstantsChanged: true,
    note: 'X1/X2/X4/X5 constants are byte-exact copies from the cited lines; ' +
      'X3/X6 are recorded as evaluation-based divergences. The champion ' +
      'baseline and all production engines are frozen; only the ' +
      'pre-registered challenger preset is new.',
  });
}

module.exports = {
  EXIT_ENGINE_INVENTORY,
  EXIT_REASONS,
  EI1_COLUMNS,
  EI1_REFUSALS,
  EI1_CHAMPION_BASELINE,
  V2_CHALLENGER_EXIT_PRESET,
  validateEI1Policy,
  applyEI1Policy,
  emulateExitEngine,
  verifyExitEnginePaths,
  summarizeExitIntelligenceContract,
};
