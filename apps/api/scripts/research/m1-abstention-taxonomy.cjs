'use strict';

// Independent research artifact: semantic taxonomy for M1 abstention evidence.
// Separates six fundamentally different concepts that a single 0-100
// "abstention strength" scalar would illegitimately collapse:
//
//   1. DIRECTIONAL_CONFIDENCE   - model's self-assessed direction alignment
//   2. PREDICTIVE_UNCERTAINTY  - calibrated outcome-distribution dispersion
//   3. THRESHOLD_DISTANCE       - geometric margin to a policy gate boundary
//   4. OUTCOME_PROBABILITY      - calibrated P(unfavorable settled outcome)
//   5. MISSING_EVIDENCE        - data unavailability / invalid state
//   6. RISK_RESTRICTION        - mandatory policy veto, independent of models
//
// The classifier NEVER emits a scalar score. Each slot is explicitly filled
// or explicitly null, so downstream research must handle each concept
// separately. No thresholds (60% or otherwise) are assumed anywhere.

const POLICIES = new Set(['m1-tactical-v1', 'm1-tactical-v2-m5-lifecycle']);

// Model-opinion blockers (route semantics) vs mandatory policy restrictions.
// These mirrors the governance layer's own blocker vocabulary; anything not
// in the model-opinion set is treated as a risk restriction, never as model
// disagreement.
const MODEL_OPINION_BLOCKERS = new Set(['M1_ROUTE_NOT_ELIGIBLE', 'M1_HIGHER_TIMEFRAME_CONFLICT']);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Classify one decision-time M1 abstention record into the six semantic slots.
 *
 * record: {
 *   provenance: 'RECORDED_AS_OF' | other,      // decision-time attestation
 *   policyVersion: string,
 *   route: 'ABSTAIN' | other,
 *   reason: string,                             // exact recorded reason
 *   candidate: { directionQuality?, confidence?, score?, scoreEdge?,
 *                alignedHigherTimeframeAgreement? },
 *   blockers?: string[],                        // recorded governance blockers
 * }
 */
function classifyAbstentionSemantics(record) {
  const base = {
    artifact: 'm1-abstention-taxonomy-v1',
    researchOnly: true,
    executionAuthority: 'NONE',
    scalarAbstentionStrength: null, // deliberately null; see scalarScoreFeasible
    scalarScoreFeasible: false,
  };

  const unverified = (note) => ({
    ...base,
    status: 'UNVERIFIED_DECISION',
    note,
    slots: {
      directionalConfidence: null,
      predictiveUncertainty: null,
      thresholdDistance: null,
      outcomeProbability: null,
      missingEvidence: note,
      riskRestriction: null,
    },
  });

  if (!record || typeof record !== 'object') return unverified('RECORD_MISSING');
  if (record.provenance !== 'RECORDED_AS_OF') return unverified('PROVENANCE_NOT_AS_OF');
  if (!POLICIES.has(record.policyVersion)) return unverified('POLICY_VERSION_UNKNOWN');
  if (record.route !== 'ABSTAIN') return unverified('NOT_AN_ABSTENTION');

  const c = record.candidate || {};
  const blockers = Array.isArray(record.blockers) ? record.blockers : [];

  // Slot 1: directional confidence exists by construction in the candidate
  // heuristic, but is NOT a probability of anything.
  const directionalConfidence = finite(c.confidence)
    ? {
        value: c.confidence,
        semantics: 'SELF_ASSESSED_DIRECTION_ALIGNMENT',
        unit: 'heuristic_index',
        calibrated: false,
      }
    : null;

  // Slot 2: predictive uncertainty is never recorded for M1 decisions.
  const predictiveUncertainty = null; // no calibrated uncertainty model exists

  // Slot 3: threshold distance is only defined for single-predicate reasons
  // with a known policy boundary. Compound reasons expose no unique boundary.
  let thresholdDistance = { defined: false, reason: 'COMPOUND_OR_UNSUPPORTED_REASON' };
  if (record.reason === 'DIRECTION_EDGE_TOO_SMALL' && finite(c.scoreEdge)) {
    thresholdDistance = {
      defined: true,
      measurement: c.scoreEdge,
      boundary: 0.08,
      comparator: 'MINIMUM',
      shortfall: Math.max(0, 0.08 - c.scoreEdge),
      unit: 'score',
    };
  } else if (
    record.reason === 'HIGHER_TIMEFRAME_CONFLICT' &&
    finite(c.alignedHigherTimeframeAgreement)
  ) {
    // Inclusive boundary: equality itself triggers the veto, so shortfall is
    // the distance at or below the boundary, never negative.
    thresholdDistance = {
      defined: true,
      measurement: c.alignedHigherTimeframeAgreement,
      boundary: -0.12,
      comparator: 'AT_OR_BELOW',
      shortfall: Math.max(0, -0.12 - c.alignedHigherTimeframeAgreement),
      unit: 'alignment',
    };
  }

  // Slot 4: outcome probability requires a calibrated outcome model; none
  // exists for M1 abstention (AUC 0.4752 is indistinguishable from 0.5).
  const outcomeProbability = null;

  // Slot 5: missing evidence is detected, never imputed.
  const missing = [];
  if (!finite(c.directionQuality)) missing.push('directionQuality');
  if (!finite(c.confidence)) missing.push('confidence');
  if (!finite(c.score)) missing.push('score');
  if (!finite(c.scoreEdge)) missing.push('scoreEdge');
  if (record.reason === null || record.reason === undefined) missing.push('reason');
  if (blockers.length === 0) missing.push('blockerVector');

  // Slot 6: risk restrictions are policy vetoes, not model opinions.
  const riskRestriction = blockers
    .filter((b) => !MODEL_OPINION_BLOCKERS.has(b))
    .map((b) => ({ blocker: b, semantics: 'MANDATORY_POLICY_VETO' }));

  return {
    ...base,
    status: missing.length > 0 ? 'PARTIAL_EVIDENCE' : 'CLASSIFIED',
    reason: record.reason,
    slots: {
      directionalConfidence,
      predictiveUncertainty,
      thresholdDistance,
      outcomeProbability,
      missingEvidence: missing,
      riskRestriction,
    },
    scalarScoreFeasible: false,
    rationale:
      'A single scalar would conflate a heuristic direction index, an ' +
      'uncalibrated uncertainty, a geometric margin, an unmeasured outcome ' +
      'probability, data gaps and mandatory policy vetoes. Each slot must be ' +
      'consumed separately; no 0-100 number is defined or assumed.',
  };
}

module.exports = { classifyAbstentionSemantics };
