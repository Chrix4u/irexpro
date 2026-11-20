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
  const persistedOpposite = own && oppAt !== null && oppEval !== null &&
    oppAt <= opened && oppEval <= opened;
  // This route is deterministically scored from the SAME feature pair
  // before the candidate reaches order dispatch. Unlike a later DB row,
  // the immutable trade-intent metadata accompanies the opening order.
  const snapshotTime = time(input.sameSnapshotDecisionTime);
  const expectedOtherDirection = input.entryDirection === 'BUY' ? 'SELL' :
    input.entryDirection === 'SELL' ? 'BUY' : null;
  const synchronousSnapshot = own && expectedOtherDirection !== null &&
    input.sameSnapshotShadowOnly === true &&
    input.sameSnapshotDirection === expectedOtherDirection &&
    typeof input.sameSnapshotRoute === 'string' &&
    ['ABSTAIN','M1_TREND_CONTINUATION','M1_CONFIRMED_REVERSAL',
      'M1_EARLY_TRANSITION'].includes(input.sameSnapshotRoute) &&
    snapshotTime !== null && snapshotTime <= opened;
  const opposite = synchronousSnapshot || persistedOpposite;
  const selectedRoute = synchronousSnapshot ? input.sameSnapshotRoute :
    persistedOpposite ? input.oppositeM1Route : null;
  return {
    executedDecisionAvailableAtEntry: own,
    oppositeDecisionAvailableAtEntry: opposite,
    oppositeRouteAtEntry: selectedRoute,
    oppositeSourceAtEntry: synchronousSnapshot
      ? 'SAME_SNAPSHOT_BEFORE_ORDER'
      : persistedOpposite ? 'PERSISTED_BEFORE_ORDER' : 'NOT_AVAILABLE_AT_ENTRY',
    verifiedDoubleAbstain: opposite &&
      input.executedM1Route === 'ABSTAIN' &&
      selectedRoute === 'ABSTAIN',
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
