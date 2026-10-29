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
    const encodedRows = JSON.parse(String(params[5]));
    expect(encodedRows).toHaveLength(1);
    expect(encodedRows[0]).toMatchObject({ sample_count: 120 });
    expect(encodedRows[0]).not.toHaveProperty('sampleCount');
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

  it('caps an outlier-heavy rolling P90 spread with the robust central spread envelope', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        bid_close: '1.10000',
        ask_close: '1.10001',
        spread_close: '0.00001',
        last_sample_at: '2026-10-18T21:30:10.000Z',
        positive_sample_count: 24,
        p50_spread: 0.00001,
        p75_spread: 0.00001,
        p90_spread: 0.000659,
        latest_positive_sample_at: '2026-10-18T21:30:10.000Z',
      },
    ]);
    const service = new ProviderQuoteCandleStoreService({ query } as unknown as DataSource);

    const quote = await service.getLatestPositiveSpreadQuote('ctrader-1', 'EURUSD', EVALUATED_AT);

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('percentile_cont(0.50)');
    expect(sql).toContain('percentile_cont(0.75)');
    expect(quote).toMatchObject({
      instrument: 'EURUSD',
      positiveSampleCount: 24,
      spread: '0.0000400000',
    });
  });

  it('uses directly stored broker-native M5/M15 context instead of rebuilding sparse cTrader M1', async () => {
    const service = new ProviderQuoteCandleStoreService({
      query: jest.fn(),
    } as unknown as DataSource);
    const m15 = [
      {
        timestamp: new Date('2026-10-18T21:00:00.000Z'),
        open: '1.1000',
        high: '1.1050',
        low: '1.0950',
        close: '1.1020',
        volume: '50',
        tickVolume: '50',
        source: 'ctrader-broker-native',
        sampleCount: 50,
        spreadClose: null,
        firstSampleAt: new Date('2026-10-18T21:00:00.000Z'),
        lastSampleAt: new Date('2026-10-18T21:14:59.000Z'),
      },
    ];
    const direct = jest.spyOn(service, 'getStoredCandles').mockResolvedValue(m15);
    const m1 = jest.spyOn(service, 'getM1Candles').mockResolvedValue([]);

    await expect(
      service.getCandles('ctrader-1', 'EURUSD', 'M15', 30, EVALUATED_AT),
    ).resolves.toEqual(m15);

    expect(direct).toHaveBeenCalledWith('ctrader-1', 'EURUSD', 'M15', 30, EVALUATED_AT);
    expect(m1).not.toHaveBeenCalled();
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
});
