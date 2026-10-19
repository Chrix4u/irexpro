import type { OHLCV } from '../broker/interfaces/broker-adapter.interface';
import { evaluateM1DriftCounterfactual15m } from './m1-drift-counterfactual';

function bar(openTime: string, open: number, high: number, low: number, close: number): OHLCV {
  return {
    timestamp: new Date(openTime),
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: '0',
    tickVolume: '0',
  } as OHLCV;
}

function flatWindow(start = '2026-10-19T10:56:00.000Z'): OHLCV[] {
  const startMs = new Date(start).getTime();
  return Array.from({ length: 15 }, (_, index) =>
    bar(new Date(startMs + index * 60_000).toISOString(), 1.1, 1.1002, 1.0998, 1.1),
  );
}

describe('evaluateM1DriftCounterfactual15m', () => {
  it('uses the first causal bar open and settles TP from completed contiguous M1 bars', () => {
    const bars = flatWindow();
    bars[3] = bar('2026-10-19T10:59:00.000Z', 1.1001, 1.1009, 1.1, 1.1008);

    const result = evaluateM1DriftCounterfactual15m({
      direction: 'BUY',
      evaluatedAt: new Date('2026-10-19T10:55:00.000Z'),
      stopDistance: 0.0005,
      targetDistance: 0.0008,
      executionCostR: 0.0625,
      bars,
    });

    expect(result).toMatchObject({
      artifact: 'm1-drift-counterfactual-15m-v1',
      modifiesExecution: false,
      source: 'COMPLETED_M1_OHLC',
      outcome: 'TP',
      entryBarOpenTime: '2026-10-19T10:56:00.000Z',
      entryPrice: 1.1,
      estimatedExecutionCostR: 0.0625,
      grossRMultiple: 1.6,
      netRMultiple: 1.5375,
    });
    expect(result?.stopLoss).toBeCloseTo(1.0995, 10);
    expect(result?.takeProfit).toBeCloseTo(1.1008, 10);
  });

  it('fails closed when the full 15-bar causal window is not contiguous', () => {
    const bars = flatWindow().filter((_, index) => index !== 7);
    expect(
      evaluateM1DriftCounterfactual15m({
        direction: 'SELL',
        evaluatedAt: new Date('2026-10-19T10:55:00.000Z'),
        stopDistance: 0.0005,
        targetDistance: 0.0008,
        executionCostR: 0.0625,
        bars,
      }),
    ).toBeNull();
  });

  it('records same-bar stop/target contact as ambiguous instead of inventing fill order', () => {
    const bars = flatWindow();
    bars[0] = bar('2026-10-19T10:56:00.000Z', 1.1, 1.101, 1.099, 1.1002);
    const result = evaluateM1DriftCounterfactual15m({
      direction: 'BUY',
      evaluatedAt: new Date('2026-10-19T10:55:00.000Z'),
      stopDistance: 0.0005,
      targetDistance: 0.0008,
      executionCostR: 0.0625,
      bars,
    });
    expect(result).toMatchObject({
      outcome: 'AMBIGUOUS',
      grossRMultiple: null,
      netRMultiple: null,
    });
  });
});
