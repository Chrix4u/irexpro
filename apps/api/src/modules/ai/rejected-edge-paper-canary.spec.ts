import {
  evaluateRejectedEdgePaperCanary,
  rejectedEdgeCanaryEvaluationState,
} from './rejected-edge-paper-canary';

describe('rejected-edge PAPER canary', () => {
  const evidence = {
    global30m: { samples: 15, positive: 12, avgR: 1.088, minR: -0.381, maxR: 5.786 },
    pairSide30m: { samples: 2, positive: 1, avgR: 0.254, minR: -0.381, maxR: 0.888 },
  };
  const candidate = {
    confidence: 0.64,
    netExpectedR: 0.2,
    alignedMomentumAtr: 0.4,
    executionSpreadEvidenceValid: true,
    eventRisk: 'CLEAR' as const,
    portfolioQuality: 1,
    strategyRoute: 'TREND_CONTINUATION' as const,
    paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'ENSEMBLE_NOT_PROMOTABLE_ADMISSION'],
  };

  it('enables a research canary only when global and pair-side rejected-edge evidence are strong', () => {
    expect(evaluateRejectedEdgePaperCanary({ candidate, evidence })).toMatchObject({
      eligible: true,
      route: 'REJECTED_EDGE_CANARY',
    });
  });

  it('accepts the PAPER cost fallback when live spread evidence is unavailable', () => {
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: {
          ...candidate,
          executionSpreadEvidenceValid: false,
          paperExecutionCostUsable: true,
        },
        evidence,
      }),
    ).toMatchObject({
      eligible: true,
      route: 'REJECTED_EDGE_CANARY',
    });
  });

  it('requires present-moment directional confirmation and rejects exhausted entries', () => {
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, alignedMomentumAtr: 0.149 },
        evidence,
      }),
    ).toMatchObject({ eligible: false, reason: 'MOMENTUM_NOT_CONFIRMED' });
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, alignedMomentumAtr: -0.75 },
        evidence,
      }),
    ).toMatchObject({ eligible: false, reason: 'MOMENTUM_NOT_CONFIRMED' });
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, alignedMomentumAtr: 1.501 },
        evidence,
      }),
    ).toMatchObject({ eligible: false, reason: 'MOMENTUM_EXHAUSTED' });

    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, alignedMomentumAtr: 0.15 },
        evidence,
      }).eligible,
    ).toBe(true);
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, alignedMomentumAtr: 1.5 },
        evidence,
      }).eligible,
    ).toBe(true);
  });

  it('fails closed when current economics, spread, event risk, or portfolio safety fail', () => {
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, netExpectedR: 0.05 },
        evidence,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, executionSpreadEvidenceValid: false },
        evidence,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, eventRisk: 'BLOCKED' },
        evidence,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, portfolioQuality: 0.2 },
        evidence,
      }).eligible,
    ).toBe(false);
  });

  it('allows strong standalone pair-side evidence when the global basket is weak', () => {
    const weakGlobalStrongPair = {
      global30m: { samples: 47, positive: 22, avgR: 0.068, minR: -0.882, maxR: 2.02 },
      pairSide30m: { samples: 7, positive: 6, avgR: 0.754, minR: -0.076, maxR: 2.02 },
    };

    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, confidence: 0.6417, netExpectedR: 0.446 },
        evidence: weakGlobalStrongPair,
      }),
    ).toMatchObject({
      eligible: true,
      route: 'REJECTED_EDGE_CANARY',
      reason: 'PAIR_SIDE_EVIDENCE_QUALIFIED',
    });
  });

  it('rejects weak evidence and any blocker outside the research-only allowlist', () => {
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate,
        evidence: { ...evidence, global30m: { ...evidence.global30m, samples: 14 } },
      }).eligible,
    ).toBe(false);
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate,
        evidence: { ...evidence, pairSide30m: { ...evidence.pairSide30m, avgR: 0.1 } },
      }).eligible,
    ).toBe(false);
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: {
          ...candidate,
          paperExecutionBlockers: [...candidate.paperExecutionBlockers, 'SLEEVE_BLOCKED'],
        },
        evidence,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: {
          ...candidate,
          paperExecutionBlockers: [...candidate.paperExecutionBlockers, 'DRIFT_STRESSED'],
        },
        evidence,
      }),
    ).toMatchObject({ eligible: false, reason: 'UNSAFE_BLOCKER' });
  });

  it('explains why the canary was not evaluated instead of reporting an opaque state', () => {
    expect(
      rejectedEdgeCanaryEvaluationState({
        normalPaperExecution: false,
        evidenceServiceAvailable: true,
        netExpectedR: 0.08,
      }),
    ).toBe('NET_EXPECTED_R_BELOW_FLOOR');
    expect(
      rejectedEdgeCanaryEvaluationState({
        normalPaperExecution: false,
        evidenceServiceAvailable: false,
        netExpectedR: 0.2,
      }),
    ).toBe('EVIDENCE_SERVICE_UNAVAILABLE');
    expect(
      rejectedEdgeCanaryEvaluationState({
        normalPaperExecution: false,
        evidenceServiceAvailable: true,
        netExpectedR: 0.2,
      }),
    ).toBe('EVALUATED');
  });

  it('does not reuse continuation evidence for early-transition or reversal execution', () => {
    expect(
      evaluateRejectedEdgePaperCanary({
        candidate: { ...candidate, strategyRoute: 'EARLY_TRANSITION' },
        evidence,
      }).eligible,
    ).toBe(false);
  });
});
