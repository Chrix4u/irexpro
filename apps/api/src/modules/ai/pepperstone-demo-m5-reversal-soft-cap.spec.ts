import {
  evaluatePepperstoneDemoM5ReversalSoftCap as check,
  PEPPERSTONE_DEMO_M5_REVERSAL_MAX_FRACTION,
} from './pepperstone-demo-m5-reversal-soft-cap';

const base = {
  enabled: true,
  ownerVerifiedUsdDemo: true,
  route: 'CONFIRMED_REVERSAL',
  alignedM5: -0.61,
  brokerM5Direction: 'NEUTRAL',
  requestedLotCap: 2,
};

describe('owner DEMO M5 conflict soft-lot cap', () => {
  it('reduces a 2-lot cap to 1.4 without changing entry permission or broker stops', () => {
    const r = check(base);
    expect(r.applied).toBe(true);
    expect(r.requestedLotCap).toBeCloseTo(1.4, 4);
    expect(PEPPERSTONE_DEMO_M5_REVERSAL_MAX_FRACTION).toBe(0.7);
    expect(r.blocksTrades).toBe(false);
    expect(r.changesStops).toBe(false);
    expect(r.changesLive).toBe(false);
  });
  it('maintains a 1-lot floor only if original cap was already higher', () => {
    expect(check({ ...base, requestedLotCap: 1.25 }).requestedLotCap).toBe(1);
    const micro = check({ ...base, requestedLotCap: 0.15 });
    expect(micro.applied).toBe(false);
    expect(micro.requestedLotCap).toBe(0.15);
  });
  it('cannot increase a cap or apply to Early Transition', () => {
    const other = check({ ...base, route: 'EARLY_TRANSITION' });
    expect(other.requestedLotCap).toBe(2);
    expect(other.applied).toBe(false);
    expect(check({ ...base, requestedLotCap: 1.05 }).requestedLotCap).toBe(1);
  });
  it('never affects unverified owners, disabled flag or other strategies', () => {
    for (const value of [
      { enabled: false },
      { ownerVerifiedUsdDemo: false },
      { route: 'TREND_CONTINUATION' },
    ]) {
      const r = check({ ...base, ...value });
      expect(r.applied).toBe(false);
      expect(r.requestedLotCap).toBe(2);
    }
  });
  it('requires an as-of aligned M5 conflict, not just a small negative number', () => {
    for (const alignedM5 of [null, Number.NaN, -0.19, 0, 0.5]) {
      const r = check({ ...base, alignedM5 });
      expect(r.applied).toBe(false);
    }
    expect(check({ ...base, alignedM5: -0.2 }).applied).toBe(true);
  });
  it('requires independent completed broker M5 context', () => {
    for (const brokerM5Direction of [null, 'UNAVAILABLE', 'UNKNOWN']) {
      expect(check({ ...base, brokerM5Direction }).applied).toBe(false);
    }
    expect(check({ ...base, brokerM5Direction: 'WITH' }).applied).toBe(true);
    expect(check({ ...base, brokerM5Direction: 'AGAINST' }).applied).toBe(true);
  });
  it('does not manufacture a cap on invalid input', () => {
    expect(check({ ...base, requestedLotCap: Number.NaN }).applied).toBe(false);
    expect(check({ ...base, requestedLotCap: 0 }).requestedLotCap).toBe(0);
  });
});
