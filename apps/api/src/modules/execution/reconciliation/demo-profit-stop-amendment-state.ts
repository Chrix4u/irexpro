/**
 * Planning/verification state machine ONLY. Does not call a broker, does not
 * persist trades, and never grants active HOLD authority. The DB ledger and
 * this reducer are prerequisites for a separately reviewed execution rollout.
 */
export type DemoProfitStopIntentState =
  | 'PREPARED'
  | 'DISPATCHING'
  | 'ACKNOWLEDGED'
  | 'BROKER_VERIFIED'
  | 'AUTHORITY_COMMITTED'
  | 'FAILED'
  | 'EXPIRED'
  | 'NEEDS_MANUAL_RECONCILIATION';
export type DemoProfitStopIntentEvent =
  | 'REQUEST_RECORDED'
  | 'PROVIDER_ACCEPTED'
  | 'PROVIDER_READBACK_CONFIRMED'
  | 'AUTHORITY_TRANSACTION_COMMITTED'
  | 'PROVIDER_REJECTED'
  | 'EXPIRED_WITHOUT_REQUEST'
  | 'UNRESOLVED_PROVIDER_OUTCOME';

export type DemoProfitStopIntentTransition = {
  previousState: DemoProfitStopIntentState;
  nextState: DemoProfitStopIntentState;
  changed: boolean;
  requiresBrokerReadback: boolean;
  requiresAuthoritativeSync: boolean;
  grantsLiveHoldPermission: false;
  brokerOrderActions: 0;
  modifiesOpenPositions: false;
};

export function transitionDemoProfitStopIntent(
  state: DemoProfitStopIntentState,
  event: DemoProfitStopIntentEvent,
  proof: {
    ownerDemoVerified: boolean;
    providerAcknowledged: boolean;
    providerReadbackConfirmed: boolean;
    providerStopMatchesProposal: boolean;
    authoritativeStopCommitted: boolean;
  },
): DemoProfitStopIntentTransition {
  const result = (next: DemoProfitStopIntentState): DemoProfitStopIntentTransition => ({
    previousState: state,
    nextState: next,
    changed: state !== next,
    requiresBrokerReadback: next === 'ACKNOWLEDGED' || next === 'DISPATCHING',
    requiresAuthoritativeSync: next === 'BROKER_VERIFIED' || next === 'NEEDS_MANUAL_RECONCILIATION',
    grantsLiveHoldPermission: false,
    brokerOrderActions: 0,
    modifiesOpenPositions: false,
  });
  if (!proof.ownerDemoVerified) return result(state);
  switch (state) {
    case 'PREPARED':
      if (event === 'REQUEST_RECORDED') return result('DISPATCHING');
      if (event === 'EXPIRED_WITHOUT_REQUEST') return result('EXPIRED');
      if (event === 'PROVIDER_REJECTED') return result('FAILED');
      break;
    case 'DISPATCHING':
      if (event === 'PROVIDER_ACCEPTED' && proof.providerAcknowledged)
        return result('ACKNOWLEDGED');
      if (event === 'PROVIDER_REJECTED') return result('FAILED');
      if (event === 'UNRESOLVED_PROVIDER_OUTCOME') return result('NEEDS_MANUAL_RECONCILIATION');
      break;
    case 'ACKNOWLEDGED':
      if (
        event === 'PROVIDER_READBACK_CONFIRMED' &&
        proof.providerAcknowledged &&
        proof.providerReadbackConfirmed &&
        proof.providerStopMatchesProposal
      )
        return result('BROKER_VERIFIED');
      if (event === 'UNRESOLVED_PROVIDER_OUTCOME') return result('NEEDS_MANUAL_RECONCILIATION');
      break;
    case 'BROKER_VERIFIED':
      if (
        event === 'AUTHORITY_TRANSACTION_COMMITTED' &&
        proof.providerAcknowledged &&
        proof.providerReadbackConfirmed &&
        proof.providerStopMatchesProposal &&
        proof.authoritativeStopCommitted
      )
        return result('AUTHORITY_COMMITTED');
      if (event === 'UNRESOLVED_PROVIDER_OUTCOME') return result('NEEDS_MANUAL_RECONCILIATION');
      break;
    case 'AUTHORITY_COMMITTED':
    case 'FAILED':
    case 'EXPIRED':
    case 'NEEDS_MANUAL_RECONCILIATION':
      // Terminal / manually recoverable states are never silently retried.
      break;
  }
  return result(state);
}

/** This predicate is deliberately NOT a live hold permission. It only
 * classifies completed dual-proof evidence for future evaluation. */
export function isDurablyReconciledProfitStopEvidence(input: {
  state: DemoProfitStopIntentState;
  brokerAcceptedAt: Date | null;
  brokerVerifiedAt: Date | null;
  authoritativeCommittedAt: Date | null;
  brokerStop: number | null;
  persistedStop: number | null;
  proposedStop: number;
  observedAt: Date;
}): boolean {
  if (
    input.state !== 'AUTHORITY_COMMITTED' ||
    !input.brokerAcceptedAt ||
    !input.brokerVerifiedAt ||
    !input.authoritativeCommittedAt ||
    !Number.isFinite(input.observedAt.getTime()) ||
    !Number.isFinite(input.brokerVerifiedAt.getTime()) ||
    !Number.isFinite(input.authoritativeCommittedAt.getTime()) ||
    input.brokerVerifiedAt > input.observedAt ||
    input.authoritativeCommittedAt > input.observedAt ||
    input.authoritativeCommittedAt < input.brokerVerifiedAt ||
    input.brokerStop === null ||
    input.persistedStop === null ||
    !Number.isFinite(input.brokerStop) ||
    !Number.isFinite(input.persistedStop) ||
    !Number.isFinite(input.proposedStop) ||
    input.proposedStop <= 0
  )
    return false;
  return (
    Math.abs(input.brokerStop - input.proposedStop) <= 1e-8 &&
    Math.abs(input.persistedStop - input.proposedStop) <= 1e-8
  );
}
