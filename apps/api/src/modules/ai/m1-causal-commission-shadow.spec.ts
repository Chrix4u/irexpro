import {
  evaluateM1CausalCommissionShadow,
  M1_CAUSAL_COMMISSION_SHADOW_ARTIFACT,
} from './m1-causal-commission-shadow';

describe('M1 as-of commission shadow evaluator', () => {
  const input = {
    observedAt: new Date('2026-11-04T20:00:00.000Z'),
    originalNetExpectedR: 0.17,
    spreadOnlyCostR: 0.035,
    minimumRequiredNetR: 0.08,
    evidence: { sampleCount: 27, p90FeeR: 0.285 },
  };

  it('adds historical commission to spread-only governance without enabling trades', () => {
    const result = evaluateM1CausalCommissionShadow(input);
    expect(result).toMatchObject({
      artifact: M1_CAUSAL_COMMISSION_SHADOW_ARTIFACT,
      mode: 'SHADOW_ONLY',
      noTradeAuthority: true,
      modifiesExecution: false,
      reason: 'CAUSAL_FEE_EVIDENCE_READY',
      sampleCount: 27,
      originalNetExpectedR: 0.17,
      spreadOnlyCostR: 0.035,
      p90AdditionalCommissionAndAdverseFinancingR: 0.285,
      estimatedNetAfterFeeR: -0.115,
      hypotheticalNetFloorPassed: false,
    });
  });

  it('preserves the original model net even when the cost overlay changes its research label', () => {
    const result = evaluateM1CausalCommissionShadow({
      ...input,
      originalNetExpectedR: 0.5,
      evidence: { sampleCount: 40, p90FeeR: 0.25 },
    });
    expect(result.originalNetExpectedR).toBe(0.5);
    expect(result.estimatedNetAfterFeeR).toBe(0.25);
    expect(result.hypotheticalNetFloorPassed).toBe(true);
    expect(result.noTradeAuthority).toBe(true);
  });

  it('treats insufficient prior trades as unknown rather than assuming zero cost', () => {
    for (const evidence of [
      null,
      { sampleCount: 0, p90FeeR: null },
      { sampleCount: 4, p90FeeR: 0.1 },
    ]) {
      const result = evaluateM1CausalCommissionShadow({ ...input, evidence });
      expect(result.reason).toBe('INSUFFICIENT_PRIOR_CLOSED_TRADES');
      expect(result.estimatedNetAfterFeeR).toBeNull();
      expect(result.hypotheticalNetFloorPassed).toBeNull();
    }
  });

  it('distinguishes a failed broker-fee lookup from an actually immature sample', () => {
    const result = evaluateM1CausalCommissionShadow({
      ...input,
      evidence: null,
      lookupFailed: true,
    });
    expect(result.reason).toBe('FEE_LOOKUP_UNAVAILABLE');
    expect(result.estimatedNetAfterFeeR).toBeNull();
    expect(result.hypotheticalNetFloorPassed).toBeNull();
    expect(result.noTradeAuthority).toBe(true);
  });

  it('rejects invalid or negative commission estimates without optimistic substitution', () => {
    for (const fee of [-0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluateM1CausalCommissionShadow({
        ...input,
        evidence: { sampleCount: 20, p90FeeR: fee },
      });
      expect(result.reason).toBe('INVALID_FEE_EVIDENCE');
      expect(result.estimatedNetAfterFeeR).toBeNull();
    }
  });

  it('rejects invalid base economics and time instead of granting a pass', () => {
    const cases = [
      { originalNetExpectedR: Number.NaN },
      { spreadOnlyCostR: -0.02 },
      { minimumRequiredNetR: Number.NaN },
      { observedAt: new Date('invalid') },
    ];
    for (const change of cases) {
      const result = evaluateM1CausalCommissionShadow({ ...input, ...change });
      expect(result.reason).toBe('INVALID_SPREAD_ONLY_EXPECTANCY');
      expect(result.hypotheticalNetFloorPassed).toBeNull();
    }
  });
});
