import {
  evaluateM1TacticalCurrencyExposure,
  findLargestClearM1Volume,
  m1UsdRiskAtStop,
} from './m1-tactical-currency-exposure';

describe('M1 tactical currency exposure', () => {
  it('computes USD stop risk for USD-quote pairs', () => {
    expect(
      m1UsdRiskAtStop({
        instrument: 'EURUSD',
        lotSize: 0.1,
        entryPrice: 1.12221,
        stopLoss: 1.12271,
      }),
    ).toBeCloseTo(5, 6);
  });

  it('converts quote-currency stop risk to USD for USD-base pairs', () => {
    expect(
      m1UsdRiskAtStop({ instrument: 'USDJPY', lotSize: 0.1, entryPrice: 157, stopLoss: 156.95 }),
    ).toBeCloseTo(3.184713, 5);
  });

  const candidate = { instrument: 'EURUSD', direction: 'SELL' as const, riskAtStop: 5 };

  it('keeps diversified/aligned exposure clear below two percent of allocated capital', () => {
    expect(
      evaluateM1TacticalCurrencyExposure({
        allocatedCapital: 1000,
        positions: [{ instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 5 }],
        candidate,
      }),
    ).toMatchObject({ capacity: 'CLEAR', projectedAlignedRiskPercent: 1 });
  });

  it('reduces new size at two percent aligned currency stop risk', () => {
    expect(
      evaluateM1TacticalCurrencyExposure({
        allocatedCapital: 1000,
        positions: [{ instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 15 }],
        candidate,
      }),
    ).toMatchObject({ capacity: 'REDUCED', projectedAlignedRiskPercent: 2 });
  });

  it('blocks additional aligned exposure at three percent', () => {
    expect(
      evaluateM1TacticalCurrencyExposure({
        allocatedCapital: 1000,
        positions: [{ instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 25 }],
        candidate,
      }),
    ).toMatchObject({ capacity: 'BLOCKED', projectedAlignedRiskPercent: 3 });
  });

  it('allows an opposite candidate to de-concentrate exposure below the block threshold', () => {
    expect(
      evaluateM1TacticalCurrencyExposure({
        allocatedCapital: 1000,
        positions: [{ instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 30 }],
        candidate: { instrument: 'EURUSD', direction: 'BUY', riskAtStop: 5 },
      }),
    ).toMatchObject({ capacity: 'REDUCED', projectedAlignedRiskPercent: 2.5 });
  });

  it('finds the largest clear intermediate lot instead of collapsing a blocked professional cap to the 0.20 floor', () => {
    const result = findLargestClearM1Volume({
      allocatedCapital: 900,
      positions: [],
      candidate: {
        instrument: 'EURUSD',
        direction: 'BUY',
        entryPrice: 1.1123,
        stopLoss: 1.1118,
      },
      requestedVolumeCap: 4,
      productFloor: 0.2,
      volumeStep: 0.01,
    });

    expect(result.allowed).toBe(true);
    expect(result.volumeCap).toBeCloseTo(0.35, 8);
    expect(result.volumeCap).toBeGreaterThan(0.2);
    expect(result.decision.capacity).toBe('CLEAR');
    expect(result.productFloorBlocked).toBe(false);
  });

  it('allows the preferred 0.20 floor to hand off to downstream risk sizing when it is reduced but still below the hard block threshold', () => {
    const result = findLargestClearM1Volume({
      allocatedCapital: 900,
      positions: [],
      candidate: {
        instrument: 'EURUSD',
        direction: 'SELL',
        entryPrice: 1.1123,
        stopLoss: 1.1113,
      },
      requestedVolumeCap: 4,
      productFloor: 0.2,
      volumeStep: 0.01,
    });

    expect(result.allowed).toBe(true);
    expect(result.volumeCap).toBe(0.2);
    expect(result.decision.capacity).toBe('REDUCED');
    expect(result.productFloorBlocked).toBe(false);
  });

  it('still fails closed when even the product floor breaches aligned-currency capacity', () => {
    const result = findLargestClearM1Volume({
      allocatedCapital: 900,
      positions: [{ instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 30 }],
      candidate: {
        instrument: 'EURUSD',
        direction: 'SELL',
        entryPrice: 1.1123,
        stopLoss: 1.1118,
      },
      requestedVolumeCap: 4,
      productFloor: 0.2,
      volumeStep: 0.01,
    });

    expect(result.allowed).toBe(false);
    expect(result.volumeCap).toBe(0);
    expect(result.productFloorBlocked).toBe(true);
  });

  it('fails closed when allocation or risk evidence is unusable', () => {
    expect(
      evaluateM1TacticalCurrencyExposure({ allocatedCapital: 0, positions: [], candidate }),
    ).toMatchObject({ capacity: 'BLOCKED', reason: 'ALLOCATION_UNAVAILABLE' });
    expect(
      evaluateM1TacticalCurrencyExposure({
        allocatedCapital: 1000,
        positions: [{ instrument: 'GBPUSD', direction: 'SELL', riskAtStop: null }],
        candidate,
      }),
    ).toMatchObject({ capacity: 'BLOCKED', reason: 'RISK_EVIDENCE_INCOMPLETE' });
  });
});
