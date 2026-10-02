import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { MetaApiQuoteCollectorService } from './metaapi-quote-collector.service';
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

    await service.collectOnce();

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("broker_id = 'metatrader5'");
    expect(sql).toContain("account_type IN ('DEMO', 'LIVE')");
    expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(12);
    for (const instrument of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']) {
      expect(getCurrentPriceForConnection).toHaveBeenCalledWith(
        'user-demo',
        'demo-1',
        instrument,
      );
      expect(getCurrentPriceForConnection).toHaveBeenCalledWith(
        'user-live',
        'live-1',
        instrument,
      );
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

    await service.collectOnce();

    expect(getCurrentPriceForConnection).toHaveBeenCalledTimes(2);
    expect(getCurrentPriceForConnection).toHaveBeenNthCalledWith(
      1,
      'user-live',
      'live-1',
      'EURUSD',
    );
    expect(getCurrentPriceForConnection).toHaveBeenNthCalledWith(
      2,
      'user-live',
      'live-1',
      'USDJPY',
    );
  });
});
