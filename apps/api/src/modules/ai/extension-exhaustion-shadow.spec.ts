import * as ExtensionExhaustion from './extension-exhaustion-shadow';

const { scoreExtensionExhaustionShadow } = ExtensionExhaustion;

describe('scoreExtensionExhaustionShadow', () => {
  const base = {
    regime: 'TREND_EXTENDED' as const,
    driftState: 'NORMAL' as const,
    confidence: 0.6968,
    netExpectedR: 0.2853,
    directionQuality: 0.4178,
    tradeQuality: 0.3757,
    exitQuality: 0.357,
    extensionAtr: 1.12,
    executionSpreadEvidenceValid: true,
  };

  it('tags a NORMAL-drift extended setup as shadow candidate without execution authority', () => {
    const score = scoreExtensionExhaustionShadow(base);
    expect(score).toMatchObject({
      artifact: 'extension-exhaustion-shadow-v1',
      candidate: true,
      reason: 'SHADOW_CANDIDATE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
  });

  it('rejects OOD drift even when expected edge is high', () => {
    expect(
      scoreExtensionExhaustionShadow({ ...base, driftState: 'OUT_OF_DISTRIBUTION' }),
    ).toMatchObject({
      candidate: false,
      reason: 'DRIFT_NOT_NORMAL',
    });
  });

  it('rejects weak direction quality instead of globally lowering continuation gates', () => {
    expect(scoreExtensionExhaustionShadow({ ...base, directionQuality: 0.2 })).toMatchObject({
      candidate: false,
      reason: 'DIRECTION_QUALITY_TOO_LOW',
    });
  });

  it('rejects weak or unavailable economics', () => {
    expect(scoreExtensionExhaustionShadow({ ...base, netExpectedR: 0.05 })).toMatchObject({
      candidate: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(
      scoreExtensionExhaustionShadow({ ...base, executionSpreadEvidenceValid: false }),
    ).toMatchObject({
      candidate: false,
      reason: 'SPREAD_EVIDENCE_INVALID',
    });
  });
});

describe('PAPER extension-exhaustion research', () => {
  it('exposes a separate PAPER-only evaluator instead of granting execution authority to the shadow scorer', () => {
    expect(typeof ExtensionExhaustion.evaluatePaperExtensionExhaustionResearch).toBe('function');
  });

  it('admits only a strong extended NORMAL-drift candidate with clear event risk and usable PAPER costs', () => {
    const evaluate = ExtensionExhaustion.evaluatePaperExtensionExhaustionResearch;
    const base = {
      regime: 'TREND_EXTENDED',
      driftState: 'NORMAL',
      confidence: 0.67,
      netExpectedR: 0.14,
      directionQuality: 0.41,
      tradeQuality: 0.31,
      exitQuality: 0.29,
      extensionAtr: 1.2,
      eventRisk: 'CLEAR',
      paperExecutionCostUsable: true,
    };
    expect(evaluate(base)).toMatchObject({
      artifact: 'paper-extension-exhaustion-research-v1',
      eligible: true,
      reason: 'PAPER_RESEARCH_CANDIDATE',
      executionAuthority: 'PAPER_ONLY',
      productionEligible: false,
      qualificationEvidence: false,
    });
    expect(evaluate({ ...base, netExpectedR: 0.119 })).toMatchObject({
      eligible: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(evaluate({ ...base, eventRisk: 'BLOCKED' })).toMatchObject({
      eligible: false,
      reason: 'EVENT_RISK_NOT_CLEAR',
    });
    expect(evaluate({ ...base, paperExecutionCostUsable: false })).toMatchObject({
      eligible: false,
      reason: 'EXECUTION_COST_UNUSABLE',
    });
  });
});
