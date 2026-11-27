'use strict';

// Descriptive completeness inventory for independently prepared anonymous records.
// No database connector, model fit, threshold selection, or execution path.
const { summarizeEvidence } = require('./m1-decision-evidence-coverage.cjs');
const POLICIES = new Set(['m1-tactical-v1', 'm1-tactical-v2-m5-lifecycle']);
const FIELDS = Object.freeze([
  ['directionQuality', 0, 1],
  ['confidence', 0, 0.738],
  ['score', -Infinity, Infinity],
  ['scoreEdge', -Infinity, Infinity],
  ['alignedHigherTimeframeAgreement', -1, 1],
  ['alignedMomentum3Atr', -Infinity, Infinity],
  ['alignedM5Momentum3Atr', -Infinity, Infinity],
]);
function inventoryFeatures(rows) {
  const evidence = summarizeEvidence(rows);
  const fields = Object.fromEntries(FIELDS.map(([name]) => [name, {
    valid: 0, missing: 0, invalid: 0, unverified: 0,
    settledWin: 0, settledLoss: 0, settledFlat: 0, outcomeUnknown: 0,
  }]));
  for (const row of rows) {
    const single = summarizeEvidence([row]);
    const verified = single.incompleteDecisionEvidence === 0 &&
      POLICIES.has(row.policyVersion);
    for (const [name, min, max] of FIELDS) {
      const tally = fields[name];
      if (!verified) { tally.unverified++; continue; }
      const value = row.features?.[name];
      if (value === undefined || value === null) { tally.missing++; continue; }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        tally.invalid++; continue;
      }
      tally.valid++;
      if (single.incompleteOutcomeEvidence) tally.outcomeUnknown++;
      else if (row.outcome === 'WIN') tally.settledWin++;
      else if (row.outcome === 'LOSS') tally.settledLoss++;
      else tally.settledFlat++;
    }
  }
  return { artifact: 'm1-feature-completeness-v1', researchOnly: true,
    executionAuthority: 'NONE', qualificationEvidence: false,
    cases: evidence.cases, fields,
    limitation: 'Supplied lineage assertions require independent verification. Counts describe completeness only, not prediction performance.' };
}
module.exports = { inventoryFeatures };
