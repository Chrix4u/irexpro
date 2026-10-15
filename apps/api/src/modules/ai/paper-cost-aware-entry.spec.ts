import { evaluatePaperCostAwareEntry } from './paper-cost-aware-entry';

describe('evaluatePaperCostAwareEntry', () => {
  const base = {
    executionRoute: 'PAPER_RESEARCH_THROUGHPUT' as const,
    grossExpectedR: 0.3,
    netExpectedR: 0.16,
    estimatedExecutionCostR: 0.14,
    evidence: {
      grossPositiveSamples: 20,
      costFlippedSamples: 5,
      netPositiveSamples: 15,
    },
  };

  it('enters now when current economics and pair-side cost retention are healthy', () => {
    expect(evaluatePaperCostAwareEntry(base)).toMatchObject({
      action: 'ENTER_NOW',
      reason: 'COST_EFFICIENT_ENTRY',
      modifiesExecution: true,
      qualificationEvidence: false,
    });
  });

  it('does not overfit sparse pair-side cost evidence', () => {
    expect(
      evaluatePaperCostAwareEntry({
        ...base,
        evidence: { grossPositiveSamples: 5, costFlippedSamples: 4, netPositiveSamples: 1 },
      }),
    ).toMatchObject({
      action: 'ENTER_NOW',
      reason: 'SPARSE_COHORT_EVIDENCE',
    });
  });

  it('defers a research entry when the pair-side cohort loses too many gross-positive setups to costs', () => {
    expect(
      evaluatePaperCostAwareEntry({
        ...base,
        evidence: { grossPositiveSamples: 20, costFlippedSamples: 11, netPositiveSamples: 9 },
      }),
    ).toMatchObject({
      action: 'DEFER',
      reason: 'PAIR_SIDE_COST_DRAG',
      costFlipRate: 0.55,
    });
  });

  it('shadows a research entry when pair-side cost drag is severe', () => {
    expect(
      evaluatePaperCostAwareEntry({
        ...base,
        evidence: { grossPositiveSamples: 20, costFlippedSamples: 15, netPositiveSamples: 5 },
      }),
    ).toMatchObject({
      action: 'SHADOW_ONLY',
      reason: 'PAIR_SIDE_COST_DRAG_SEVERE',
      costFlipRate: 0.75,
    });
  });

  it('defers marginal net edge when current execution cost consumes most of gross edge', () => {
    expect(
      evaluatePaperCostAwareEntry({
        ...base,
        grossExpectedR: 0.26,
        netExpectedR: 0.09,
        estimatedExecutionCostR: 0.17,
        evidence: { grossPositiveSamples: 20, costFlippedSamples: 4, netPositiveSamples: 16 },
      }),
    ).toMatchObject({
      action: 'DEFER',
      reason: 'CURRENT_COST_BURDEN_HIGH',
    });
  });

  it('still defers obviously expensive current economics when cohort evidence is sparse', () => {
    expect(
      evaluatePaperCostAwareEntry({
        ...base,
        grossExpectedR: 0.26,
        netExpectedR: 0.09,
        estimatedExecutionCostR: 0.17,
        evidence: { grossPositiveSamples: 5, costFlippedSamples: 1, netPositiveSamples: 4 },
      }),
    ).toMatchObject({
      action: 'DEFER',
      reason: 'CURRENT_COST_BURDEN_HIGH',
    });
  });

  it('allows a strong low-cost current setup through moderate historical cost drag', () => {
    expect(
      evaluatePaperCostAwareEntry({
        ...base,
        grossExpectedR: 0.32,
        netExpectedR: 0.22,
        estimatedExecutionCostR: 0.1,
        evidence: { grossPositiveSamples: 20, costFlippedSamples: 10, netPositiveSamples: 10 },
      }),
    ).toMatchObject({
      action: 'ENTER_NOW',
      reason: 'STRONG_CURRENT_EDGE_OVERRIDE',
    });
  });

  it('is diagnostic only for non-research PAPER routes', () => {
    expect(
      evaluatePaperCostAwareEntry({
        ...base,
        executionRoute: 'NORMAL_PAPER',
        evidence: { grossPositiveSamples: 20, costFlippedSamples: 20, netPositiveSamples: 0 },
      }),
    ).toMatchObject({
      action: 'ENTER_NOW',
      reason: 'DIAGNOSTIC_ONLY_NON_RESEARCH_ROUTE',
      modifiesExecution: false,
      qualificationEvidence: false,
    });
  });

  it('allows a calibrated-cost rescue to use current calibrated economics instead of historical fixed-cost flip drag', () => {
    const decision = evaluatePaperCostAwareEntry({
      executionRoute: 'PAPER_RESEARCH_THROUGHPUT',
      grossExpectedR: 0.22,
      netExpectedR: 0.12,
      estimatedExecutionCostR: 0.1,
      calibratedCostRescue: true,
      evidence: { grossPositiveSamples: 100, costFlippedSamples: 90, netPositiveSamples: 10 },
    });

    expect(decision).toMatchObject({
      action: 'ENTER_NOW',
      reason: 'CALIBRATED_RESCUE_CURRENT_EDGE',
      modifiesExecution: true,
      qualificationEvidence: false,
    });
  });

  it('still defers a calibrated rescue when its current calibrated cost burden is high and edge is marginal', () => {
    const decision = evaluatePaperCostAwareEntry({
      executionRoute: 'PAPER_RESEARCH_THROUGHPUT',
      grossExpectedR: 0.22,
      netExpectedR: 0.1,
      estimatedExecutionCostR: 0.15,
      calibratedCostRescue: true,
      evidence: { grossPositiveSamples: 100, costFlippedSamples: 90, netPositiveSamples: 10 },
    });

    expect(decision.action).toBe('DEFER');
    expect(decision.reason).toBe('CURRENT_COST_BURDEN_HIGH');
  });
});
