'use strict';
/**
 * DEMO research helpers. Distinguish known-at-order evidence from
 * retrospective reviews. Never grants order authority.
 */
const time = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
};
function evaluateM1AtEntry(input) {
  const opened = time(input.openedAt);
  const ownAt = time(input.executedM1CreatedAt);
  const oppAt = time(input.oppositeM1CreatedAt);
  const oppEval = time(input.oppositeM1EvaluatedAt);
  const own = opened !== null && ownAt !== null && ownAt <= opened;
  const opposite = own && oppAt !== null && oppEval !== null &&
    oppAt <= opened && oppEval <= opened;
  return {
    executedDecisionAvailableAtEntry: own,
    oppositeDecisionAvailableAtEntry: opposite,
    verifiedDoubleAbstain: opposite &&
      input.executedM1Route === 'ABSTAIN' &&
      input.oppositeM1Route === 'ABSTAIN',
  };
}
function theoreticalNoEntryOmission(examples) {
  // NOT a backtest. No offsetting position, no transaction cost or portfolio
  // path is simulated. Positive net profits are *missed*, not saved.
  const candidates = examples.filter(x=>x.retrospectiveAudit.verifiedDoubleAbstain);
  const foregoneWinnerNetUsd = candidates.filter(x=>x.labels.netUsd > 0)
    .reduce((s,x)=>s+x.labels.netUsd,0);
  const avoidedLoserNetUsd = -candidates.filter(x=>x.labels.netUsd < 0)
    .reduce((s,x)=>s+x.labels.netUsd,0);
  const round = x=>Number(x.toFixed(2));
  return {
    eligibleHistoricalTrades: candidates.length,
    missedWinners: candidates.filter(x=>x.labels.netUsd > 0).length,
    avoidedLosers: candidates.filter(x=>x.labels.netUsd < 0).length,
    foregoneWinnerNetUsd: round(foregoneWinnerNetUsd),
    avoidedLoserNetUsd: round(avoidedLoserNetUsd),
    theoreticalOmittedNetUsd: round(avoidedLoserNetUsd - foregoneWinnerNetUsd),
    executablePolicy: false,
    prospectiveValidation: false,
  };
}
module.exports = {evaluateM1AtEntry,theoreticalNoEntryOmission};
