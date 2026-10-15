import { evaluatePaperResearchThroughput } from './paper-research-throughput';
import { evaluateRejectedEdgePaperCanary } from './rejected-edge-paper-canary';

describe('PAPER research loss containment', () => {
  const governanceBlockers = [
    'ENSEMBLE_NOT_PAPER_ADMITTED',
    'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
  ];

  it.each(['OUT_OF_DISTRIBUTION', 'STRESSED'] as const)(
    'keeps %s research-throughput candidates shadow-only even when economics and momentum look attractive',
    (driftState) => {
      const driftBlocker =
        driftState === 'OUT_OF_DISTRIBUTION' ? 'DRIFT_OUT_OF_DISTRIBUTION' : 'DRIFT_STRESSED';

      expect(
        evaluatePaperResearchThroughput({
          normalPaperExecution: false,
          confidence: 0.68,
          netExpectedR: 0.18,
          executionSpreadEvidenceValid: true,
          paperExecutionCostUsable: true,
          eventRisk: 'CLEAR',
          strategyRoute: 'TREND_CONTINUATION',
          driftState,
          directionQuality: 0.5,
          alignedMomentumAtr: 0.8,
          tradeQuality: 0.6,
          exitQuality: 0.6,
          paperExecutionBlockers: [...governanceBlockers, driftBlocker],
        }),
      ).toMatchObject({
        eligible: false,
        reason: 'UNSAFE_BLOCKER',
        qualificationEvidence: false,
        executionAuthority: 'PAPER_ONLY_RESEARCH',
      });
    },
  );

  it.each(['DRIFT_OUT_OF_DISTRIBUTION', 'DRIFT_STRESSED'] as const)(
    'rejects rejected-edge canary execution when %s is present',
    (driftBlocker) => {
      expect(
        evaluateRejectedEdgePaperCanary({
          candidate: {
            confidence: 0.68,
            netExpectedR: 0.2,
            alignedMomentumAtr: 0.8,
            executionSpreadEvidenceValid: true,
            paperExecutionCostUsable: true,
            eventRisk: 'CLEAR',
            portfolioQuality: 1,
            strategyRoute: 'TREND_CONTINUATION',
            paperExecutionBlockers: [...governanceBlockers, driftBlocker],
          },
          evidence: {
            global30m: { samples: 20, positive: 16, avgR: 0.8, minR: -0.5, maxR: 2.5 },
            pairSide30m: { samples: 8, positive: 7, avgR: 0.7, minR: -0.2, maxR: 2.0 },
          },
        }),
      ).toMatchObject({ eligible: false, reason: 'UNSAFE_BLOCKER' });
    },
  );

  it('does not disable research when the drift is NORMAL and only non-admission blockers remain', () => {
    expect(
      evaluatePaperResearchThroughput({
        normalPaperExecution: false,
        confidence: 0.68,
        netExpectedR: 0.18,
        executionSpreadEvidenceValid: true,
        paperExecutionCostUsable: true,
        eventRisk: 'CLEAR',
        strategyRoute: 'TREND_CONTINUATION',
        driftState: 'NORMAL',
        directionQuality: 0.5,
        alignedMomentumAtr: 0.8,
        tradeQuality: 0.6,
        exitQuality: 0.6,
        paperExecutionBlockers: governanceBlockers,
      }),
    ).toMatchObject({ eligible: true, reason: 'RESEARCH_EVIDENCE_CANDIDATE' });
  });
});
