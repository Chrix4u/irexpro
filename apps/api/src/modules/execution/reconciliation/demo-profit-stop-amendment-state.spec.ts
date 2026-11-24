import {
  transitionDemoProfitStopIntent as move,
  isDurablyReconciledProfitStopEvidence as evidence,
} from './demo-profit-stop-amendment-state';
const all = {
  ownerDemoVerified: true,
  providerAcknowledged: true,
  providerReadbackConfirmed: true,
  providerStopMatchesProposal: true,
  authoritativeStopCommitted: true,
};
describe('DEMO profit-stop intent never gives itself order/hold authority', () => {
  it('requires ACK, broker readback and durable authority commit in strict order', () => {
    const chain = [
      ['PREPARED', 'REQUEST_RECORDED', 'DISPATCHING'],
      ['DISPATCHING', 'PROVIDER_ACCEPTED', 'ACKNOWLEDGED'],
      ['ACKNOWLEDGED', 'PROVIDER_READBACK_CONFIRMED', 'BROKER_VERIFIED'],
      ['BROKER_VERIFIED', 'AUTHORITY_TRANSACTION_COMMITTED', 'AUTHORITY_COMMITTED'],
    ] as const;
    for (const [from, event, to] of chain) {
      const x = move(from, event, all);
      expect(x.nextState).toBe(to);
      expect(x.grantsLiveHoldPermission).toBe(false);
      expect(x.brokerOrderActions).toBe(0);
      expect(x.modifiesOpenPositions).toBe(false);
    }
  });
  it('never treats acknowledgement alone as verified broker protection', () => {
    expect(
      move('ACKNOWLEDGED', 'PROVIDER_READBACK_CONFIRMED', {
        ...all,
        providerReadbackConfirmed: false,
      }).nextState,
    ).toBe('ACKNOWLEDGED');
    expect(
      move('ACKNOWLEDGED', 'PROVIDER_READBACK_CONFIRMED', {
        ...all,
        providerStopMatchesProposal: false,
      }).nextState,
    ).toBe('ACKNOWLEDGED');
    expect(
      move('BROKER_VERIFIED', 'AUTHORITY_TRANSACTION_COMMITTED', {
        ...all,
        authoritativeStopCommitted: false,
      }).nextState,
    ).toBe('BROKER_VERIFIED');
    expect(move('PREPARED', 'AUTHORITY_TRANSACTION_COMMITTED', all).nextState).toBe('PREPARED');
  });
  it('fails safe when owner scope is wrong or provider outcome is uncertain', () => {
    expect(
      move('DISPATCHING', 'PROVIDER_ACCEPTED', { ...all, ownerDemoVerified: false }).nextState,
    ).toBe('DISPATCHING');
    for (const from of ['DISPATCHING', 'ACKNOWLEDGED', 'BROKER_VERIFIED'] as const) {
      expect(move(from, 'UNRESOLVED_PROVIDER_OUTCOME', all).nextState).toBe(
        'NEEDS_MANUAL_RECONCILIATION',
      );
    }
    expect(move('PREPARED', 'EXPIRED_WITHOUT_REQUEST', all).nextState).toBe('EXPIRED');
  });
  it('does not blindly retry terminal or manual states', () => {
    for (const from of [
      'AUTHORITY_COMMITTED',
      'FAILED',
      'EXPIRED',
      'NEEDS_MANUAL_RECONCILIATION',
    ] as const) {
      expect(move(from, 'REQUEST_RECORDED', all).nextState).toBe(from);
    }
  });
  it('requires fresh broker AND committed DB stop proof even for research readiness', () => {
    const observedAt = new Date('2026-11-19T10:40:00Z');
    const base = {
      state: 'AUTHORITY_COMMITTED' as const,
      brokerAcceptedAt: new Date('2026-11-19T10:35:00Z'),
      brokerVerifiedAt: new Date('2026-11-19T10:35:10Z'),
      authoritativeCommittedAt: new Date('2026-11-19T10:35:12Z'),
      brokerStop: 1.1012,
      persistedStop: 1.1012,
      proposedStop: 1.1012,
      observedAt,
    };
    expect(evidence(base)).toBe(true);
    for (const change of [
      { state: 'BROKER_VERIFIED' as const },
      { brokerAcceptedAt: null },
      { brokerVerifiedAt: null },
      { authoritativeCommittedAt: null },
      { brokerStop: 1.1011 },
      { persistedStop: 1.1011 },
      { brokerStop: null },
      { authoritativeCommittedAt: new Date('2026-11-19T10:30:12Z') },
      { brokerVerifiedAt: new Date('2026-11-19T10:45:00Z') },
    ])
      expect(evidence({ ...base, ...change })).toBe(false);
  });
});
