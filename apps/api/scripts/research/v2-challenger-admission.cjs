'use strict';

// V2 Challenger admission policy — research-only decision function.
// Core V2 principle: admission requires the LOWER bound of expected net R
// (after broker-observed costs) to exceed zero, not a point estimate. The
// policy refuses uncalibrated confidence, missing cost evidence and
// point-estimate-only reasoning. It never grants execution authority.
const ARTIFACT = 'v2-challenger-admission-v1';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const ABSTENTION_REASONS = [
  'MISSING_EVIDENCE',            // required evidence absent
  'UNCALIBRATED_CONFIDENCE',     // probability provenance rejected
  'COST_DOMINATED',              // costs exceed expected gross edge
  'PREDICTIVE_UNCERTAINTY_HIGH', // point EV positive, conservative EV not
  'DIRECTIONAL_CONFIDENCE_LOW',  // conservative direction not established
  'RISK_RESTRICTION',            // caller-scoped mandatory restriction
];
Object.freeze(ABSTENTION_REASONS);

const DEFAULT_MIN_CALIBRATION_SAMPLE = 100;

const base = () => ({
  artifact: ARTIFACT,
  researchOnly: true,
  executionAuthority: 'NONE',
  decision: 'ABSTAIN',
});

// costR: total per-trade friction converted to R using planned risk.
function costInR(costModel) {
  const total = ['commissionUsd', 'spreadUsd', 'slippageUsd']
    .map((k) => costModel[k])
    .filter(finite)
    .reduce((a, b) => a + b, 0);
  if (!finite(costModel.riskUsd) || costModel.riskUsd <= 0) return null;
  return total / costModel.riskUsd;
}

function decideAdmission(candidate, options = {}) {
  const minCalibrationSample = finite(options.minCalibrationSample)
    ? options.minCalibrationSample : DEFAULT_MIN_CALIBRATION_SAMPLE;
  const out = base();
  const missing = [];
  if (!candidate) return { ...out, reason: 'MISSING_EVIDENCE', missing: ['candidate'] };

  const probability = candidate.calibratedWinProbability || null;
  const geometry = candidate.payoffGeometry || null;
  const costModel = candidate.costModel || null;
  const uncertainty = candidate.uncertainty || null;

  if (!probability || !finite(probability.value)) missing.push('calibratedWinProbability.value');
  if (!probability || probability.provenance !== 'CALIBRATED_HOLDOUT') missing.push('calibratedWinProbability.provenance=CALIBRATED_HOLDOUT');
  if (probability && finite(probability.holdoutSampleN) && probability.holdoutSampleN < minCalibrationSample) {
    missing.push(`calibratedWinProbability.holdoutSampleN>=${minCalibrationSample}`);
  }
  if (!geometry || !finite(geometry.avgWinR) || geometry.avgWinR <= 0) missing.push('payoffGeometry.avgWinR');
  if (!geometry || !finite(geometry.avgLossR) || geometry.avgLossR < 0) missing.push('payoffGeometry.avgLossR');
  if (!costModel || !['BROKER_OBSERVED', 'PAPER_CONSERVATIVE'].includes(costModel.provenance)) {
    missing.push('costModel.provenance=BROKER_OBSERVED|PAPER_CONSERVATIVE');
  }
  if (costModel && !finite(costModel.riskUsd)) missing.push('costModel.riskUsd');
  if (costModel && !finite(costModel.commissionUsd)) missing.push('costModel.commissionUsd');
  if (costModel && !finite(costModel.spreadUsd)) missing.push('costModel.spreadUsd');
  if (costModel && !finite(costModel.slippageUsd)) missing.push('costModel.slippageUsd');
  if (!uncertainty || !finite(uncertainty.probabilityP10) || !finite(uncertainty.probabilityP90)) {
    missing.push('uncertainty.probabilityP10+P90');
  }
  if (missing.length > 0) return { ...out, reason: 'MISSING_EVIDENCE', missing };

  const costR = costInR(costModel);
  if (costR === null) return { ...out, reason: 'MISSING_EVIDENCE', missing: ['costModel.riskUsd>0'] };

  if (candidate.mandatoryRiskRestriction) return { ...out, reason: 'RISK_RESTRICTION', restriction: candidate.mandatoryRiskRestriction };

  const p = probability.value;
  const p10 = Math.min(uncertainty.probabilityP10, uncertainty.probabilityP90);
  const p90 = Math.max(uncertainty.probabilityP10, uncertainty.probabilityP90);
  const pointGrossR = p * geometry.avgWinR - (1 - p) * geometry.avgLossR;
  const conservativeGrossR = p10 * geometry.avgWinR - (1 - p10) * geometry.avgLossR;
  const pointNetR = pointGrossR - costR;
  const conservativeNetR = conservativeGrossR - costR;
  const measurements = {
    pointExpectedGrossR: Number(pointGrossR.toFixed(6)),
    pointExpectedNetR: Number(pointNetR.toFixed(6)),
    conservativeExpectedGrossR: Number(conservativeGrossR.toFixed(6)),
    conservativeExpectedNetR: Number(conservativeNetR.toFixed(6)),
    costR: Number(costR.toFixed(6)),
    costProvenance: costModel.provenance,
    probabilityP10: Number(p10.toFixed(6)),
    probabilityP90: Number(p90.toFixed(6)),
  };

  // Threshold distance is reported exactly (like the M1 margin module);
  // it is never converted into an invented calibrated abstention strength.
  const shortfall = (value, boundary) => Number(Math.max(0, boundary - value).toFixed(6));

  if (pointGrossR <= costR) {
    return { ...out, reason: 'COST_DOMINATED', measurements,
      shortfall: { dimension: 'expectedGrossR', boundary: 'costR', value: Number(pointGrossR.toFixed(6)), shortfall: shortfall(pointGrossR, costR) } };
  }
  if (p10 <= 0.5) {
    return { ...out, reason: 'DIRECTIONAL_CONFIDENCE_LOW', measurements,
      shortfall: { dimension: 'probabilityP10', boundary: 0.5, value: Number(p10.toFixed(6)), shortfall: Number(Math.max(0, 0.5 - p10).toFixed(6)) } };
  }
  if (conservativeNetR <= 0) {
    return { ...out, reason: 'PREDICTIVE_UNCERTAINTY_HIGH', measurements,
      shortfall: { dimension: 'conservativeExpectedNetR', boundary: 0, value: Number(conservativeNetR.toFixed(6)), shortfall: shortfall(conservativeNetR, 0) } };
  }
  if (costModel.provenance !== 'BROKER_OBSERVED') {
    // PAPER_CONSERVATIVE costs may score but never admit even research
    // execution beyond shadow measurement.
    return { ...out, reason: 'MISSING_EVIDENCE', measurements, missing: ['costModel.provenance=BROKER_OBSERVED'],
      note: 'PAPER_CONSERVATIVE cost provenance supports shadow scoring only' };
  }
  return {
    ...out,
    decision: 'ADMIT_RESEARCH',
    reason: 'CONSERVATIVE_NET_EXPECTED_R_POSITIVE',
    measurements,
    admissionBasis: 'lower-bound net expected R after broker-observed costs',
  };
}

module.exports = { decideAdmission, costInR, ABSTENTION_REASONS, ARTIFACT };
