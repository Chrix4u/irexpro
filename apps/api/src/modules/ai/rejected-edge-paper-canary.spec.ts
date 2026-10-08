import { evaluateRejectedEdgePaperCanary } from './rejected-edge-paper-canary';

describe('rejected-edge PAPER canary', () => {
  const evidence = {
    global30m: { samples: 15, positive: 12, avgR: 1.088, minR: -0.381, maxR: 5.786 },
    pairSide30m: { samples: 2, positive: 1, avgR: 0.254, minR: -0.381, maxR: 0.888 },
  };
  const candidate = {
    confidence: 0.64,
    netExpectedR: 0.2,
    executionSpreadEvidenceValid: true,
    eventRisk: 'CLEAR' as const,
    portfolioQuality: 1,
    strategyRoute: 'TREND_CONTINUATION' as const,
    paperExecutionBlockers: [
      'ENSEMBLE_NOT_PAPER_ADMITTED',
      'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
      'DRIFT_OUT_OF_DISTRIBUTION',
    ],
  };

  it('enables a research canary only when global and pair-side rejected-edge evidence are strong', () => {
    expect(evaluateRejectedEdgePaperCanary({ candidate, evidence })).toMatchObject({
      eligible: true,
      route: 'REJECTED_EDGE_CANARY',
    });
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
