'use strict';

// Offline semantic description, never an execution or qualification decision.
const { measureAbstention } = require('./m1-abstention-margin.cjs');
const POLICIES = new Set(['m1-tactical-v1', 'm1-tactical-v2-m5-lifecycle']);
const MODEL_OPINION_BLOCKERS = new Set(['M1_ROUTE_NOT_ELIGIBLE', 'M1_HIGHER_TIMEFRAME_CONFLICT']);
// Deliberately conservative: unreviewed blocker codes remain unclassified.
// No inferred permission, even if this list is empty.
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, min, max) => finite(v) && v >= min && v <= max;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function classifyAbstentionSemantics(record) {
  const base = {
    artifact: 'm1-abstention-taxonomy-v2',
    researchOnly: true,
    executionAuthority: 'NONE',
    scalarAbstentionStrength: null,
    scalarScoreFeasible: false,
  };
  const unverified = (note) => ({
    ...base, status: 'UNVERIFIED_DECISION', note,
    slots: {
      directionalConfidence: null, predictiveUncertainty: null,
      thresholdDistance: null, outcomeProbability: null,
      missingEvidence: [note], riskRestriction: null,
    },
    unclassifiedBlockers: null,
  });
  if (!record || typeof record !== 'object') return unverified('RECORD_MISSING');
  if (record.provenance !== 'RECORDED_AS_OF') return unverified('PROVENANCE_NOT_AS_OF');
  if (!POLICIES.has(record.policyVersion)) return unverified('POLICY_VERSION_UNKNOWN');
  if (record.route !== 'ABSTAIN') return unverified('NOT_AN_ABSTENTION');
  if (record.reason === 'INVALID_COUNTERFACTUAL_PAIR') return unverified('INVALID_COUNTERFACTUAL_PAIR');
  const c = record.candidate || {};
  const rd = record.governance?.routeDecision;
  if (rd && (rd.route !== record.route || rd.reason !== record.reason ||
      rd.policyVersion !== record.policyVersion)) return unverified('ROUTE_DECISION_MISMATCH');
  const edge = rd ? rd.scoreEdge : record.scoreEdge;
  // A legacy candidate-local edge is not a canonical source. If present,
  // reject any disagreement; never silently substitute for absent evidence.
  if ((rd && own(record, 'scoreEdge') && record.scoreEdge !== edge) ||
      (own(c, 'scoreEdge') && finite(edge) && c.scoreEdge !== edge)) {
    return unverified('SCORE_EDGE_MISMATCH');
  }
  const measured = measureAbstention({ ...record, scoreEdge: edge });
  if (measured.status === 'INVALID_EVIDENCE' || measured.status === 'INCONSISTENT_EVIDENCE') {
    return unverified(measured.status);
  }
  const missing = [];
  if (!inRange(c.directionQuality, 0, 1)) missing.push('directionQuality');
  if (!inRange(c.confidence, 0, 0.738)) missing.push('confidence');
  if (!finite(c.score)) missing.push('score');
  if (!finite(edge)) missing.push('scoreEdge');
  if (typeof record.reason !== 'string' || !record.reason) missing.push('reason');
  if (measured.status === 'MISSING_MEASUREMENT') missing.push('marginEvidence');
  const blockers = Array.isArray(record.blockers) &&
    record.blockers.every((b) => typeof b === 'string' && b.trim())
    ? [...new Set(record.blockers)] : null;
  if (blockers === null) missing.push('blockerVector');
  const unclassifiedBlockers = blockers === null ? null :
    blockers.filter((b) => !MODEL_OPINION_BLOCKERS.has(b));
  return {
    ...base,
    status: missing.length ? 'PARTIAL_EVIDENCE' : 'CLASSIFIED',
    reason: record.reason,
    slots: {
      directionalConfidence: inRange(c.confidence, 0, 0.738)
        ? { value: c.confidence, semantics: 'SELF_ASSESSED_DIRECTION_ALIGNMENT',
            unit: 'heuristic_index', calibrated: false } : null,
      predictiveUncertainty: null,
      thresholdDistance: { status: measured.status, measurements: measured.measurements,
        ...(measured.alternatives ? { alternatives: measured.alternatives } : {}) },
      outcomeProbability: null,
      missingEvidence: missing,
      riskRestriction: null,
    },
    unclassifiedBlockers,
    rationale: 'No calibrated scalar is defined. Unknown blocker codes are not classified as risk restrictions.',
  };
}
module.exports = { classifyAbstentionSemantics };
