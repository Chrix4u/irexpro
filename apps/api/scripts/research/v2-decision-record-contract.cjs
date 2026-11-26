'use strict';

// Independent research artifact: V2 decision-record contract (iRexPro AI V2
// research). Pure logic over SYNTHETIC fixtures. No database access, no
// model execution, no broker calls, no trading authority.
//
// The V1 audit found five distinct, non-commensurable "confidence" scalars
// and a triple-registered directionQuality feeding one 0.60 gate, with the
// recorded blocker list erased for rescued trades. This contract makes the
// V2 structural invariants executable:
//   C1  exactly ONE confidence field per decision, with a declared,
//       verified calibration state (calibrated | uncalibrated | unknown);
//       uncalibrated confidence may NEVER drive sizing (it is provenance only).
//   C2  the six abstention-uncertainty slots of the M1 abstention
//       measurement contract stay separate; collapsing them into a scalar
//       0-100 "strength" is REJECTED.
//   C3  every decision records decision-time evidence completeness
//       (as-of provenance fields present or explicitly marked missing);
//       retrospective reconstruction is flagged, not silently accepted.
//   C4  cost-first economics: an after-cost expected-R estimate with its
//       cost-model version is REQUIRED for any executable decision; the
//       V1 gap (modeled 0.073R spread-only vs realized 0.146-0.202R
//       commission) must not be repeatable.
//   C5  drift/OOD state is an explicit decision input; OOD decisions are
//       recorded as OOD, never re-labelled after the fact.
//   C6  no hardcoded account/owner/lot carve-outs inside the decision
//       record; special permissions live in a separate policy layer that
//       the record references by version hash.

const CALIBRATION_STATES = Object.freeze(['CALIBRATED', 'UNCALIBRATED', 'UNKNOWN']);
const SLOT_NAMES = Object.freeze([
  'directionalConfidence',
  'predictiveUncertainty',
  'thresholdDistance',
  'outcomeProbability',
  'missingEvidence',
  'mandatoryRiskRestriction',
]);

function validateDecisionRecord(d) {
  const findings = [];
  const push = (code, detail) => findings.push({ code, detail });
  if (d === null || typeof d !== 'object') return [{ code: 'NOT_AN_OBJECT', detail: '' }];

  // C1: single confidence with declared calibration state.
  const confidenceFields = Object.keys(d).filter((k) => /confidence/i.test(k));
  if (confidenceFields.length !== 1) {
    push('C1_CONFIDENCE_CARDINALITY', `found [${confidenceFields.join(', ')}]; exactly one allowed`);
  } else if (!CALIBRATION_STATES.includes(d[confidenceFields[0]]?.calibration)) {
    push('C1_CALIBRATION_STATE_UNDECLARED', `${confidenceFields[0]}.calibration must be one of ${CALIBRATION_STATES.join('|')}`);
  } else if (d[confidenceFields[0]].calibration !== 'CALIBRATED' && d.executionIntent === 'EXECUTE') {
    push('C1_UNCALIBRATED_CONFIDENCE_CANNOT_SIZE', 'uncalibrated/unknown confidence may not drive an executable decision');
  }

  // C2: six separate uncertainty slots; no collapsed scalar.
  if (typeof d.scalarAbstentionStrength === 'number') {
    push('C2_SCALAR_COLLAPSE_REJECTED', 'a 0-100 strength scalar is prohibited');
  }
  const slots = d.uncertaintySlots;
  if (slots === null || typeof slots !== 'object') {
    push('C2_SLOTS_MISSING', 'uncertaintySlots record required');
  } else {
    const present = Object.keys(slots);
    const missing = SLOT_NAMES.filter((s) => !present.includes(s));
    if (missing.length) push('C2_SLOT_INCOMPLETE', `missing: ${missing.join(', ')}`);
    for (const name of present) {
      if (!SLOT_NAMES.includes(name)) push('C2_UNKNOWN_SLOT', name);
      const v = slots[name];
      // Each slot is either explicitly null (unknown) or carries its own
      // measurement object; a scalar number in a slot is the same collapse.
      if (typeof v === 'number') push('C2_SLOT_IS_SCALAR', `${name} must be a measurement object or null`);
    }
  }

  // C3: decision-time provenance completeness.
  const provenance = d.evidenceProvenance;
  if (!provenance || typeof provenance !== 'object') {
    push('C3_PROVENANCE_MISSING', 'evidenceProvenance required');
  } else {
    if (provenance.recordedBeforeOutcome !== true) push('C3_NOT_AS_OF', 'recordedBeforeOutcome must be true (decision-time write)');
    if (typeof provenance.supersedeCount !== 'number' || provenance.supersedeCount < 0) {
      push('C3_SUPERSEDE_COUNT_REQUIRED', 're-evaluations must be counted, not silently dropped (V1 first-write-wins defect)');
    }
    if (provenance.reconstructed === true) push('C3_RETROSPECTIVE_RECONSTRUCTION', 'flagged: evidence reconstructed after the fact');
  }

  // C4: cost-first economics on executable decisions.
  if (d.executionIntent === 'EXECUTE') {
    const econ = d.afterCostEconomics;
    if (!econ || typeof econ !== 'object') {
      push('C4_AFTER_COST_ECONOMICS_REQUIRED', 'executable decisions require an after-cost expected-R estimate');
    } else {
      if (typeof econ.expectedNetR !== 'number' || !Number.isFinite(econ.expectedNetR)) push('C4_EXPECTED_NET_R_REQUIRED', '');
      if (typeof econ.costModelVersion !== 'string' || !econ.costModelVersion) push('C4_COST_MODEL_VERSION_REQUIRED', 'the V1 3x cost understatement must be attributable');
      if (typeof econ.includesCommission !== 'boolean' || econ.includesCommission !== true) {
        push('C4_COMMISSION_MUST_BE_INCLUDED', 'spread-only cost models are rejected (V1 defect: 0.073R modeled vs 0.146-0.202R realized)');
      }
    }
  }

  // C5: explicit drift state.
  if (typeof d.driftState !== 'string' || !['NORMAL', 'STRESSED', 'OUT_OF_DISTRIBUTION'].includes(d.driftState)) {
    push('C5_DRIFT_STATE_REQUIRED', 'driftState must be recorded on every decision');
  } else if (d.driftState === 'OUT_OF_DISTRIBUTION' && d.executionIntent === 'EXECUTE') {
    push('C5_OOD_EXECUTION_FLAGGED', 'OOD execution requires explicit drift-rescue provenance; it is never silently re-labelled');
  }

  // C6: no inline owner/account carve-outs.
  for (const key of Object.keys(d)) {
    if (/owner|accountId|lotCeiling|carveout|override/i.test(key)) {
      push('C6_INLINE_PERMISSION_DETECTED', `${key}: permissions must live in the referenced policy layer`);
    }
  }
  if (typeof d.policyVersionSha !== 'string' || !d.policyVersionSha) {
    push('C6_POLICY_VERSION_REQUIRED', 'decision must reference the policy layer by version hash');
  }

  return { findings, contract: 'V2_DECISION_RECORD_V1' };
}

module.exports = { validateDecisionRecord, CALIBRATION_STATES, SLOT_NAMES };
