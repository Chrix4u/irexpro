import type { DataSource } from 'typeorm';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

const EVALUATED_AT = new Date('2026-10-18T21:30:15.000Z');

describe('ProviderQuoteCandleStoreService cTrader history', () => {
  it('stores historical H4 bars without fabricating bid/ask/spread evidence', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);

    await service.upsertHistoricalCandles(
      'ctrader-1',
      'EURUSD',
      'H4',
      [
        {
          timestamp: new Date('2026-10-18T12:00:00.000Z'),
          open: '1.10000',
          high: '1.10500',
          low: '1.09500',
          close: '1.10200',
          volume: '120',
        },
      ],
      'ctrader-broker-native',
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('NULL, NULL, NULL');
    expect(params[0]).toBe('ctrader-1');
    expect(params[1]).toBe('EURUSD');
    expect(params[2]).toBe('H4');
    expect(params[3]).toBe(240);
    expect(params[4]).toBe('ctrader-broker-native');
    const payload = JSON.parse(params[5]);
    expect(payload).toEqual([expect.objectContaining({ sample_count: 120 })]);
  });

  it('counts actual positive live quote observations without confusing them with historical candle volume', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);

    await service.upsertM1Sample(
      'ctrader-1',
      'EURUSD',
      {
        instrument: 'EURUSD',
        bid: '1.10000',
        ask: '1.10008',
        spread: '0.00008',
        timestamp: EVALUATED_AT,
      },
      'ctrader-broker-native',
    );

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('positive_quote_sample_count');
    expect(sql).toContain('last_quote_sample_at');
    expect(sql).toContain('positive_quote_sample_count +');
    // Same cached provider tick may be read by both collector loops. It must
    // contribute at most one positive observation.
    expect(sql).toContain('EXCLUDED.last_quote_sample_at >');
    expect(sql).toContain('COALESCE(market_data.provider_quote_candles.last_quote_sample_at');
  });

  it('aggregates positive live observation counts and uses quote timestamps for readiness', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bid_close: '1.10000',
        ask_close: '1.10008',
        spread_close: '0.00008',
        last_sample_at: EVALUATED_AT.toISOString(),
        positive_sample_count: 10,
        p90_spread: 0.00009,
        latest_positive_sample_at: EVALUATED_AT.toISOString(),
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);

    await service.getLatestPositiveSpreadQuote('ctrader-1', 'EURUSD', EVALUATED_AT);

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('SUM(p.positive_quote_sample_count)');
    expect(sql).toContain('last_quote_sample_at');
    expect(sql).not.toContain('COUNT(p.*)');
  });

  it('includes positive intraminute observations even if the last broker quote has zero spread', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bid_close: '1.10000',
        ask_close: '1.10000',
        spread_close: '0.00000',
        last_sample_at: EVALUATED_AT.toISOString(),
        positive_sample_count: 80,
        p50_spread: 0.00001,
        p75_spread: 0.00002,
        p90_spread: 0.00002,
        latest_positive_sample_at: '2026-10-18T21:30:00.000Z',
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);
    const quote = await service.getLatestPositiveSpreadQuote('ctrader-1', 'EURUSD', EVALUATED_AT);
    const sql = String(query.mock.calls[0]![0]);
    // A zero final spread is not proof that earlier live quotes in that
    // minute lacked positive spreads; the authoritative counter records them.
    expect(sql).toContain('AND positive_quote_sample_count > 0');
    expect(sql).not.toContain('AND spread_close > 0');
    // Zero final-minute spreads must not contaminate the positive-only P90.
    expect(sql).toContain('CASE WHEN p.spread_close > 0');
    // An exact last-positive tick time is unavailable: use a conservative
    // minute-open lower bound, never the potentially later final quote time.
    expect(sql).toContain("date_trunc('minute', p.last_quote_sample_at)");
    expect(quote).toMatchObject({
      positiveSampleCount: 80,
      spread: '0.0000200000',
      latestPositiveSampleAt: new Date('2026-10-18T21:30:00.000Z'),
    });
  });

  it('fails closed when zero-spread quote minutes have no positive spread price evidence', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bid_close: '1.10000',
        ask_close: '1.10000',
        spread_close: '0.00000',
        last_sample_at: EVALUATED_AT.toISOString(),
        positive_sample_count: 80,
        p50_spread: null,
        p75_spread: null,
        p90_spread: null,
        latest_positive_sample_at: '2026-10-18T21:30:00.000Z',
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);
    expect(
      await service.getLatestPositiveSpreadQuote('ctrader-1', 'EURUSD', EVALUATED_AT),
    ).toBeNull();
  });

  it('requires a live bid/ask row for the latest positive-spread quote', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bid_close: '1.10000',
        ask_close: '1.10008',
        spread_close: '0.00008',
        last_sample_at: '2026-10-18T21:30:10.000Z',
        positive_sample_count: 10,
        p90_spread: 0.00009,
        latest_positive_sample_at: '2026-10-18T21:30:10.000Z',
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);

    const quote = await service.getLatestPositiveSpreadQuote('ctrader-1', 'EURUSD', EVALUATED_AT);

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('bid_close IS NOT NULL');
    expect(sql).toContain('ask_close IS NOT NULL');
    expect(sql).toContain('spread_close IS NOT NULL');
    expect(quote).toMatchObject({
      instrument: 'EURUSD',
      positiveSampleCount: 10,
      spread: '0.0000900000',
    });
  });

  it('reads the actual quote timestamp rather than a candle history refresh timestamp', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bid_close: '1.10000',
        ask_close: '1.10008',
        spread_close: '0.00008',
        last_sample_at: EVALUATED_AT.toISOString(),
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);
    await service.getLatestQuote('ctrader-1', 'EURUSD');
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('last_quote_sample_at AS last_sample_at');
    expect(sql).toContain('ORDER BY last_quote_sample_at DESC');
  });

  it('uses directly stored broker-native H1/H4 context when available', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const h4 = [
      {
        timestamp: new Date('2026-10-18T16:00:00.000Z'),
        open: '1.1000',
        high: '1.1050',
        low: '1.0950',
        close: '1.1020',
        volume: '50',
        tickVolume: '50',
        source: 'ctrader-broker-native',
        sampleCount: 50,
        spreadClose: null,
        firstSampleAt: new Date('2026-10-18T16:00:00.000Z'),
        lastSampleAt: new Date('2026-10-18T19:59:59.000Z'),
      },
    ];
    const direct = jest.spyOn(service, 'getStoredCandles').mockResolvedValue(h4);
    const m1 = jest.spyOn(service, 'getM1Candles').mockResolvedValue([]);

    await expect(
      service.getCandles('ctrader-1', 'EURUSD', 'H4', 30, EVALUATED_AT),
    ).resolves.toEqual(h4);

    expect(direct).toHaveBeenCalledWith('ctrader-1', 'EURUSD', 'H4', 30, EVALUATED_AT);
    expect(m1).not.toHaveBeenCalled();
  });

  function brokerM1(openTime: string, source = 'ctrader-broker-native') {
    const timestamp = new Date(openTime);
    return {
      timestamp,
      open: '1.10000',
      high: '1.10020',
      low: '1.09980',
      close: '1.10010',
      volume: '20',
      tickVolume: '20',
      source,
      sampleCount: 20,
      spreadClose: null,
      firstSampleAt: new Date(timestamp),
      lastSampleAt: new Date(timestamp.getTime() + 59_000),
    };
  }

  function nativeContext(openTime: string) {
    const timestamp = new Date(openTime);
    return {
      timestamp,
      open: '1.09950',
      high: '1.10000',
      low: '1.09900',
      close: '1.09980',
      volume: '100',
      tickVolume: '100',
      source: 'ctrader-broker-native',
      sampleCount: 100,
      spreadClose: null,
      firstSampleAt: timestamp,
      lastSampleAt: new Date(timestamp.getTime() + 5 * 60_000 - 1000),
    };
  }

  it('recovers a delayed native M5 close only from complete confirmed cTrader M1 history', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const original = nativeContext('2026-11-09T00:35:00.000Z');
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([original]);
    const m1 = jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => brokerM1(`2026-11-09T00:${40 + i}:00.000Z`)),
      );
    const evaluatedAt = new Date('2026-11-09T00:51:00.000Z');

    const recovered = await service.getCandles('ctrader-1', 'USDJPY', 'M5', 30, evaluatedAt);
    expect(m1).toHaveBeenCalled();
    expect(recovered).toHaveLength(2);
    expect(recovered[0]).toBe(original);
    expect(recovered[1]).toMatchObject({
      timestamp: new Date('2026-11-09T00:40:00.000Z'),
      open: '1.10000',
      high: '1.1002000000',
      low: '1.0998000000',
      close: '1.10010',
    });
  });

  it('does not construct missing native M5 history from a gap or quote-only M1 data', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const original = nativeContext('2026-11-09T00:35:00.000Z');
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([original]);
    const m1 = jest.spyOn(service, 'getM1Candles');
    const time = new Date('2026-11-09T00:51:00.000Z');
    const complete = Array.from({ length: 5 }, (_, i) =>
      brokerM1(`2026-11-09T00:${40 + i}:00.000Z`),
    );

    m1.mockResolvedValue(complete.filter((_, i) => i !== 2));
    await expect(service.getCandles('ctrader-1', 'USDJPY', 'M5', 30, time)).resolves.toEqual([
      original,
    ]);

    m1.mockResolvedValue(
      complete.map((row, i) => (i === 2 ? { ...row, source: 'metaapi-rpc-sampled' } : row)),
    );
    await expect(service.getCandles('ctrader-1', 'USDJPY', 'M5', 30, time)).resolves.toEqual([
      original,
    ]);

    m1.mockResolvedValue(
      complete.map((row, i) =>
        i === 2 ? { ...row, lastSampleAt: new Date(row.timestamp.getTime() + 12_000) } : row,
      ),
    );
    await expect(service.getCandles('ctrader-1', 'USDJPY', 'M5', 30, time)).resolves.toEqual([
      original,
    ]);
  });

  it('does not leap over missing native five-minute buckets to a later recovered bar', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const original = nativeContext('2026-11-09T00:25:00.000Z');
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([original]);
    jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => brokerM1(`2026-11-09T00:${40 + i}:00.000Z`)),
      );
    await expect(
      service.getCandles('ctrader-1', 'USDJPY', 'M5', 30, new Date('2026-11-09T00:51:00.000Z')),
    ).resolves.toEqual([original]);
  });

  it('does not expose a still-forming M5 candle when direct context is stale', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const original = nativeContext('2026-11-09T00:25:00.000Z');
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([original]);
    jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => brokerM1(`2026-11-09T00:${40 + i}:00.000Z`)),
      );
    await expect(
      service.getCandles('ctrader-1', 'USDJPY', 'M5', 30, new Date('2026-11-09T00:43:00.000Z')),
    ).resolves.toEqual([original]);
  });

  it('keeps fresh directly stored M5 bars without requesting redundant M1 history', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const original = nativeContext('2026-11-09T00:40:00.000Z');
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([original]);
    const m1 = jest.spyOn(service, 'getM1Candles');
    await expect(
      service.getCandles('ctrader-1', 'USDJPY', 'M5', 30, new Date('2026-11-09T00:48:00.000Z')),
    ).resolves.toEqual([original]);
    expect(m1).not.toHaveBeenCalled();
  });

  it('applies the same fully completed M1 provenance rules to delayed M15', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const original = nativeContext('2026-11-09T00:00:00.000Z');
    jest.spyOn(service, 'getStoredCandles').mockResolvedValue([original]);
    jest
      .spyOn(service, 'getM1Candles')
      .mockResolvedValue(
        Array.from({ length: 15 }, (_, i) =>
          brokerM1(`2026-11-09T00:${String(15 + i).padStart(2, '0')}:00.000Z`),
        ),
      );
    const result = await service.getCandles(
      'ctrader-1',
      'USDJPY',
      'M15',
      30,
      new Date('2026-11-09T00:50:00.000Z'),
    );
    expect(result).toHaveLength(2);
    expect(result[1]!.timestamp).toEqual(new Date('2026-11-09T00:15:00.000Z'));
  });
});
