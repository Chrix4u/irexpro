import type { ConfigService } from '@nestjs/config';
import type { ProviderQuoteCandleStoreService } from '../market-data/services/provider-quote-candle-store.service';
import { M1TacticalMarketDataService } from './m1-tactical-market-data.service';

const DECISION = new Date('2026-10-18T21:30:15.000Z');

function harness(sourceConnectionId?: string) {
  const getCandles = jest.fn().mockResolvedValue([]);
  const getLatestPositiveSpreadQuote = jest.fn().mockResolvedValue(null);
  const store = {
    getCandles,
    getLatestPositiveSpreadQuote,
  } as unknown as ProviderQuoteCandleStoreService;
  const config = {
    get: jest.fn((key: string, fallback?: string) =>
      key === 'vpsForexScanner.m1MarketDataConnectionId'
        ? sourceConnectionId || fallback
        : fallback,
    ),
  } as unknown as ConfigService;
  return {
    service: new M1TacticalMarketDataService(store, config),
    getCandles,
    getLatestPositiveSpreadQuote,
  };
}

describe('M1 tactical market-data binding', () => {
  it('reads every timeframe and spread sample from the configured cTrader source while PAPER remains the caller binding', async () => {
    const h = harness('ctrader-connection');

    await expect(
      h.service.loadSnapshot('paper-execution-connection', 'EURUSD', DECISION),
    ).resolves.toBeNull();

    expect(h.getCandles).toHaveBeenCalledTimes(5);
    for (const call of h.getCandles.mock.calls) {
      expect(call[0]).toBe('ctrader-connection');
      expect(call[1]).toBe('EURUSD');
      expect(call[4]).toEqual(DECISION);
    }
    expect(h.getLatestPositiveSpreadQuote).toHaveBeenCalledWith(
      'ctrader-connection',
      'EURUSD',
      DECISION,
    );
  });

  it('falls back to the execution connection when no separate M1 source is configured', async () => {
    const h = harness();

    await h.service.loadSnapshot('paper-execution-connection', 'USDJPY', DECISION);

    expect(h.getCandles.mock.calls[0]![0]).toBe('paper-execution-connection');
    expect(h.getLatestPositiveSpreadQuote).toHaveBeenCalledWith(
      'paper-execution-connection',
      'USDJPY',
      DECISION,
    );
  });
});
