import type { OHLCV } from '../broker/interfaces/broker-adapter.interface';
import { evaluateM1CausalOutcome15m } from './m1-causal-outcome';

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

function causalWindow(start = '2026-10-21T10:01:00.000Z', price = 1.1): OHLCV[] {
  const startMs = new Date(start).getTime();
  return Array.from({ length: 15 }, (_, index) =>
    bar(
      new Date(startMs + index * 60_000).toISOString(),
      price,
      price + 0.0001,
      price - 0.0001,
      price,
    ),
  );
}

const evaluatedAt = new Date('2026-10-21T10:00:00.000Z');

function evaluate(direction: 'BUY' | 'SELL', bars: OHLCV[]) {
  return evaluateM1CausalOutcome15m({
    direction,
    evaluatedAt,
    stopDistance: 0.0005,
    targetDistance: 0.0008,
    executionCostR: 0.0625,
    bars,
  });
}

describe('evaluateM1CausalOutcome15m', () => {
  it('settles a BUY target before the stop and uses the first causal bar open as entry', () => {
    const bars = causalWindow();
    bars[3] = bar('2026-10-21T10:04:00.000Z', 1.1001, 1.1009, 1.1, 1.1008);

    const result = evaluate('BUY', bars);

    expect(result).toMatchObject({
      source: 'COMPLETED_M1_OHLC',
      outcome: 'TP',
      entryBarOpenTime: '2026-10-21T10:01:00.000Z',
      entryPrice: 1.1,
      estimatedExecutionCostR: 0.0625,
      grossRMultiple: 1.6,
      netRMultiple: 1.5375,
    });
    expect(result?.stopLoss).toBeCloseTo(1.0995, 10);
    expect(result?.takeProfit).toBeCloseTo(1.1008, 10);
  });

  it('settles a SELL target before the stop', () => {
    const bars = causalWindow();
    bars[4] = bar('2026-10-21T10:05:00.000Z', 1.1, 1.1001, 1.0991, 1.0992);

    const result = evaluate('SELL', bars);

    expect(result).toMatchObject({ outcome: 'TP', grossRMultiple: 1.6, netRMultiple: 1.5375 });
    expect(result?.stopLoss).toBeCloseTo(1.1005, 10);
    expect(result?.takeProfit).toBeCloseTo(1.0992, 10);
  });

  it.each([
    ['BUY' as const, bar('2026-10-21T10:03:00.000Z', 1.1, 1.1001, 1.0994, 1.0996)],
    ['SELL' as const, bar('2026-10-21T10:03:00.000Z', 1.1, 1.1006, 1.0999, 1.1004)],
  ])('settles %s stop loss before target', (direction, stopBar) => {
    const bars = causalWindow();
    bars[2] = stopBar;
    const result = evaluate(direction, bars);
    expect(result).toMatchObject({ outcome: 'SL', grossRMultiple: -1, netRMultiple: -1.0625 });
  });

  it('marks to market at the fifteenth close when neither boundary is touched', () => {
    const bars = causalWindow();
    bars[14] = bar('2026-10-21T10:15:00.000Z', 1.1, 1.1002, 1.0998, 1.10025);

    const result = evaluate('BUY', bars);

    expect(result?.outcome).toBe('MTM');
    expect(result?.terminalBarOpenTime).toBe('2026-10-21T10:15:00.000Z');
    expect(result?.grossRMultiple).toBeCloseTo(0.5, 10);
    expect(result?.netRMultiple).toBeCloseTo(0.4375, 10);
  });

  it('marks same-bar stop and target contact as ambiguous with no invented R result', () => {
    const bars = causalWindow();
    bars[0] = bar('2026-10-21T10:01:00.000Z', 1.1, 1.101, 1.099, 1.1002);

    expect(evaluate('BUY', bars)).toMatchObject({
      outcome: 'AMBIGUOUS',
      grossRMultiple: null,
      netRMultiple: null,
    });
  });

  it('fails closed when the full causal window is missing or non-contiguous', () => {
    expect(evaluate('BUY', causalWindow().slice(0, 14))).toBeNull();
    expect(
      evaluate(
        'BUY',
        causalWindow().filter((_, index) => index !== 7),
      ),
    ).toBeNull();
  });

  it('fails closed on non-positive or invalid OHLC prices', () => {
    const zeroOpen = causalWindow();
    zeroOpen[0] = bar('2026-10-21T10:01:00.000Z', 0, 1.1001, 1.0999, 1.1);
    expect(evaluate('BUY', zeroOpen)).toBeNull();

    const invalidClose = causalWindow();
    invalidClose[14] = {
      ...invalidClose[14]!,
      close: 'not-a-price',
    } as OHLCV;
    expect(evaluate('BUY', invalidClose)).toBeNull();
  });
});
