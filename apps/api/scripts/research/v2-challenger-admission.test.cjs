'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideAdmission } = require('./v2-challenger-admission.cjs');

// Synthetic candidate: p=0.55, avgWinR=1.0, avgLossR=1.0, risk $100,
// commission $3, spread $1, slippage $1 → costR = 0.05.
// point gross R = 0.55-0.45 = 0.10 → net 0.05.
// p10=0.51 → conservative gross 0.02 → net -0.03 → PREDICTIVE_UNCERTAINTY_HIGH.
const candidate = () => ({
  calibratedWinProbability: { value: 0.55, provenance: 'CALIBRATED_HOLDOUT', holdoutSampleN: 400 },
  payoffGeometry: { avgWinR: 1.0, avgLossR: 1.0 },
  costModel: { provenance: 'BROKER_OBSERVED', commissionUsd: 3, spreadUsd: 1, slippageUsd: 1, riskUsd: 100 },
  uncertainty: { method: 'HOLDOUT_BOOTSTRAP_P10_P90', probabilityP10: 0.51, probabilityP90: 0.59 },
});

test('refuses a point-estimate-only candidate whose conservative bound is not positive', () => {
  const d = decideAdmission(candidate());
  assert.equal(d.decision, 'ABSTAIN');
  assert.equal(d.reason, 'PREDICTIVE_UNCERTAINTY_HIGH');
  assert.equal(d.executionAuthority, 'NONE');
  assert.equal(d.researchOnly, true);
  assert.equal(d.measurements.pointExpectedNetR, 0.05);
  assert.equal(d.measurements.conservativeExpectedNetR, -0.03);
  assert.equal(d.measurements.costR, 0.05);
  assert.equal(d.shortfall.shortfall, 0.03);
});

test('admits only when the lower-bound net expected R is positive with broker-observed costs', () => {
  const d = decideAdmission({ ...candidate(), uncertainty: { probabilityP10: 0.52, probabilityP90: 0.58 } });
  // p10=0.52 → conservative gross = 0.04 → net = -0.01 → still abstains.
  assert.equal(d.decision, 'ABSTAIN');
  const strong = decideAdmission({ ...candidate(), uncertainty: { probabilityP10: 0.555, probabilityP90: 0.545 } });
  // p10=0.545 → gross 0.09 → net 0.04 > 0 → ADMIT_RESEARCH.
  assert.equal(strong.decision, 'ADMIT_RESEARCH');
  assert.equal(strong.measurements.conservativeExpectedNetR, 0.04);
  assert.equal(strong.admissionBasis, 'lower-bound net expected R after broker-observed costs');
});

test('cost-dominated candidates abstain with an exact friction measurement', () => {
  const d = decideAdmission({ ...candidate(), costModel: { provenance: 'BROKER_OBSERVED', commissionUsd: 12, spreadUsd: 2, slippageUsd: 1, riskUsd: 100 } });
  assert.equal(d.decision, 'ABSTAIN');
  assert.equal(d.reason, 'COST_DOMINATED');
  assert.equal(d.measurements.costR, 0.15);
  // Realistic Pepperstone-scale drag: 121 trades lost $1,267.20 commission
  // on the documented baseline — the exact defect class this guard targets.
  assert.equal(d.measurements.pointExpectedGrossR, 0.1);
});

test('refuses uncalibrated confidence provenance regardless of the number', () => {
  const d = decideAdmission({ ...candidate(), calibratedWinProbability: { value: 0.9, provenance: 'RAW_SCORE', holdoutSampleN: 10000 } });
  assert.equal(d.decision, 'ABSTAIN');
  assert.equal(d.reason, 'MISSING_EVIDENCE');
  assert.ok(d.missing.includes('calibratedWinProbability.provenance=CALIBRATED_HOLDOUT'));
});

test('refuses small calibration samples and missing uncertainty bounds', () => {
  const small = decideAdmission({ ...candidate(), calibratedWinProbability: { value: 0.6, provenance: 'CALIBRATED_HOLDOUT', holdoutSampleN: 40 } });
  assert.equal(small.reason, 'MISSING_EVIDENCE');
  assert.ok(small.missing.some((m) => m.startsWith('calibratedWinProbability.holdoutSampleN')));
  const noUnc = decideAdmission({ ...candidate(), uncertainty: null });
  assert.ok(noUnc.missing.includes('uncertainty.probabilityP10+P90'));
});

test('mandatory risk restrictions abstain first and are never overridden by edge', () => {
  const d = decideAdmission({ ...candidate(), mandatoryRiskRestriction: 'HIGH_IMPACT_EVENT_BLACKOUT' });
  assert.equal(d.reason, 'RISK_RESTRICTION');
  assert.equal(d.restriction, 'HIGH_IMPACT_EVENT_BLACKOUT');
});

test('paper-conservative cost provenance can score but never admits', () => {
  const d = decideAdmission({ ...candidate(), uncertainty: { probabilityP10: 0.56, probabilityP90: 0.58 },
    costModel: { provenance: 'PAPER_CONSERVATIVE', commissionUsd: 3, spreadUsd: 1, slippageUsd: 1, riskUsd: 100 } });
  // conservative net = (2*0.56-1) - 0.05 = 0.07 > 0, yet PAPER costs cannot admit.
  assert.equal(d.decision, 'ABSTAIN');
  assert.equal(d.reason, 'MISSING_EVIDENCE');
  assert.equal(d.measurements.costProvenance, 'PAPER_CONSERVATIVE');
});

test('directional confidence below even chance abstains before uncertainty checks', () => {
  const d = decideAdmission({ ...candidate(), uncertainty: { probabilityP10: 0.45, probabilityP90: 0.65 } });
  assert.equal(d.reason, 'DIRECTIONAL_CONFIDENCE_LOW');
  assert.equal(d.shortfall.boundary, 0.5);
  assert.equal(d.shortfall.shortfall, 0.05);
});
