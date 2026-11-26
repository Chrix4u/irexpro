/**
 * Market-data availability characterization for the November 25, 2026
 * LIVE blockage investigation (broker-disconnected, mocked store reads).
 *
 * When direct native M5/M15 history lags more than one full timeframe, the
 * store attempts to extend it from complete M1 buckets. The extension
 * predicate demands full-minute first/last sample provenance
 * (firstSampleAt <= barOpen && lastSampleAt >= barOpen + 59s). A LIVE
 * tick-sampled minute can never satisfy `firstSampleAt <= barOpen` because
 * its first tick arrives strictly AFTER the bucket opens, so a lagging
 * native M5/M15 feed can never be repaired from live samples and the pair
 * fails closed (BROKER_M5_CONTEXT_STALE / BROKER_M15_CONTEXT_STALE).
 *
 * This is deliberate fail-closed evidence protection, NOT corruption: no
 * unverified midpoint tick may patch broker-native history. The tests pin
 * the boundary so any future availability change is a conscious decision.
 */
import type { DataSource } from 'typeorm';
import {
  ProviderQuoteCandleStoreService,
  type ProviderQuoteCandle,
} from './provider-quote-candle-store.service';

const EVALUATED_AT = new Date('2026-11-25T15:07:03.000Z');

function storedRow(
  openTime: string,
  close: string,
  source: string,
  firstOffsetMs: number,
  lastOffsetMs: number,
) {
  const open = new Date(openTime);
  return {
    timestamp: open,
    open: '1.08000',
    high: '1.08020',
    low: '1.07980',
    close,
    volume: '3',
    tickVolume: '3',
    source,
    sampleCount: 3,
    spreadClose: '0.00008',
    firstSampleAt: new Date(open.getTime() + firstOffsetMs),
    lastSampleAt: new Date(open.getTime() + lastOffsetMs),
  } as ProviderQuoteCandle;
}

/** Native historical M1 bars carry exact bucket-boundary provenance. */
function nativeM1(openTime: string): ProviderQuoteCandle {
  const open = new Date(openTime);
  return {
    timestamp: open,
    open: '1.08000',
    high: '1.08020',
    low: '1.07980',
    close: '1.08010',
    volume: '3',
    tickVolume: '3',
    source: 'ctrader-broker-native',
    sampleCount: 3,
    spreadClose: '0.00008',
    firstSampleAt: open,
    lastSampleAt: new Date(open.getTime() + 59_000),
  };
}

/** LIVE tick-sampled M1 bars start strictly after the bucket opens. */
function liveSampledM1(openTime: string): ProviderQuoteCandle {
  const open = new Date(openTime);
  return {
    timestamp: open,
    open: '1.08000',
    high: '1.08020',
    low: '1.07980',
    close: '1.08010',
    volume: '3',
    tickVolume: '3',
    source: 'ctrader-broker-native',
    sampleCount: 3,
    spreadClose: '0.00008',
    firstSampleAt: new Date(open.getTime() + 1_200),
    lastSampleAt: new Date(open.getTime() + 58_400),
  };
}

describe('ProviderQuoteCandleStoreService lagging native M5 context', () => {
  it('recovers a lagging native M5 close from full-minute-provenance historical M1 bars', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    // Native M5 history ends one bucket behind: its close is stale.
    const staleNativeM5 = storedRow(
      '2026-11-25T14:55:00.000Z',
      '1.08010',
      'ctrader-broker-native',
      0,
      299_000,
    );
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([staleNativeM5]);
    const m1 = jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => nativeM1(`2026-11-25T15:0${i}:00.000Z`)),
      );

    const recovered = await service.getCandles('ctrader-1', 'EURUSD', 'M5', 30, EVALUATED_AT);
    expect(m1).toHaveBeenCalled();
    expect(recovered).toHaveLength(2);
    expect(recovered[1]).toMatchObject({
      timestamp: new Date('2026-11-25T15:00:00.000Z'),
      close: '1.08010',
    });
  });

  it('never recovers the lagging close from live tick-sampled M1 minutes (fail-closed availability gap)', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const staleNativeM5 = storedRow(
      '2026-11-25T14:55:00.000Z',
      '1.08010',
      'ctrader-broker-native',
      0,
      299_000,
    );
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([staleNativeM5]);
    // Complete live-sampled M1 minutes for the missing 15:00–15:05 bucket:
    // every condition else identical except firstSampleAt > barOpen.
    jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => liveSampledM1(`2026-11-25T15:0${i}:00.000Z`)),
      );

    const recovered = await service.getCandles('ctrader-1', 'EURUSD', 'M5', 30, EVALUATED_AT);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.timestamp.toISOString()).toBe('2026-11-25T14:55:00.000Z');
  });

  it('does not leap across an unobserved bucket even with full-minute live provenance', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const staleNativeM5 = storedRow(
      '2026-11-25T14:50:00.000Z',
      '1.08010',
      'ctrader-broker-native',
      0,
      299_000,
    );
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([staleNativeM5]);
    // Only 15:04 and 15:05 minutes exist; 15:00–15:03 are missing entirely,
    // so the newest complete contiguous bucket cannot reach 15:05.
    jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue([
        liveSampledM1('2026-11-25T15:04:00.000Z'),
        liveSampledM1('2026-11-25T15:05:00.000Z'),
      ]);

    const recovered = await service.getCandles('ctrader-1', 'EURUSD', 'M5', 30, EVALUATED_AT);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.timestamp.toISOString()).toBe('2026-11-25T14:50:00.000Z');
  });
});
