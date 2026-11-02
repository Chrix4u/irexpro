import { evaluateMultimodelDemoAuthority } from './multimodel-demo-authority';
import type { M1TacticalRoute } from './m1-tactical-route';

function reversalAuthorityInput(m1TimingRoute: M1TacticalRoute) {
  return {
    ensemble: {
      paperAdmitted: true,
      ensembleScore: 0.74,
      strategyRoute: 'CONFIRMED_REVERSAL' as const,
    },
    governance: {
      paperExecutionEligible: true,
      paperExecutionBlockers: [],
      netExpectedR: 0.31,
      paperNetExpectedRPassed: true,
      paperExecutionCostUsable: true,
      eventRisk: 'CLEAR' as const,
      sleeveState: 'COLLECTING' as const,
      driftState: 'NORMAL' as const,
    },
    trainedExpert: {
      state: 'ABSTAIN' as const,
      reason: null,
      decisionTime: '2026-10-29T00:00:00.000Z',
      freshnessSeconds: 0,
      allBrokerNative: true,
      direction: 'SELL' as const,
      admitted: false,
      ensembleConfidence: 0.55,
      meanOpportunityProbability: 0.35,
      longVotes: 1,
      shortVotes: 2,
      regime: 'calm',
      modifiesExecution: false as const,
    },
    candidateDirection: 'SELL' as const,
    m1TimingRoute,
  };
}

describe('Plan-B confirmed-reversal timing consistency', () => {
  it('blocks a Plan-B confirmed reversal when M1 timing abstains', () => {
    const result = evaluateMultimodelDemoAuthority(
      reversalAuthorityInput('ABSTAIN'),
    );

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain(
      'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED',
    );
  });

  it('blocks a Plan-B confirmed reversal when M1 only sees an early transition', () => {
    const result = evaluateMultimodelDemoAuthority(
      reversalAuthorityInput('M1_EARLY_TRANSITION'),
    );

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain(
      'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED',
    );
  });

  it('does not let high-conviction rescue bypass missing M1 reversal confirmation', () => {
    const input = reversalAuthorityInput('M1_EARLY_TRANSITION');
    const result = evaluateMultimodelDemoAuthority({
      ...input,
      trainedExpert: {
        ...input.trainedExpert,
        state: 'CONFIRM',
        ensembleConfidence: 0.82,
        longVotes: 0,
        shortVotes: 3,
      },
    });

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain(
      'MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED',
    );
  });

  it('keeps a Plan-B confirmed reversal executable when M1 independently confirms reversal', () => {
    const result = evaluateMultimodelDemoAuthority(
      reversalAuthorityInput('M1_CONFIRMED_REVERSAL'),
    );

    expect(result.executable).toBe(true);
    expect(result.authorityPath).toBe('PRIMARY_PLAN_B');
    expect(result.blockers).toEqual([]);
  });
});
