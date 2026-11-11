import {
  evaluateM1TacticalCurrencyExposure,
  findLargestClearM1Volume,
  capM1DemoRequestedVolumeByRisk,
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

  it('steps below the preferred 0.20 professional floor when a smaller lot stays under the hard aligned-currency cap', () => {
    const result = findLargestClearM1Volume({
      allocatedCapital: 836.75,
      positions: [],
      candidate: {
        instrument: 'EURUSD',
        direction: 'SELL',
        entryPrice: 1.1,
        stopLoss: 1.1015,
      },
      requestedVolumeCap: 0.2,
      productFloor: 0.2,
      volumeStep: 0.01,
    });

    expect(result.allowed).toBe(true);
    expect(result.volumeCap).toBeCloseTo(0.16, 8);
    expect(result.volumeCap).toBeLessThan(0.2);
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

  it('reduces a 4-lot EURUSD entry with 0.50% stop risk to 2 lots at a 0.25% DEMO cap', () => {
    const decision = capM1DemoRequestedVolumeByRisk({
      allocatedCapital: 40000,
      instrument: 'EURUSD',
      entryPrice: 1.11535,
      stopLoss: 1.11585,
      requestedVolumeCap: 4,
    });
    expect(decision).toMatchObject({ volumeCap: 2 });
    expect(decision.requestedRiskAtStop).toBeCloseTo(200, 2);
    expect(decision.permittedRiskAtStop).toBeCloseTo(100, 2);
  });

  it('reduces a 4-lot USDCHF entry with $241 initial risk below $100 without up-sizing', () => {
    const decision = capM1DemoRequestedVolumeByRisk({
      allocatedCapital: 40000,
      instrument: 'USDCHF',
      entryPrice: 0.82852,
      stopLoss: 0.82802,
      requestedVolumeCap: 4,
    });
    expect(decision.volumeCap).toBeLessThan(2);
    expect(decision.volumeCap).toBeGreaterThan(1);
    expect(decision.permittedRiskAtStop).toBeLessThanOrEqual(100.001);
  });

  it('leaves a valid 0.20-lot scout unchanged rather than forcing a larger order', () => {
    expect(
      capM1DemoRequestedVolumeByRisk({
        allocatedCapital: 40000,
        instrument: 'USDJPY',
        entryPrice: 158.922,
        stopLoss: 158.872,
        requestedVolumeCap: 0.2,
      }).volumeCap,
    ).toBe(0.2);
  });

  it('applies a 1% shared-USD target only when explicitly configured and preserves opposed positions', () => {
    const args = {
      allocatedCapital: 40000,
      positions: [{ instrument: 'GBPUSD', direction: 'SELL' as const, riskAtStop: 310 }],
      candidate: {
        instrument: 'EURUSD',
        direction: 'SELL' as const,
        entryPrice: 1.12,
        stopLoss: 1.1205,
      },
      requestedVolumeCap: 2,
      productFloor: 0.001,
      volumeStep: 0.001,
    };
    const normal = findLargestClearM1Volume(args);
    const pilot = findLargestClearM1Volume({
      ...args,
      alignedReducePercent: 1,
      alignedBlockPercent: 1.25,
    });
    expect(normal.volumeCap).toBe(2);
    expect(pilot.allowed).toBe(true);
    expect(pilot.volumeCap).toBeGreaterThan(0);
    expect(pilot.volumeCap).toBeLessThan(2);
    expect(pilot.decision.projectedAlignedRiskPercent).toBeLessThanOrEqual(1.001);
    const opposite = findLargestClearM1Volume({
      ...args,
      candidate: { ...args.candidate, direction: 'BUY' as const },
      alignedReducePercent: 1,
      alignedBlockPercent: 1.25,
    });
    expect(opposite.allowed).toBe(true);
    expect(opposite.volumeCap).toBe(2);
  });

  it('rejects invalid negative risk or allocation rather than guessing a 0.001 lot', () => {
    expect(
      capM1DemoRequestedVolumeByRisk({
        allocatedCapital: 0,
        instrument: 'EURUSD',
        entryPrice: 1.1,
        stopLoss: 1.101,
        requestedVolumeCap: 4,
      }).volumeCap,
    ).toBe(0);
    expect(
      capM1DemoRequestedVolumeByRisk({
        allocatedCapital: 40000,
        instrument: 'EURUSD',
        entryPrice: 0,
        stopLoss: 1.101,
        requestedVolumeCap: 4,
      }).volumeCap,
    ).toBe(0);
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
