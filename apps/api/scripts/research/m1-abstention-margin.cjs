'use strict';

// Descriptive, offline measurement of recorded rejection margins. A margin
// is not a calibrated probability, trade permission, or counterfactual fill.
const POLICIES = new Set(['m1-tactical-v1', 'm1-tactical-v2-m5-lifecycle']);
const ARTIFACT = 'm1-abstention-reason-margins-v1';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value) => Number(value.toFixed(8));
function margin(name, value, boundary, comparator, unit) {
  if (!finite(value)) return null;
  const difference = comparator === 'MINIMUM' ? boundary - value : value - boundary;
  return { name, value, boundary, comparator, unit, shortfall: round(Math.max(0, difference)) };
}
function measureAbstention(record) {
  const base = { artifact: ARTIFACT, researchOnly: true, executionAuthority: 'NONE',
    calibratedProbability: null, abstentionStrength: null };
  const unknown = (status) => ({ ...base, status, measurements: [] });
  if (!record || record.provenance !== 'RECORDED_AS_OF' ||
      !POLICIES.has(record.policyVersion) || record.route !== 'ABSTAIN') {
    return unknown('UNVERIFIED_DECISION');
  }
  const c = record.candidate || {};
  if (record.reason === 'INVALID_COUNTERFACTUAL_PAIR') return unknown('INVALID_EVIDENCE');
  if (record.reason === 'DIRECTION_EDGE_TOO_SMALL') {
    const m = margin('scoreEdge', record.scoreEdge, 0.08, 'MINIMUM', 'score');
    if (!m) return unknown('MISSING_MEASUREMENT');
    if (record.scoreEdge >= 0.08) return unknown('INCONSISTENT_EVIDENCE');
    return { ...base, status: 'MEASURED', reason: record.reason, measurements: [m] };
  }
  if (record.reason === 'HIGHER_TIMEFRAME_CONFLICT') {
    const m = margin('higherTimeframeAgreement', c.alignedHigherTimeframeAgreement, -0.12, 'MINIMUM', 'alignment');
    if (!m) return unknown('MISSING_MEASUREMENT');
    if (m.value < -1 || m.value > -0.12) return unknown('INCONSISTENT_EVIDENCE');
    // Equality triggers the actual conflict predicate; the margin is zero.
    return { ...base, status: 'MEASURED', reason: record.reason, measurements: [m] };
  }
  if (record.reason === 'M5_REVERSAL_NOT_CONFIRMED') {
    const established = [
      margin('m5BodyPressure3', c.alignedM5BodyPressure3, 0.08, 'MINIMUM', 'pressure'),
      margin('m5Momentum3Atr', c.alignedM5Momentum3Atr, 0.08, 'MINIMUM', 'ATR'),
      margin('m5Momentum1Atr', c.alignedM5Momentum1Atr, -0.1, 'MINIMUM', 'ATR'),
    ];
    const fresh = [
      margin('m5LatestBodyPressure', c.alignedM5LatestBodyPressure, 0.6, 'MINIMUM', 'pressure'),
      margin('m5Momentum1Atr', c.alignedM5Momentum1Atr, 0.3, 'MINIMUM', 'ATR'),
      margin('m5Momentum3Atr', c.alignedM5Momentum3Atr, -0.1, 'MINIMUM', 'ATR'),
    ];
    if ([...established, ...fresh].some((m) => m === null)) return unknown('MISSING_MEASUREMENT');
    const passes = (group) => group.every((m) => m.value >= m.boundary);
    if (passes(established) || passes(fresh)) return unknown('INCONSISTENT_EVIDENCE');
    return { ...base, status: 'MEASURED', reason: record.reason, measurements: [],
      alternatives: { establishedTurn: established, decisiveFreshTurn: fresh } };
  }
  // Exhaustion and NO_VALID_ROUTE involve multiple interacting predicates.
  // Do not reduce them to a misleading one-dimensional score.
  return unknown('MULTI_CONDITION_OR_UNSUPPORTED_REASON');
}
module.exports = { measureAbstention };
