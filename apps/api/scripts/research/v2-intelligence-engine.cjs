'use strict';
/**
 * V2 intelligence engine — the runnable, isolated challenger policy plus
 * the frozen V1 champion baseline mirror (P2-2 paired inputs).
 *
 * The champion mirror is a RESEARCH MIRROR of S1 (`m1-tactical-candidate.ts`
 * l.24-27, 110-167, component map §1): the 9-term composite, the B1
 * confidence transform and the stop/target geometry are byte-exact copies
 * of the audited constants; the entry gate (directionQuality >= 0.60) and
 * the fixed 0.2 lot (the audited PAPER_PRODUCT_PREFERRED_LOT) are
 * documented research-mirror choices. The champion is FROZEN: V1 is the
 * baseline and is never modified on this track.
 *
 * The challenger (V2) shares the same entry scoring — so the paired delta
 * isolates EXIT intelligence (EI-1 ladder) and the RD-1 reversal gate — and
 * adds: a pre-registered confidence floor, reversal-vetoed entries, an
 * RD-1-shaped reversal exit, risk-fraction sizing, and pre-outcome
 * probability registration (V2-7 scoreboard: every registered probability
 * is settled against the realized forward outcome).
 *
 * Research-only. executionAuthority is RESEARCH_SHADOW; no order authority
 * exists anywhere in this module.
 */

const {
  V2_CHALLENGER_EXIT_PRESET,
  applyEI1Policy,
  validateEI1Policy,
} = require('./v2-exit-intelligence-contract.cjs');

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clampSigned = (v) => Math.max(-1, Math.min(1, v));

/**
 * Frozen champion policy mirror. Audited constants carry provenance;
 * research-mirror choices are labeled RM.
 */
const CHAMPION_POLICY_MIRROR = Object.freeze({
  artifact: 'v2-champion-baseline-v1',
  // Audited (m1-tactical-candidate.ts l.24-27).
  stopAtrMultiplier: 1.1,
  minStopPips: 5,
  targetR: 1.6,
  maxConfidence: 0.738,
  // Audited composite weights (l.146-154).
  compositeWeights: Object.freeze({
    emaSeparation: 0.19,
    emaSlope: 0.10,
    momentum3: 0.16,
    momentum5: 0.10,
    htfAgreement: 0.20,
    closePressure: 0.08,
    wickPressure: 0.05,
    rsiBias: 0.04,
    breakout: 0.08,
  }),
  // RM: research-mirror entry gate (production gating lives downstream of
  // the candidate generator; not pinned in the audit).
  entryGateDirectionQuality: 0.60,
  // RM + audited value: fixed lot = the audited PAPER_PRODUCT_PREFERRED_LOT.
  fixedLots: 0.2,
  provenance: 'm1-tactical-candidate.ts l.24-27,110-167; position-sizing.service.ts l.190',
});

/** Pre-registered challenger parameters (research-only). */
const CHALLENGER_POLICY = Object.freeze({
  artifact: 'v2-intelligence-engine-v1',
  entryGateDirectionQuality: 0.60,
  confidenceFloor: 0.55,
  riskFraction: 0.002,
  minLots: 0.01,
  maxLots: 0.2,
  pipValueUsdPerLot: 10,
  // RD-1-shaped reversal gate (research mirror of the six definitions'
  // shared core: momentum flip with conviction and net-economics sanity).
  reversalMomentumAtr: 0.5,
  reversalCooldownBars: 6,
  reversalVetoBars: 6,
  forwardWindowBars: 6,
  exitPolicyArtifact: 'v2-ei1-challenger-preset-v1',
});

/** S1 composite for one candidate direction (byte-exact mirror, l.110-167). */
function computeChampionCandidate(snapshot, direction, pip) {
  if (!snapshot || !snapshot.ready) {
    throw new Error('ENGINE_SNAPSHOT_REQUIRED');
  }
  const sign = direction === 'BUY' ? 1 : -1;
  const w = CHAMPION_POLICY_MIRROR.compositeWeights;
  const aligned = (v) => sign * v;
  const composite = clampSigned(
    w.emaSeparation * clampSigned(aligned(snapshot.emaSeparationAtr)) +
    w.emaSlope * clampSigned(aligned(snapshot.emaSlopeAtr)) +
    w.momentum3 * clampSigned(aligned(snapshot.momentum3Atr)) +
    w.momentum5 * clampSigned(aligned(snapshot.momentum5Atr)) +
    w.htfAgreement * clampSigned(aligned(snapshot.htfAgreement)) +
    w.closePressure * clampSigned(aligned(snapshot.closePressure)) +
    w.wickPressure * clampSigned(aligned(snapshot.wickPressure)) +
    w.rsiBias * clampSigned(aligned(snapshot.rsiBias)) +
    w.breakout * clampSigned(aligned(direction === 'BUY'
      ? snapshot.breakoutUpAtr : -snapshot.breakoutDownAtr)),
  );
  const directionQuality = clamp01(0.5 + composite / 2);
  const confidence = Math.min(
    CHAMPION_POLICY_MIRROR.maxConfidence,
    clamp01(0.5 + 0.3 * directionQuality +
      0.08 * snapshot.efficiency5 - 0.08 * snapshot.volatilityScore),
  );
  const score = directionQuality +
    0.15 * confidence +
    0.05 * clampSigned(aligned(snapshot.momentum1Atr)) +
    0.05 * clampSigned(aligned(snapshot.htfAgreement));
  // Stop/target geometry (audited l.24-27).
  const pipSize = finiteNumber(pip) && pip > 0 ? pip : 0.0001;
  const stopDistance = Math.max(
    snapshot.atr14 * CHAMPION_POLICY_MIRROR.stopAtrMultiplier,
    pipSize * CHAMPION_POLICY_MIRROR.minStopPips,
  );
  const targetDistance = stopDistance * CHAMPION_POLICY_MIRROR.targetR;
  return Object.freeze({
    direction,
    directionQuality,
    confidence,
    score,
    composite,
    stopDistance,
    targetDistance,
  });
}

/**
 * Create one engine policy (champion or challenger) for the paired
 * simulator. Interface: decide(ctx) -> {entry, exit, stopUpdate,
 * registeredProbability} where ctx = {bar, barIndex, snapshot, position,
 * equityUsd, lastClose}. position = null | {direction, entryPrice,
 * stopDistance, peakR, grossR, barsHeld, entryConfidence}.
 */
function createEnginePolicy(kind, config) {
  if (kind !== 'CHAMPION' && kind !== 'CHALLENGER') {
    throw new Error(`ENGINE_KIND_UNKNOWN:${String(kind)}`);
  }
  const cfg = config || {};
  const identity = cfg.engineIdentity;
  if (!identity || identity.executionAuthority !== 'RESEARCH_SHADOW') {
    throw new Error('ENGINE_IDENTITY_RESEARCH_ONLY');
  }
  const pip = finiteNumber(cfg.pip) ? cfg.pip : 0.0001;
  // Exit preset: the frozen pre-registered challenger preset by default.
  // cfg.exitPreset is an EXPERIMENTAL ABLATION ARM ONLY (validated with the
  // same typed EI-1 validator); it never modifies the frozen preset and is
  // recorded as experimental in any campaign that uses it.
  let exitPreset = V2_CHALLENGER_EXIT_PRESET;
  if (cfg.exitPreset !== undefined && cfg.exitPreset !== null) {
    validateEI1Policy(cfg.exitPreset);
    exitPreset = cfg.exitPreset;
  }
  // Entry-gate ablation overrides (experimental arms only; the frozen
  // CHALLENGER_POLICY values are the pre-registered candidate).
  let entryGateDirectionQuality = CHALLENGER_POLICY.entryGateDirectionQuality;
  if (finiteNumber(cfg.entryGateDirectionQuality)) {
    if (cfg.entryGateDirectionQuality < 0 || cfg.entryGateDirectionQuality > 1) {
      throw new Error('ENGINE_ENTRY_GATE_INVALID');
    }
    entryGateDirectionQuality = cfg.entryGateDirectionQuality;
  }
  let confidenceFloor = CHALLENGER_POLICY.confidenceFloor;
  if (finiteNumber(cfg.confidenceFloor)) {
    if (cfg.confidenceFloor < 0 || cfg.confidenceFloor > 1) {
      throw new Error('ENGINE_CONFIDENCE_FLOOR_INVALID');
    }
    confidenceFloor = cfg.confidenceFloor;
  }

  // Challenger reversal-gate state (events recorded for the reversal
  // detection metric family).
  let previousMomentumSign = null;
  let reversalActiveUntil = -1;
  let vetoDirection = null;
  let vetoUntil = -1;
  let probabilityCadence = 0;
  const reversalEvents = [];

  function decide(ctx) {
    const { bar, barIndex, snapshot, position, equityUsd } = ctx;
    if (!bar || !snapshot || !snapshot.ready) {
      return Object.freeze({
        entry: null, exit: null, stopUpdate: null, registeredProbability: null,
      });
    }
    const buy = computeChampionCandidate(snapshot, 'BUY', pip);
    const sell = computeChampionCandidate(snapshot, 'SELL', pip);

    // V2-7 pre-outcome probability registration: every `forwardWindowBars`
    // bars, register the champion formula's confidence for the preferred
    // direction, settled later against the realized forward outcome by the
    // harness. Registered BEFORE the outcome is known, by construction.
    let registeredProbability = null;
    probabilityCadence += 1;
    if (probabilityCadence >= CHALLENGER_POLICY.forwardWindowBars) {
      probabilityCadence = 0;
      const preferred = buy.directionQuality >= sell.directionQuality ? buy : sell;
      registeredProbability = Object.freeze({
        bar: barIndex,
        direction: preferred.direction,
        probability: preferred.confidence,
        windowBars: CHALLENGER_POLICY.forwardWindowBars,
      });
    }

    if (kind === 'CHAMPION') {
      return decideChampion(ctx, buy, sell, registeredProbability);
    }
    return decideChallenger(ctx, buy, sell, registeredProbability);
  }

  function decideChampion(ctx, buy, sell, registeredProbability) {
    const { position } = ctx;
    if (position !== null && position !== undefined) {
      // Champion: hard stop/target only — the simulator fills them
      // intra-bar; no retention ladder, no reversal exit.
      return Object.freeze({
        entry: null, exit: null, stopUpdate: null, registeredProbability,
      });
    }
    const preferred = buy.directionQuality >= sell.directionQuality ? buy : sell;
    if (preferred.directionQuality < CHAMPION_POLICY_MIRROR.entryGateDirectionQuality) {
      return Object.freeze({
        entry: null, exit: null, stopUpdate: null, registeredProbability,
      });
    }
    return Object.freeze({
      entry: {
        direction: preferred.direction,
        lots: CHAMPION_POLICY_MIRROR.fixedLots,
        stopDistance: preferred.stopDistance,
        targetDistance: preferred.targetDistance,
        confidence: preferred.confidence,
        directionQuality: preferred.directionQuality,
        reason: 'CHAMPION_MIRROR_ENTRY',
      },
      exit: null, stopUpdate: null, registeredProbability,
    });
  }

  function decideChallenger(ctx, buy, sell, registeredProbability) {
    const { barIndex, position, equityUsd } = ctx;

    // RD-1-shaped reversal gate: momentum flip with conviction.
    const momentumSign = Math.sign(ctx.snapshot.momentum3Atr);
    if (previousMomentumSign !== null && momentumSign !== 0 &&
        previousMomentumSign !== 0 && momentumSign !== previousMomentumSign &&
        Math.abs(ctx.snapshot.momentum3Atr) >= CHALLENGER_POLICY.reversalMomentumAtr) {
      reversalActiveUntil = barIndex + CHALLENGER_POLICY.reversalCooldownBars;
      vetoDirection = previousMomentumSign > 0 ? 'BUY' : 'SELL';
      vetoUntil = barIndex + CHALLENGER_POLICY.reversalVetoBars;
      reversalEvents.push(Object.freeze({
        bar: barIndex,
        direction: vetoDirection,
      }));
    }
    previousMomentumSign = momentumSign === 0 ? previousMomentumSign : momentumSign;

    if (position !== null && position !== undefined) {
      const state = {
        grossR: position.grossR,
        peakR: position.peakR,
        barsHeld: position.barsHeld,
        elapsedMinutes: position.barsHeld * 5,
        // The X1 M1 rescue band is part of the challenger preset.
        isM1Strategy: true,
      };
      const reversalAgainst = barIndex <= reversalActiveUntil &&
        ((position.direction === 'BUY' && vetoDirection === 'BUY') ||
          (position.direction === 'SELL' && vetoDirection === 'SELL'));
      if (reversalAgainst) {
        return Object.freeze({
          entry: null,
          exit: { reason: 'REVERSAL_EXIT' },
          stopUpdate: null,
          registeredProbability,
        });
      }
      const decision = applyEI1Policy(state, exitPreset);
      if (decision.action === 'CLOSE') {
        return Object.freeze({
          entry: null,
          exit: { reason: decision.reason },
          stopUpdate: null,
          registeredProbability,
        });
      }
      // Trailing floor update from the retention ladder.
      let stopUpdate = null;
      if (decision.lockR !== null && decision.lockR > 0) {
        const sign = position.direction === 'BUY' ? 1 : -1;
        const candidateStop = position.entryPrice +
          sign * decision.lockR * position.stopDistance;
        const tightened = position.direction === 'BUY'
          ? candidateStop > position.stopPrice + 1e-12
          : candidateStop < position.stopPrice - 1e-12;
        if (tightened) stopUpdate = candidateStop;
      }
      return Object.freeze({
        entry: null, exit: null, stopUpdate, registeredProbability,
      });
    }

    // Entry evaluation with confidence floor and reversal veto.
    const preferred = buy.directionQuality >= sell.directionQuality ? buy : sell;
    if (preferred.directionQuality < entryGateDirectionQuality) {
      return Object.freeze({
        entry: null, exit: null, stopUpdate: null, registeredProbability,
      });
    }
    if (preferred.confidence < confidenceFloor) {
      return Object.freeze({
        entry: null, exit: null, stopUpdate: null,
        registeredProbability: null,
        abstained: { reason: 'CONFIDENCE_FLOOR', confidence: preferred.confidence },
      });
    }
    if (barIndex <= vetoUntil && preferred.direction === vetoDirection) {
      return Object.freeze({
        entry: null, exit: null, stopUpdate: null,
        registeredProbability: null,
        abstained: { reason: 'REVERSAL_VETO' },
      });
    }
    // Risk-fraction sizing capped at the audited preferred lot.
    const stopPips = preferred.stopDistance / pip;
    const riskUsd = equityUsd * CHALLENGER_POLICY.riskFraction;
    const lotsByRisk = riskUsd / (stopPips * CHALLENGER_POLICY.pipValueUsdPerLot);
    const lots = Math.max(CHALLENGER_POLICY.minLots,
      Math.min(CHALLENGER_POLICY.maxLots, Math.round(lotsByRisk * 100) / 100));
    return Object.freeze({
      entry: {
        direction: preferred.direction,
        lots,
        stopDistance: preferred.stopDistance,
        targetDistance: preferred.targetDistance,
        confidence: preferred.confidence,
        directionQuality: preferred.directionQuality,
        reason: 'CHALLENGER_ENTRY',
      },
      exit: null, stopUpdate: null, registeredProbability,
    });
  }

  return Object.freeze({
    kind,
    identity,
    decide,
    exitPreset: Object.freeze(exitPreset),
    exitPresetIsFrozen: exitPreset === V2_CHALLENGER_EXIT_PRESET,
    entryGateDirectionQuality,
    confidenceFloor,
    reversalEvents: () => reversalEvents.slice(),
  });
}

module.exports = {
  CHAMPION_POLICY_MIRROR,
  CHALLENGER_POLICY,
  computeChampionCandidate,
  createEnginePolicy,
};
