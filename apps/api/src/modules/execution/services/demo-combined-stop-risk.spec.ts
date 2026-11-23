import { evaluateDemoCombinedStopRisk as check } from './demo-combined-stop-risk';
const common = {
  totalCapital: '40000', brokerEquity: '43565.37', maxPercent: '1',
  observedCommissionPerLot: '6',
};
describe('Pepperstone DEMO serialized combined stop-risk budget', () => {
  it('blocks second 7-lot opening with commission, even when separate per-trade risk fits', () => {
    const v = check({ ...common,
      committed: [{ grossStopRisk: '244.37074533', lots: '7' }],
      proposed: { grossStopRisk: '219.93904546', lots: '7' },
    });
    expect(v.allowed).toBe(false);
    expect(Number(v.projectedRisk)).toBeGreaterThan(Number(v.maxRisk));
  });
  it('allows one verified position within the 1% combined account-risk budget', () => {
    expect(check({ ...common, committed: [], proposed: { grossStopRisk: '244.37074533', lots: '7' } }).allowed).toBe(true);
  });
  it('counts current AUDUSD plus USDJPY as a concentrated DEMO exposure', () => {
    expect(check({ ...common,
      committed: [{ grossStopRisk: '267.5', lots: '5.35' }],
      proposed: { grossStopRisk: '153.95', lots: '4.9' },
    }).allowed).toBe(false);
  });
  it('allows two sufficiently sized small trades rather than a blanket no-trade rule', () => {
    expect(check({ ...common,
      committed: [{ grossStopRisk: '60', lots: '1' }],
      proposed: { grossStopRisk: '60', lots: '1' },
    }).allowed).toBe(true);
  });
  it.each(['0', '-1', '1.01'])('does not accept invalid risk percent %s', value => {
    expect(() => check({ ...common, maxPercent: value, committed: [], proposed: { grossStopRisk: '50', lots: '1' } })).toThrow();
  });
  it('does not fake gross risk evidence or broker commission history', () => {
    expect(() => check({ ...common, committed: [{ grossStopRisk: '0', lots: '1' }], proposed: { grossStopRisk: '50', lots: '1' } })).toThrow();
    expect(() => check({ ...common, observedCommissionPerLot: '-1', committed: [], proposed: { grossStopRisk: '50', lots: '1' } })).toThrow();
  });
  it('uses smaller broker equity rather than overstated capital', () => {
    const v=check({ ...common, brokerEquity: '5000', committed: [], proposed: { grossStopRisk: '44', lots: '1' }});
    expect(v.allowed).toBe(false);
  });
});
