import type { DataSource } from 'typeorm';
import {
  ProviderQuoteCandleStoreService,
  type ProviderQuoteCandle,
} from './provider-quote-candle-store.service';

const DECISION_TIME = new Date('2026-10-18T10:30:15.000Z');

function candle(openTime: string, close = 1.1): ProviderQuoteCandle {
  const timestamp = new Date(openTime);
  return {
    timestamp,
    open: (close - 0.0001).toFixed(5),
    high: (close + 0.0002).toFixed(5),
    low: (close - 0.0002).toFixed(5),
    close: close.toFixed(5),
    volume: '2',
    tickVolume: '2',
    source: 'metaapi-rpc-sampled',
    sampleCount: 2,
    spreadClose: '0.00004',
    firstSampleAt: new Date(timestamp.getTime() + 5_000),
    lastSampleAt: new Date(timestamp.getTime() + 55_000),
  };
}

describe('ProviderQuoteCandleStoreService completed-bar reads', () => {
  it('binds M1 reads to the supplied decision time rather than wall-clock now', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bucket_time: '2026-10-18T10:29:00.000Z',
        open: '1.1000',
        high: '1.1002',
        low: '1.0999',
        close: '1.1001',
        sample_count: 4,
        spread_close: '0.00004',
        source: 'metaapi-rpc-sampled',
        first_sample_at: '2026-10-18T10:29:05.000Z',
        last_sample_at: '2026-10-18T10:29:55.000Z',
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);

    const result = await (service.getM1Candles as any)('conn-1', 'EURUSD', 30, DECISION_TIME);

    expect(result).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain(
      "bucket_time + ($6::int * interval '1 minute') <= $5::timestamptz",
    );
    expect(params).toEqual(['conn-1', 'EURUSD', 'M1', 30, DECISION_TIME.toISOString(), 1]);
  });

  it('exposes causal source/sample metadata with each completed M1 candle', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bucket_time: '2026-10-18T10:29:00.000Z',
        open: '1.1000',
        high: '1.1002',
        low: '1.0999',
        close: '1.1001',
        sample_count: 4,
        spread_close: '0.00004',
        source: 'metaapi-rpc-sampled',
        first_sample_at: '2026-10-18T10:29:05.000Z',
        last_sample_at: '2026-10-18T10:29:55.000Z',
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);

    const [row] = (await (service.getM1Candles as any)(
      'conn-1',
      'EURUSD',
      30,
      DECISION_TIME,
    )) as Array<Record<string, unknown>>;

    expect(row).toMatchObject({
      source: 'metaapi-rpc-sampled',
      sampleCount: 4,
      spreadClose: '0.00004',
    });
    expect((row.firstSampleAt as Date).toISOString()).toBe('2026-10-18T10:29:05.000Z');
    expect((row.lastSampleAt as Date).toISOString()).toBe('2026-10-18T10:29:55.000Z');
  });

  it('does not aggregate a completed higher-timeframe bar across a hidden M1 timestamp gap', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue([
        candle('2026-10-18T10:00:00.000Z', 1.1),
        candle('2026-10-18T10:01:00.000Z', 1.1001),
        candle('2026-10-18T10:03:00.000Z', 1.1002),
        candle('2026-10-18T10:04:00.000Z', 1.1003),
        candle('2026-10-18T10:04:00.000Z', 1.1004),
      ]);

    const result = await (service.getCandles as any)(
      'conn-1',
      'EURUSD',
      'M5',
      1,
      new Date('2026-10-18T10:05:00.000Z'),
    );

    expect(result).toEqual([]);
  });

  it('does not expose the currently forming aggregate bucket', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue([
        candle('2026-10-18T10:30:00.000Z', 1.1),
        candle('2026-10-18T10:31:00.000Z', 1.1001),
        candle('2026-10-18T10:32:00.000Z', 1.1002),
        candle('2026-10-18T10:33:00.000Z', 1.1003),
        candle('2026-10-18T10:34:00.000Z', 1.1004),
      ]);

    const result = await (service.getCandles as any)(
      'conn-1',
      'EURUSD',
      'M5',
      1,
      new Date('2026-10-18T10:34:30.000Z'),
    );

    expect(result).toEqual([]);
  });
});
