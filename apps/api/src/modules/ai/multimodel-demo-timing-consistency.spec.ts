import { evaluateMultimodelDemoAuthority } from './multimodel-demo-authority';

function qualifiedInput() {
  return {
    ensemble: {
      paperAdmitted: true,
      ensembleScore: 0.76,
      strategyRoute: 'TREND_CONTINUATION' as const,
    },
    governance: {
      paperExecutionEligible: true,
      paperExecutionBlockers: [] as string[],
      netExpectedR: 0.31,
      paperNetExpectedRPassed: true,
      paperExecutionCostUsable: true,
      eventRisk: 'CLEAR' as const,
      sleeveState: 'COLLECTING' as const,
      driftState: 'NORMAL' as const,
    },
    trainedExpert: {
      state: 'UNAVAILABLE' as const,
      reason: 'NOT_REQUIRED',
      decisionTime: null,
      freshnessSeconds: null,
      allBrokerNative: false,
      direction: null,
      admitted: null,
      ensembleConfidence: null,
      meanOpportunityProbability: null,
      longVotes: null,
      shortVotes: null,
      regime: null,
      modifiesExecution: false as const,
    },
    candidateDirection: 'SELL' as const,
  };
}

describe('multimodel demo timing consistency', () => {
  it('blocks a Plan-B trend continuation when the M1 timing specialist says abstain', () => {
    const result = evaluateMultimodelDemoAuthority({
      ...qualifiedInput(),
      m1TimingRoute: 'ABSTAIN',
    });

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain('MULTIMODEL_CONTINUATION_TIMING_NOT_READY');
  });

  it('keeps a qualified Plan-B trend continuation executable when M1 timing is ready', () => {
    const result = evaluateMultimodelDemoAuthority({
      ...qualifiedInput(),
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(true);
    expect(result.blockers).toEqual([]);
  });
});
