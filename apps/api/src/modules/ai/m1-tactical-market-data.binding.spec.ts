import type { ConfigService } from '@nestjs/config';
import type { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';
import type { ProviderQuoteCandleStoreService } from '../market-data/services/provider-quote-candle-store.service';
import { M1TacticalMarketDataService } from './m1-tactical-market-data.service';

const DECISION = new Date('2026-10-18T21:30:15.000Z');

function paperSeries(decisionTime: Date, minutes: number, count: number) {
  const duration = minutes * 60_000;
  const boundary = Math.floor(decisionTime.getTime() / duration) * duration;
  return Array.from({ length: count }, (_, index) => {
    const timestamp = new Date(boundary - (count - index) * duration);
    const mid = 1.08 + index * 0.00008;
    return {
      timestamp,
      open: mid.toFixed(6),
      high: (mid + 0.00025).toFixed(6),
      low: (mid - 0.0002).toFixed(6),
      close: (mid + 0.00005).toFixed(6),
    };
  });
}

function harness(sourceConnectionId?: string, paperReady = false) {
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
  const getOHLCV = jest.fn(
    (instrument: string, timeframe: string, _count: number, _connectionId?: string) => {
      if (!paperReady) throw new Error('paper M1 unavailable');
      const minutes: Record<string, number> = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240 };
      const value = minutes[timeframe];
      if (!value) throw new Error(`unsupported ${timeframe}`);
      return paperSeries(DECISION, value, timeframe === 'M1' ? 60 : 30);
    },
  );
  const getPaperFallbackSpread = jest.fn().mockReturnValue(0.0001);
  const paperMarket = { getOHLCV, getPaperFallbackSpread } as unknown as LivePaperMarketDataService;
  return {
    service: new M1TacticalMarketDataService(store, config, paperMarket),
    getCandles,
    getLatestPositiveSpreadQuote,
    getOHLCV,
    getPaperFallbackSpread,
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
    expect(h.getOHLCV).not.toHaveBeenCalled();
  });

  it('builds a PAPER-only snapshot from fresh connection-scoped M1 plus cached higher-timeframe context when no separate source is configured', async () => {
    const h = harness(undefined, true);

    const result = await h.service.loadSnapshot('paper-execution-connection', 'EURUSD', DECISION);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      connectionId: 'paper-execution-connection',
      instrument: 'EURUSD',
      candleSource: 'PAPER_FAST_MARK_M1',
      spreadEvidence: null,
      paperSimulationSpreadPrice: 0.0001,
      marketDataAuthority: 'PAPER_PROVIDER_SIMULATION',
    });
    expect(h.getOHLCV).toHaveBeenCalledTimes(5);
    for (const call of h.getOHLCV.mock.calls) {
      expect(call[0]).toBe('EURUSD');
      expect(call[3]).toBe('paper-execution-connection');
    }
    expect(h.getPaperFallbackSpread).toHaveBeenCalledWith('EURUSD', 'paper-execution-connection');
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
