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
    'vpsForexScanner.m1CtraderCollectionInstruments': 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

function harness(
  options: {
    brokerId?: string;
    status?: BrokerConnectionStatus;
    quoteTimestamp?: Date;
  } = {},
) {
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
    timestamp: options.quoteTimestamp ?? new Date('2026-10-18T21:30:10.000Z'),
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
  beforeEach(() => {
    // The collector validates real receipt time. Anchor the wall clock to
    // deterministic broker timestamps without faking timers/setImmediate.
    jest.spyOn(Date, 'now').mockReturnValue(OPEN_NOW.getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('warms a bounded broker-native history slice and samples live spreads for all six majors', async () => {
    const h = harness();

    await h.service.collectOnce(OPEN_NOW);

    expect(h.findConnectionById).toHaveBeenCalledWith('ctrader-1', 'user-1');
    expect(h.getOhlcvForConnection).toHaveBeenCalledTimes(4);
    expect(h.getOhlcvForConnection.mock.calls.filter((call) => call[3] === 'M1')).toHaveLength(3);
    expect(h.getOhlcvForConnection.mock.calls.filter((call) => call[3] === 'M5')).toHaveLength(1);
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

  it('does not let a stalled M1 fetch prevent other broker-native history and context requests from starting', async () => {
    const h = harness();
    let releaseFirstM1: (() => void) | undefined;
    const historicalBar = {
      timestamp: new Date('2026-10-18T20:00:00.000Z'),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
      volume: '50',
    };
    h.getOhlcvForConnection.mockImplementation(
      async (_userId, _connectionId, instrument, timeframe) => {
        if (instrument === 'EURUSD' && timeframe === 'M1') {
          await new Promise<void>((resolve) => {
            releaseFirstM1 = resolve;
          });
        }
        return [historicalBar];
      },
    );

    const cycle = h.service.collectOnce(OPEN_NOW);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const allRequestsStartedBeforeRelease = h.getOhlcvForConnection.mock.calls.length === 4;
    const contextStartedBeforeRelease = h.getOhlcvForConnection.mock.calls.some(
      (call) => call[3] === 'M5',
    );
    releaseFirstM1?.();
    await cycle;

    expect(allRequestsStartedBeforeRelease).toBe(true);
    expect(contextStartedBeforeRelease).toBe(true);
    expect(h.upsertHistoricalCandles).toHaveBeenCalledTimes(4);
  });

  it('starts broker-native history refresh without waiting for a slow live spot response', async () => {
    const h = harness();
    let releaseQuote: (() => void) | undefined;
    const normalQuote = {
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10008',
      spread: '0.00008',
      timestamp: new Date('2026-10-18T21:30:10.000Z'),
    };
    h.getCurrentPriceForConnection.mockImplementation(
      async (_userId, _connectionId, instrument) => {
        if (instrument === 'EURUSD') {
          await new Promise<void>((resolve) => {
            releaseQuote = resolve;
          });
        }
        return { ...normalQuote, instrument };
      },
    );

    const cycle = h.service.collectOnce(OPEN_NOW);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const historyStartedBeforeRelease = h.getOhlcvForConnection.mock.calls.length > 0;
    releaseQuote?.();
    await cycle;

    expect(historyStartedBeforeRelease).toBe(true);
  });

  it('samples live quotes independently of the slower historical refresh cycle', async () => {
    const h = harness();

    await h.service.collectLiveQuotesOnce(OPEN_NOW);

    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
    expect(h.upsertM1Sample).toHaveBeenCalledTimes(6);
    expect(h.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(h.upsertHistoricalCandles).not.toHaveBeenCalled();
  });

  it('rejects stale provider spot timestamps instead of rewriting an old M1 spread bucket', async () => {
    const h = harness({ quoteTimestamp: new Date(OPEN_NOW.getTime() - 6 * 60_000) });

    await h.service.collectLiveQuotesOnce(OPEN_NOW);

    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
    expect(h.upsertM1Sample).not.toHaveBeenCalled();
  });

  it('accepts provider spot timestamps inside the execution-spread freshness window', async () => {
    const h = harness({ quoteTimestamp: new Date(OPEN_NOW.getTime() - 4 * 60_000) });

    await h.service.collectLiveQuotesOnce(OPEN_NOW);

    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
    expect(h.upsertM1Sample).toHaveBeenCalledTimes(6);
  });

  it('rejects provider spot timestamps materially ahead of the collector clock', async () => {
    const h = harness({ quoteTimestamp: new Date(OPEN_NOW.getTime() + 6_000) });

    await h.service.collectLiveQuotesOnce(OPEN_NOW);

    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
    expect(h.upsertM1Sample).not.toHaveBeenCalled();
  });

  it('accepts a broker quote received after a delayed request even when newer than the collection start', async () => {
    const quoteTimestamp = new Date(OPEN_NOW.getTime() + 10_000);
    const h = harness({ quoteTimestamp });
    jest.spyOn(Date, 'now').mockReturnValue(OPEN_NOW.getTime() + 12_000);

    await h.service.collectLiveQuotesOnce(OPEN_NOW);

    expect(h.upsertM1Sample).toHaveBeenCalledTimes(6);
    expect(h.upsertM1Sample.mock.calls[0]?.[2].timestamp).toEqual(quoteTimestamp);
  });

  it('still rejects broker quotes ahead of their actual receipt time', async () => {
    const h = harness({ quoteTimestamp: new Date(OPEN_NOW.getTime() + 20_000) });
    jest.spyOn(Date, 'now').mockReturnValue(OPEN_NOW.getTime() + 12_000);

    await h.service.collectLiveQuotesOnce(OPEN_NOW);

    expect(h.upsertM1Sample).not.toHaveBeenCalled();
  });

  it('rejects quotes that expire while the provider request is pending', async () => {
    const h = harness({ quoteTimestamp: new Date(OPEN_NOW.getTime() - 1_000) });
    jest.spyOn(Date, 'now').mockReturnValue(OPEN_NOW.getTime() + 6 * 60_000);

    await h.service.collectLiveQuotesOnce(OPEN_NOW);

    expect(h.upsertM1Sample).not.toHaveBeenCalled();
  });

  it('refreshes sixty recent M1 broker bars after the durable store is warm', async () => {
    const h = harness();
    h.countM1Candles.mockResolvedValue(1_000);

    await h.service.collectOnce(OPEN_NOW);

    const m1Calls = h.getOhlcvForConnection.mock.calls.filter((call) => call[3] === 'M1');
    expect(m1Calls).toHaveLength(3);
    expect(m1Calls.every((call) => call[4] === 60)).toBe(true);
  });

  it('prioritizes fast M5/M15 context without increasing the four-request historical budget', async () => {
    const h = harness();
    const instruments = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];

    for (let index = 0; index < 48; index += 1) {
      await h.service.collectOnce(new Date(OPEN_NOW.getTime() + index * 15_000));
    }

    const allCalls = h.getOhlcvForConnection.mock.calls;
    const contextCalls = allCalls.filter((call) => call[3] !== 'M1');
    expect(allCalls).toHaveLength(48 * 4);
    expect(contextCalls).toHaveLength(48);
    expect(contextCalls.slice(0, 8).map((call) => call[3])).toEqual([
      'M5',
      'M15',
      'M5',
      'M15',
      'M5',
      'M15',
      'H1',
      'H4',
    ]);

    for (const [timeframe, expectedCallsPerInstrument] of [
      ['M5', 3],
      ['M15', 3],
      ['H1', 1],
      ['H4', 1],
    ] as const) {
      const calls = contextCalls.filter((call) => call[3] === timeframe);
      expect(calls).toHaveLength(expectedCallsPerInstrument * instruments.length);
      for (const instrument of instruments) {
        expect(calls.filter((call) => call[2] === instrument)).toHaveLength(
          expectedCallsPerInstrument,
        );
      }
    }

    // Both fast contexts complete a six-pair sweep within 16 historical
    // slots (four minutes at the nominal cadence), without starving H1/H4.
    // This reduces the old M15 24-slot sweep and stays within the M5 gate.
    for (const timeframe of ['M5', 'M15']) {
      for (const instrument of instruments) {
        const slots = contextCalls.flatMap((call, index) =>
          call[2] === instrument && call[3] === timeframe ? [index] : [],
        );
        expect(slots).toHaveLength(3);
        for (let index = 1; index < slots.length; index += 1) {
          expect(slots[index]! - slots[index - 1]!).toBeLessThanOrEqual(16);
        }
      }
    }

    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(48 * instruments.length);
  });

  it('samples live spreads before historical refresh so a hung history request cannot starve quote freshness', async () => {
    const h = harness();
    h.getOhlcvForConnection.mockImplementation(() => new Promise(() => undefined));

    void h.service.collectOnce(OPEN_NOW);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
    expect(h.upsertM1Sample).toHaveBeenCalledTimes(6);
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

describe('z.ai P9 cTrader historical failure telemetry', () => {
  it('records last successful broker-native collection for each timeframe without altering quote collection', async () => {
    const h = harness();
    await h.service.collectOnce(OPEN_NOW);
    const status = h.service.getHistoricalCollectionStatus();
    expect(status.lastSuccessfulCollectAt['EURUSD:M1']).toBe(OPEN_NOW.toISOString());
    expect(status.lastSuccessfulCollectAt['EURUSD:M5']).toBe(OPEN_NOW.toISOString());
    expect(status.lastSuccessfulCollectAt['AUDUSD:M1']).toBeUndefined();
    expect(status.historicalRefreshFailures).toEqual({});
    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
  });

  it('records stale broker-native history without treating an old M5 bar as current', async () => {
    const h = harness();
    await h.service.collectOnce(OPEN_NOW);
    const status = h.service.getHistoricalCollectionStatus();
    expect(status.latestBrokerClosedBarAt['EURUSD:M5']).toBe('2026-10-18T20:00:00.000Z');
    expect(status.staleHistoricalResponses['EURUSD:M5']).toBe(1);
    expect(status.lastSuccessfulCollectAt['EURUSD:M5']).toBe(OPEN_NOW.toISOString());
    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
  });

  it('clears stale-response telemetry once the broker supplies a recent closed candle', async () => {
    const h = harness();
    await h.service.collectOnce(OPEN_NOW);
    const recentClosedM5 = {
      timestamp: new Date(OPEN_NOW.getTime() - 6 * 60_000),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
      volume: '50',
    };
    h.getOhlcvForConnection.mockResolvedValue([recentClosedM5]);
    // The rotation returns to EURUSD:M5 after the first fast-context sweep.
    for (let index = 1; index <= 16; index += 1) {
      await h.service.collectOnce(new Date(OPEN_NOW.getTime() + index * 15_000));
    }
    const status = h.service.getHistoricalCollectionStatus();
    expect(status.latestBrokerClosedBarAt['EURUSD:M5']).toBe(
      recentClosedM5.timestamp.toISOString(),
    );
    expect(status.staleHistoricalResponses['EURUSD:M5']).toBeUndefined();
  });

  it('retries failed context once, never counts failure as collection success', async () => {
    const h = harness();
    const original = h.getOhlcvForConnection.getMockImplementation();
    let failOnce = true;
    h.getOhlcvForConnection.mockImplementation(async (...args) => {
      if (args[3] === 'M5' && failOnce) {
        failOnce = false;
        throw new Error('temporary history timeout');
      }
      return original?.(...args);
    });
    await h.service.collectOnce(OPEN_NOW);
    const calls = h.getOhlcvForConnection.mock.calls.filter((call) => call[3] === 'M5');
    expect(calls).toHaveLength(2);
    expect(h.service.getHistoricalCollectionStatus().lastSuccessfulCollectAt['EURUSD:M5']).toBe(
      OPEN_NOW.toISOString(),
    );
    expect(
      h.service.getHistoricalCollectionStatus().historicalRefreshFailures['EURUSD:M5'],
    ).toBeUndefined();
  });

  it('keeps collecting quotes if both context attempts fail, and logs the failed refresh counter', async () => {
    const h = harness();
    const original = h.getOhlcvForConnection.getMockImplementation();
    h.getOhlcvForConnection.mockImplementation(async (...args) => {
      if (args[3] === 'M5') throw new Error('context unavailable');
      return original?.(...args);
    });
    await h.service.collectOnce(OPEN_NOW);
    const status = h.service.getHistoricalCollectionStatus();
    expect(status.lastSuccessfulCollectAt['EURUSD:M5']).toBeUndefined();
    expect(status.historicalRefreshFailures['EURUSD:M5']).toBe(2);
    expect(h.getCurrentPriceForConnection).toHaveBeenCalledTimes(6);
  });
});
