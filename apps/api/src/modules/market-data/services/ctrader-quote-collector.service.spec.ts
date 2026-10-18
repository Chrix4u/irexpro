import type { ConfigService } from '@nestjs/config';
import type { BrokerService } from '../../broker/broker.service';
import { BrokerConnectionStatus } from '../../broker/interfaces/broker-adapter.interface';
import type { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';
import { CTraderQuoteCollectorService } from './ctrader-quote-collector.service';

const OPEN_NOW = new Date('2026-10-18T21:30:15.000Z');

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'vpsForexScanner.enabled': true,
    'vpsForexScanner.m1CtraderCollectionEnabled': true,
    'vpsForexScanner.userId': 'user-1',
    'vpsForexScanner.m1MarketDataConnectionId': 'ctrader-1',
    'vpsForexScanner.m1CtraderCollectionIntervalMs': 15_000,
    'vpsForexScanner.m1CtraderCollectionInstruments':
      'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

function harness(options: { brokerId?: string; status?: BrokerConnectionStatus } = {}) {
  const findConnectionById = jest.fn().mockResolvedValue({
    id: 'ctrader-1',
    userId: 'user-1',
    brokerId: options.brokerId ?? 'ctrader',
    status: options.status ?? BrokerConnectionStatus.CONNECTED,
  });
  const getOhlcvForConnection = jest.fn().mockResolvedValue([
    {
      timestamp: new Date('2026-10-18T20:00:00.000Z'),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
      volume: '50',
    },
  ]);
  const getCurrentPriceForConnection = jest.fn().mockImplementation(async (_u, _c, instrument) => ({
    instrument,
    bid: '1.10000',
    ask: '1.10008',
    spread: '0.00008',
    timestamp: new Date('2026-10-18T21:30:10.000Z'),
  }));
  const broker = {
    findConnectionById,
    getOhlcvForConnection,
    getCurrentPriceForConnection,
  } as unknown as BrokerService;

  const countM1Candles = jest.fn().mockResolvedValue(0);
  const upsertHistoricalCandles = jest.fn().mockResolvedValue(undefined);
  const upsertM1Sample = jest.fn().mockResolvedValue(undefined);
  const store = {
    countM1Candles,
    upsertHistoricalCandles,
    upsertM1Sample,
  } as unknown as ProviderQuoteCandleStoreService;

  return {
    service: new CTraderQuoteCollectorService(config(), broker, store),
    findConnectionById,
    getOhlcvForConnection,
    getCurrentPriceForConnection,
    countM1Candles,
    upsertHistoricalCandles,
    upsertM1Sample,
  };
}

describe('CTraderQuoteCollectorService', () => {
  it('warms a bounded broker-native history slice and samples live spreads for all six majors', async () => {
    const h = harness();

    await h.service.collectOnce(OPEN_NOW);

    expect(h.findConnectionById).toHaveBeenCalledWith('ctrader-1', 'user-1');
    expect(h.getOhlcvForConnection).toHaveBeenCalledTimes(4);
    expect(
      h.getOhlcvForConnection.mock.calls.filter((call) => call[3] === 'M1'),
    ).toHaveLength(3);
    expect(h.getOhlcvForConnection.mock.calls[3]![3]).toBe('H1');
    for (const call of h.getOhlcvForConnection.mock.calls) {
      expect(call[0]).toBe('user-1');
      expect(call[1]).toBe('ctrader-1');
    }

    expect(h.upsertHistoricalCandles).toHaveBeenCalledTimes(4);
    for (const call of h.upsertHistoricalCandles.mock.calls) {
      expect(call[0]).toBe('ctrader-1');
      expect(call[4]).toBe('ctrader-broker-native');
    }

    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
    expect(h.upsertM1Sample).toHaveBeenCalledTimes(6);
    for (const call of h.upsertM1Sample.mock.calls) {
      expect(call[0]).toBe('ctrader-1');
      expect(call[3]).toBe('ctrader-broker-native');
    }
  });

  it('fails closed when the configured source is not a cTrader-family connection', async () => {
    const h = harness({ brokerId: 'metatrader5' });

    await h.service.collectOnce(OPEN_NOW);

    expect(h.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(h.getCurrentPriceForConnection).not.toHaveBeenCalled();
    expect(h.upsertHistoricalCandles).not.toHaveBeenCalled();
    expect(h.upsertM1Sample).not.toHaveBeenCalled();
  });

  it('pauses collection when the exact cTrader source is not CONNECTED', async () => {
    const h = harness({ status: BrokerConnectionStatus.DISCONNECTED });

    await h.service.collectOnce(OPEN_NOW);

    expect(h.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(h.getCurrentPriceForConnection).not.toHaveBeenCalled();
  });

  it('does no provider work while the FX weekly session is closed', async () => {
    const h = harness();

    await h.service.collectOnce(new Date('2026-10-17T12:00:00.000Z'));

    expect(h.findConnectionById).not.toHaveBeenCalled();
    expect(h.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(h.getCurrentPriceForConnection).not.toHaveBeenCalled();
  });
});
