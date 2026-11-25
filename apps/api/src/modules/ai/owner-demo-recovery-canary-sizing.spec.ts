import { resolveOwnerDemoRecoveryCanarySizing as choose } from './owner-demo-recovery-canary-sizing';
const base = {
  recoveryCanary: true,
  crossSleeveReversalCanary: false,
  ownerDemoVerified: true,
  featureEnabled: true,
  normalVolumeCap: 4,
  recoveryCanaryLotCap: 0.01,
};
describe('Owner DEMO historical-loss recovery sizing', () => {
  it('uses normal already-admitted model cap and no extra four-hour loss spacing', () => {
    expect(choose(base)).toEqual({
      historicalLossRecoveryAdvisory: true,
      volumeCap: 4,
      enforceHistoricalCanarySpacing: false,
    });
  });
  it.each([
    [{ ...base, ownerDemoVerified: false }, 'unverified broker or stopped session'],
    [{ ...base, featureEnabled: false }, 'other user or env disabled'],
    [{ ...base, crossSleeveReversalCanary: true }, 'independent reversal canary'],
  ])('does not override protected scope %s', (input) => {
    const value = choose(input);
    expect(value.historicalLossRecoveryAdvisory).toBe(false);
    expect(value.volumeCap).toBe(0.01);
    expect(value.enforceHistoricalCanarySpacing).toBe(true);
  });
  it('does not change ordinary non-recovery trades', () => {
    expect(choose({ ...base, recoveryCanary: false })).toEqual({
      historicalLossRecoveryAdvisory: false,
      volumeCap: 4,
      enforceHistoricalCanarySpacing: false,
    });
  });
  it('does not manufacture executable size when model cap is invalid', () => {
    expect(choose({ ...base, normalVolumeCap: Number.NaN }).volumeCap).toBe(0);
    expect(choose({ ...base, normalVolumeCap: -1 }).volumeCap).toBe(0);
  });
  it('preserves any smaller model cap instead of forcing a minimum of 3 or 4 lots', () => {
    expect(choose({ ...base, normalVolumeCap: 0.3 }).volumeCap).toBe(0.3);
  });
});
