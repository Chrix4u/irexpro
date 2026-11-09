import { resolveAdverseExitProvenance } from './adverse-exit-provenance';

describe('historical close-request provenance (research-only)', () => {
  const submitted = {
    action: 'TRADE_SUBMITTED',
    closeReason: 'AI_CLOSE_SIGNAL',
    aiCloseTrigger: {
      source: 'BROKER_ADVERSE_PROTECTION',
      reasonCode: 'ADVERSE_THESIS_FAILED',
    },
  };

  it('links a single reconciled close submission to the app trigger without claiming broker certification', () => {
    expect(
      resolveAdverseExitProvenance({ directCloseReason: null, requestEvidence: [submitted] }),
    ).toEqual({
      reason: 'ADVERSE_THESIS_FAILED',
      source: 'TRADE_SUBMITTED_CORRELATED',
      auditedAtClose: false,
      correlatedAppRequest: true,
      requestEvidenceCount: 1,
      brokerReasonCertified: false,
    });
  });

  it('supports the pre-dispatch close-request audit for prospective closures', () => {
    expect(
      resolveAdverseExitProvenance({
        directCloseReason: null,
        requestEvidence: [{ ...submitted, action: 'TRADE_CLOSE_REQUESTED' }],
      }),
    ).toMatchObject({
      reason: 'ADVERSE_THESIS_FAILED',
      source: 'TRADE_CLOSE_REQUESTED_CORRELATED',
      correlatedAppRequest: true,
      brokerReasonCertified: false,
    });
  });

  it('prioritizes a consistent directly audited close without overstating provider certainty', () => {
    expect(
      resolveAdverseExitProvenance({
        directCloseReason: 'ADVERSE_THESIS_FAILED',
        requestEvidence: [submitted],
      }),
    ).toMatchObject({
      source: 'TRADE_CLOSED_DIRECT',
      auditedAtClose: true,
      brokerReasonCertified: false,
    });
  });

  it('does not guess emergency versus ordinary when the request and close disagree', () => {
    expect(
      resolveAdverseExitProvenance({
        directCloseReason: 'EMERGENCY_ADVERSE_CUT',
        requestEvidence: [submitted],
      }).reason,
    ).toBe('UNVERIFIED_IN_TRADE_AUDIT');
  });

  it('preserves emergency reason only when a matching source explicitly says emergency', () => {
    expect(
      resolveAdverseExitProvenance({
        directCloseReason: null,
        requestEvidence: [
          {
            ...submitted,
            aiCloseTrigger: {
              source: 'BROKER_ADVERSE_PROTECTION',
              reasonCode: 'EMERGENCY_ADVERSE_CUT',
            },
          },
        ],
      }),
    ).toMatchObject({
      reason: 'EMERGENCY_ADVERSE_CUT',
      source: 'TRADE_SUBMITTED_CORRELATED',
    });
  });

  it('does not conflate separate, conflicting close requests', () => {
    const conflict = {
      ...submitted,
      aiCloseTrigger: {
        source: 'BROKER_ADVERSE_PROTECTION',
        reasonCode: 'EMERGENCY_ADVERSE_CUT',
      },
    };
    expect(
      resolveAdverseExitProvenance({
        directCloseReason: null,
        requestEvidence: [submitted, conflict],
      }),
    ).toMatchObject({ reason: 'UNVERIFIED_IN_TRADE_AUDIT', requestEvidenceCount: 2 });
  });

  it.each([
    [],
    [{ ...submitted, aiCloseTrigger: { source: 'UNVERIFIED' } }],
    [{ ...submitted, closeReason: 'PROFIT_PROTECTION' }],
    [{ ...submitted, aiCloseTrigger: { source: 'BROKER_THESIS_PROTECTION' } }],
    [{ ...submitted, action: 'TRADE_OPENED' }],
    [submitted, submitted, submitted, submitted],
    '{bad-json',
    { action: 'TRADE_SUBMITTED' },
    null,
  ])('keeps uncertain or malformed evidence unverified: %p', (requestEvidence) => {
    expect(
      resolveAdverseExitProvenance({ directCloseReason: null, requestEvidence }),
    ).toMatchObject({
      reason: 'UNVERIFIED_IN_TRADE_AUDIT',
      source: 'UNVERIFIED',
      brokerReasonCertified: false,
    });
  });

  it('accepts a JSON string only when each request is internally consistent', () => {
    expect(
      resolveAdverseExitProvenance({
        directCloseReason: null,
        requestEvidence: JSON.stringify([submitted]),
      }).reason,
    ).toBe('ADVERSE_THESIS_FAILED');
  });

  it('does not invent an event when there was no matching audit log', () => {
    expect(
      resolveAdverseExitProvenance({
        directCloseReason: 'UNVERIFIED_IN_TRADE_AUDIT',
        requestEvidence: [],
      }),
    ).toMatchObject({
      reason: 'UNVERIFIED_IN_TRADE_AUDIT',
      requestEvidenceCount: 0,
      correlatedAppRequest: false,
    });
  });
});
