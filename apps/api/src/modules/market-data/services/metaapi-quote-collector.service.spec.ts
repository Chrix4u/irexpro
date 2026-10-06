import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import {
  isMetaApiQuoteCollectionWindow,
  isMetaApiQuotaError,
  MetaApiQuoteCollectorService,
} from './metaapi-quote-collector.service';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

function config(values: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

describe('MetaApiQuoteCollectorService', () => {
  it('collects all six major pairs from connected DEMO and LIVE MetaTrader accounts', async () => {
    const query = jest.fn().mockResolvedValue([
      { id: 'demo-1', user_id: 'user-demo' },
      { id: 'live-1', user_id: 'user-live' },
    ]);
    const getCurrentPriceForConnection = jest.fn().mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10010',
      spread: '0.00010',
      timestamp: new Date(),
    });
    const upsertM1Sample = jest.fn().mockResolvedValue(undefined);

    const service = new MetaApiQuoteCollectorService(
      config(),
      { query } as unknown as DataSource,
      { getCurrentPriceForConnection } as unknown as BrokerService,
      { upsertM1Sample } as unknown as ProviderQuoteCandleStoreService,
    );

    await service.collectOnce(new Date('2026-10-05T10:00:00Z'));

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("broker_id = 'metatrader5'");
    expect(sql).toContain("account_type IN ('DEMO', 'LIVE')");
    expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(12);
    for (const instrument of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']) {
      expect(getCurrentPriceForConnection).toHaveBeenCalledWith('user-demo', 'demo-1', instrument, {
        propagateProviderError: true,
      });
      expect(getCurrentPriceForConnection).toHaveBeenCalledWith('user-live', 'live-1', instrument, {
        propagateProviderError: true,
      });
    }
    expect(upsertM1Sample).toHaveBeenCalledTimes(12);
  });

  it('keeps instrument coverage configurable without weakening the broker-native source', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'live-1', user_id: 'user-live' }]);
    const getCurrentPriceForConnection = jest.fn().mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.1',
      ask: '1.2',
      spread: '0.1',
      timestamp: new Date(),
    });
    const upsertM1Sample = jest.fn().mockResolvedValue(undefined);

    const service = new MetaApiQuoteCollectorService(
      config({ METAAPI_QUOTE_COLLECTION_INSTRUMENTS: 'EURUSD, USDJPY' }),
      { query } as unknown as DataSource,
      { getCurrentPriceForConnection } as unknown as BrokerService,
      { upsertM1Sample } as unknown as ProviderQuoteCandleStoreService,
    );

    await service.collectOnce(new Date('2026-10-05T10:00:00Z'));

    expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(2);
    expect(getCurrentPriceForConnection).toHaveBeenNthCalledWith(
      1,
      'user-live',
      'live-1',
      'EURUSD',
      { propagateProviderError: true },
    );
    expect(getCurrentPriceForConnection).toHaveBeenNthCalledWith(
      2,
      'user-live',
      'live-1',
      'USDJPY',
      { propagateProviderError: true },
    );
  });

  it('bounds provider requests so one slow symbol cannot serialize the six-pair cycle', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'live-1', user_id: 'user-live' }]);
    let active = 0;
    let maxActive = 0;
    const getCurrentPriceForConnection = jest
      .fn()
      .mockImplementation(async (_user, _id, instrument) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          instrument,
          bid: '1.10000',
          ask: '1.10010',
          spread: '0.00010',
          timestamp: new Date(),
        };
      });
    const upsertM1Sample = jest.fn().mockResolvedValue(undefined);
    const service = new MetaApiQuoteCollectorService(
      config({ METAAPI_QUOTE_COLLECTION_CONCURRENCY: '3' }),
      { query } as unknown as DataSource,
      { getCurrentPriceForConnection } as unknown as BrokerService,
      { upsertM1Sample } as unknown as ProviderQuoteCandleStoreService,
    );

    await service.collectOnce(new Date('2026-10-05T10:00:00Z'));

    expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
    expect(upsertM1Sample).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(3);
  });

  it('releases a collection batch when one provider quote hangs', async () => {
    jest.useFakeTimers();
    try {
      const query = jest.fn().mockResolvedValue([{ id: 'live-1', user_id: 'user-live' }]);
      const getCurrentPriceForConnection = jest
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({
          instrument: 'USDJPY',
          bid: '150.000',
          ask: '150.010',
          spread: '0.010',
          timestamp: new Date('2026-10-05T10:00:00Z'),
        });
      const upsertM1Sample = jest.fn().mockResolvedValue(undefined);
      const service = new MetaApiQuoteCollectorService(
        config({
          METAAPI_QUOTE_COLLECTION_INSTRUMENTS: 'EURUSD,USDJPY',
          METAAPI_QUOTE_COLLECTION_CONCURRENCY: '2',
          METAAPI_QUOTE_REQUEST_TIMEOUT_MS: '10000',
        }),
        { query } as unknown as DataSource,
        { getCurrentPriceForConnection } as unknown as BrokerService,
        { upsertM1Sample } as unknown as ProviderQuoteCandleStoreService,
      );

      const pending = service.collectOnce(new Date('2026-10-05T10:00:00Z'));
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(10_000);
      await pending;

      expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(2);
      expect(upsertM1Sample).toHaveBeenCalledTimes(1);
      expect(upsertM1Sample).toHaveBeenCalledWith(
        'live-1',
        'USDJPY',
        expect.objectContaining({ bid: '150.000', ask: '150.010' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('collects across the full FX 24/5 session and skips only the weekend closure', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'live-1', user_id: 'user-live' }]);
    const getCurrentPriceForConnection = jest.fn();
    const service = new MetaApiQuoteCollectorService(
      config(),
      { query } as unknown as DataSource,
      { getCurrentPriceForConnection } as unknown as BrokerService,
      { upsertM1Sample: jest.fn() } as unknown as ProviderQuoteCandleStoreService,
    );

    await service.collectOnce(new Date('2026-10-04T13:00:00Z'));
    await service.collectOnce(new Date('2026-10-03T13:00:00Z'));

    expect(query).not.toHaveBeenCalled();
    expect(getCurrentPriceForConnection).not.toHaveBeenCalled();
    expect(isMetaApiQuoteCollectionWindow(new Date('2026-10-04T20:59:00Z'))).toBe(false);
    expect(isMetaApiQuoteCollectionWindow(new Date('2026-10-04T21:00:00Z'))).toBe(true);
    expect(isMetaApiQuoteCollectionWindow(new Date('2026-10-05T21:10:00Z'))).toBe(true);
    expect(isMetaApiQuoteCollectionWindow(new Date('2026-10-08T23:59:00Z'))).toBe(true);
    expect(isMetaApiQuoteCollectionWindow(new Date('2026-10-09T20:59:00Z'))).toBe(true);
    expect(isMetaApiQuoteCollectionWindow(new Date('2026-10-09T21:00:00Z'))).toBe(false);
    expect(isMetaApiQuoteCollectionWindow(new Date('2026-10-10T12:00:00Z'))).toBe(false);
  });

  it('recognizes MetaApi quota and CPU-credit failures', () => {
    expect(isMetaApiQuotaError(new Error('API allows 180000 cpu credits per 1h'))).toBe(true);
    expect(isMetaApiQuotaError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isMetaApiQuotaError(new Error('temporary broker timeout'))).toBe(false);
  });

  it('cools down a whole connection after a MetaApi quota failure', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'live-1', user_id: 'user-live' }]);
    const getCurrentPriceForConnection = jest
      .fn()
      .mockRejectedValueOnce(new Error('The API allows 180000 cpu credits per 1h'));
    const upsertM1Sample = jest.fn();
    const service = new MetaApiQuoteCollectorService(
      config({
        METAAPI_QUOTE_COLLECTION_INSTRUMENTS: 'EURUSD,USDJPY',
        METAAPI_QUOTE_COLLECTION_CONCURRENCY: '1',
      }),
      { query } as unknown as DataSource,
      { getCurrentPriceForConnection } as unknown as BrokerService,
      { upsertM1Sample } as unknown as ProviderQuoteCandleStoreService,
    );

    await service.collectOnce(new Date('2026-10-05T10:00:00Z'));
    await service.collectOnce(new Date('2026-10-05T10:10:00Z'));

    expect(query).toHaveBeenCalledTimes(2);
    expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(1);
    expect(upsertM1Sample).not.toHaveBeenCalled();

    getCurrentPriceForConnection.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.1000',
      ask: '1.1001',
      spread: '0.0001',
      timestamp: new Date('2026-10-05T10:31:00Z'),
    });
    await service.collectOnce(new Date('2026-10-05T10:31:00Z'));

    expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(3);
    expect(upsertM1Sample).toHaveBeenCalledTimes(2);
  });
});
