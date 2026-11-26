'use strict';

// Offline descriptive evidence audit. No market access, signal generation,
// policy tuning, order execution or promotion authority. Accepts a separately
// prepared anonymized evidence join; never infers decisions from prices.
const STATES = new Set(['APPROVED', 'REJECTED', 'UNKNOWN']);
const RESULTS = new Set(['WIN', 'LOSS', 'FLAT', 'UNOBSERVED']);
function utcMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(time).toISOString() === canonical ? time : null;
}
function summarizeEvidence(rows) {
  if (!Array.isArray(rows)) throw new Error('INVALID_EVIDENCE_INPUT');
  const seen = new Set();
  const counts = {
    APPROVED: { WIN: 0, LOSS: 0, FLAT: 0, UNOBSERVED: 0 },
    REJECTED: { WIN: 0, LOSS: 0, FLAT: 0, UNOBSERVED: 0 },
    UNKNOWN: { WIN: 0, LOSS: 0, FLAT: 0, UNOBSERVED: 0 },
  };
  let incompleteDecisionEvidence = 0;
  let incompleteOutcomeEvidence = 0;
  let timingOnly = 0;
  let additionalBlockers = 0;
  let unattributedRejections = 0;
  for (const row of rows) {
    if (!row || typeof row.caseKey !== 'string' || !row.caseKey.trim() ||
        seen.has(row.caseKey) || !STATES.has(row.decision) || !RESULTS.has(row.outcome)) {
      throw new Error('INVALID_OR_DUPLICATE_EVIDENCE');
    }
    seen.add(row.caseKey);
    const entry = utcMillis(row.referenceAt);
    const decision = utcMillis(row.decisionAt);
    const closed = utcMillis(row.outcomeAt);
    const decisionValid = row.decision !== 'UNKNOWN' &&
      row.decisionProvenance === 'RECORDED_AS_OF' &&
      entry !== null && decision !== null && decision <= entry;
    const outcomeValid = row.outcome !== 'UNOBSERVED' &&
      row.outcomeProvenance === 'BROKER_SETTLED' &&
      entry !== null && closed !== null && closed > entry;
    if (!decisionValid) incompleteDecisionEvidence++;
    if (!outcomeValid) incompleteOutcomeEvidence++;
    const state = decisionValid ? row.decision : 'UNKNOWN';
    const result = outcomeValid ? row.outcome : 'UNOBSERVED';
    counts[state][result]++;
    if (state === 'REJECTED') {
      if (row.blockerAttribution === 'M1_ONLY') timingOnly++;
      else if (row.blockerAttribution === 'M1_AND_OTHER') additionalBlockers++;
      else unattributedRejections++;
    }
  }
  return {
    artifact: 'm1-decision-evidence-coverage-v1',
    researchOnly: true,
    executionAuthority: 'NONE',
    qualificationEvidence: false,
    cases: rows.length,
    incompleteDecisionEvidence,
    incompleteOutcomeEvidence,
    counts,
    rejectedAttribution: { timingOnly, additionalBlockers, unattributedRejections },
    limitations: 'Historical broker-settled cases are a selected subset; rejected unfilled candidates have no actual outcome. Counts are not causal estimates or a trading policy.',
  };
}
module.exports = { summarizeEvidence };
