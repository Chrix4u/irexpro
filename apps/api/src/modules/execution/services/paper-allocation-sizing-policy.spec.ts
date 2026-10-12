import {
  paperAllocationRiskTargetPercent,
  paperAllocationSizingPolicy,
} from './paper-allocation-sizing-policy';

describe('paper allocation sizing policy', () => {
  it('uses the explicit AI allocation as the PAPER risk capital base', () => {
    expect(
      paperAllocationSizingPolicy({
        executionMode: 'PAPER_ONLY',
        allocatedCapital: 1_000,
        brokerEquity: 10_000,
        confidenceTier: 'BASE',
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        riskCapitalBase: 1_000,
        requestedRiskPercent: 2,
        removeAiLotCeiling: true,
        removeProfileLotCeiling: true,
      }),
    );
  });

  it('requests 2.5% only for high-conviction PAPER tiers', () => {
    expect(paperAllocationRiskTargetPercent('BASE')).toBe(2);
    expect(paperAllocationRiskTargetPercent('STRONG')).toBe(2);
    expect(paperAllocationRiskTargetPercent('VERY_STRONG')).toBe(2.5);
    expect(paperAllocationRiskTargetPercent('EXCEPTIONAL')).toBe(2.5);
    expect(paperAllocationRiskTargetPercent('RESEARCH')).toBe(1);
  });

  it('never enables allocation-aware overrides outside PAPER', () => {
    expect(
      paperAllocationSizingPolicy({
        executionMode: 'FULL_AUTO',
        allocatedCapital: 1_000,
        brokerEquity: 10_000,
        confidenceTier: 'EXCEPTIONAL',
      }),
    ).toEqual(
      expect.objectContaining({
        enabled: false,
        removeAiLotCeiling: false,
        removeProfileLotCeiling: false,
      }),
    );
  });

  it('fails closed when PAPER allocation is missing or invalid', () => {
    expect(
      paperAllocationSizingPolicy({
        executionMode: 'PAPER_ONLY',
        allocatedCapital: null,
        brokerEquity: 10_000,
        confidenceTier: 'BASE',
      }).enabled,
    ).toBe(false);
    expect(
      paperAllocationSizingPolicy({
        executionMode: 'PAPER_ONLY',
        allocatedCapital: 0,
        brokerEquity: 10_000,
        confidenceTier: 'BASE',
      }).enabled,
    ).toBe(false);
  });
});
