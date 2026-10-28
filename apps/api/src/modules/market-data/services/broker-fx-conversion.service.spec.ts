import { BrokerFxConversionService } from './broker-fx-conversion.service';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

const NOW = new Date('2026-10-28T20:30:00.000Z');

function quote(instrument: string, bid: string, ask: string, ageMs = 5_000) {
  const timestamp = new Date(NOW.getTime() - ageMs);
  return {
    instrument,
    bid,
    ask,
    spread: String(Number(ask) - Number(bid)),
    timestamp,
    positiveSampleCount: 10,
    latestPositiveSampleAt: timestamp,
  };
}

describe('BrokerFxConversionService', () => {
  function fixture(rows: Record<string, ReturnType<typeof quote> | null>) {
    const getLatestPositiveSpreadQuote = jest.fn().mockImplementation(
      async (_connectionId: string, instrument: string) => rows[instrument] ?? null,
    );
    return {
      service: new BrokerFxConversionService({
        getLatestPositiveSpreadQuote,
      } as unknown as ProviderQuoteCandleStoreService),
      getLatestPositiveSpreadQuote,
    };
  }

  it('uses a fresh direct same-broker bid conservatively', async () => {
    const h = fixture({ EURUSD: quote('EURUSD', '1.0800', '1.0802') });

    const result = await h.service.resolveCachedBid('ctrader-1', 'EUR', 'USD', NOW);

    expect(result).toMatchObject({
      rate: '1.08',
      path: ['EURUSD'],
      source: 'BROKER_NATIVE_CACHE_DIRECT',
    });
  });

  it('inverts a fresh inverse quote using one over ask', async () => {
    const h = fixture({ USDEUR: quote('USDEUR', '0.49', '0.5') });

    const result = await h.service.resolveCachedBid('ctrader-1', 'EUR', 'USD', NOW);

    expect(result).toMatchObject({
      rate: '2',
      path: ['USDEUR'],
      source: 'BROKER_NATIVE_CACHE_INVERSE',
    });
  });

  it('builds a conservative USD bridge from two fresh same-connection legs', async () => {
    const h = fixture({
      EURUSD: quote('EURUSD', '1.10', '1.1002'),
      USDJPY: quote('USDJPY', '150', '150.02'),
    });

    const result = await h.service.resolveCachedBid('ctrader-1', 'EUR', 'JPY', NOW);

    expect(result).toMatchObject({
      rate: '165',
      path: ['EURUSD', 'USDJPY'],
      source: 'BROKER_NATIVE_CACHE_USD_BRIDGE',
    });
  });

  it('fails closed when either USD bridge leg is stale', async () => {
    const h = fixture({
      EURUSD: quote('EURUSD', '1.10', '1.1002'),
      USDJPY: quote('USDJPY', '150', '150.02', 61_000),
    });

    await expect(h.service.resolveCachedBid('ctrader-1', 'EUR', 'JPY', NOW)).resolves.toBeNull();
  });
});
