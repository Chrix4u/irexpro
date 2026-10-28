import type { OHLCV, BrokerPrice } from '../broker/interfaces/broker-adapter.interface';
import type {
  ProviderQuoteCandle,
  ProviderQuoteCandleStoreService,
} from '../market-data/services/provider-quote-candle-store.service';
import { M1TacticalMarketDataService } from './m1-tactical-market-data.service';

const DECISION = new Date('2026-10-15T12:30:15.000Z');

function rows(
  count: number,
  minutes: number,
  latestOpen: Date,
  source = 'metaapi-rpc-sampled',
): ProviderQuoteCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = new Date(latestOpen.getTime() - (count - 1 - index) * minutes * 60_000);
    const close = 1.09 + index * 0.0001;
    return {
      timestamp,
      open: (close - 0.00005).toFixed(5),
      high: (close + 0.00015).toFixed(5),
      low: (close - 0.00015).toFixed(5),
      close: close.toFixed(5),
      volume: '4',
      tickVolume: '4',
      source,
      sampleCount: 4,
      spreadClose: '0.00004',
      firstSampleAt: new Date(timestamp.getTime() + 5_000),
      lastSampleAt: new Date(timestamp.getTime() + Math.min(minutes * 60_000 - 5_000, 55_000)),
    };
  });
}

function baseSeries(): Record<string, OHLCV[]> {
  return {
    M1: rows(60, 1, new Date('2026-10-15T12:29:00.000Z')),
    M5: rows(30, 5, new Date('2026-10-15T12:25:00.000Z')),
    M15: rows(30, 15, new Date('2026-10-15T12:15:00.000Z')),
    H1: rows(30, 60, new Date('2026-10-15T11:00:00.000Z')),
    H4: rows(30, 240, new Date('2026-10-15T08:00:00.000Z')),
  };
}

function spread(
  changes: Partial<
    BrokerPrice & { positiveSampleCount: number; latestPositiveSampleAt: Date }
  > = {},
): BrokerPrice & { positiveSampleCount: number; latestPositiveSampleAt: Date } {
  return {
    instrument: 'EURUSD',
    bid: '1.09598',
    ask: '1.09602',
    spread: '0.00004',
    timestamp: new Date('2026-10-15T12:29:55.000Z'),
    positiveSampleCount: 20,
    latestPositiveSampleAt: new Date('2026-10-15T12:29:55.000Z'),
    ...changes,
  };
}

function fixture(overrides: Partial<Record<string, OHLCV[]>> = {}) {
  const series = { ...baseSeries(), ...overrides };
  const getCandles = jest.fn(
    async (
      _connectionId: string,
      _instrument: string,
      timeframe: string,
      _count: number,
      _evaluatedAt: Date,
    ): Promise<OHLCV[]> => series[timeframe] ?? [],
  );
  const getLatestPositiveSpreadQuote = jest.fn().mockResolvedValue(spread());
  const store = {
    getCandles,
    getLatestPositiveSpreadQuote,
  } as unknown as ProviderQuoteCandleStoreService;
  return {
    service: new M1TacticalMarketDataService(store),
    getCandles,
    getLatestPositiveSpreadQuote,
  };
}

describe('M1TacticalMarketDataService', () => {
  it('loads a causal completed M1/M5/M15/H1/H4 snapshot with spread evidence', async () => {
    const { service, getCandles, getLatestPositiveSpreadQuote } = fixture();

    const result = await service.loadSnapshot('conn-1', 'eurusd', DECISION);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      connectionId: 'conn-1',
      instrument: 'EURUSD',
      candleSource: 'metaapi-rpc-sampled',
      marketDataAuthority: 'BROKER_NATIVE',
      spreadEvidence: {
        source: 'BROKER_OBSERVED_P90',
        sampleCount: 20,
        percentile: 0.9,
        windowMinutes: 30,
      },
    });
    expect(result!.m1).toHaveLength(60);
    expect(result!.m5).toHaveLength(30);
    expect(result!.m15).toHaveLength(30);
    expect(result!.h1).toHaveLength(30);
    expect(result!.h4).toHaveLength(30);
    expect(result!.spreadEvidence).not.toBeNull();
    expect(result!.spreadEvidence!.spreadPrice).toBeCloseTo(0.00004, 8);
    expect(getCandles).toHaveBeenCalledTimes(5);
    for (const call of getCandles.mock.calls) {
      expect(call[4]).toEqual(DECISION);
    }
    expect(getLatestPositiveSpreadQuote).toHaveBeenCalledWith('conn-1', 'EURUSD', DECISION);
    expect(service.getLastReadiness('conn-1', 'EURUSD')).toEqual(
      expect.objectContaining({ ready: true, reason: 'READY', authority: 'BROKER_NATIVE' }),
    );
  });

  it('fails closed when H1 or H4 warm history is insufficient', async () => {
    const { service } = fixture({ H4: rows(10, 240, new Date('2026-10-15T08:00:00.000Z')) });
    await expect(service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();
  });

  it('fails closed when the latest completed M1 bar is stale', async () => {
    const { service } = fixture({ M1: rows(60, 1, new Date('2026-10-15T12:20:00.000Z')) });
    await expect(service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();
  });

  it('fails closed when broker-native M5 or M15 context is stale even with fresh M1 and spread', async () => {
    const staleM5 = fixture({ M5: rows(30, 5, new Date('2026-10-15T12:10:00.000Z')) });
    await expect(staleM5.service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();
    expect(staleM5.service.getLastReadiness('conn-1', 'EURUSD')).toEqual(
      expect.objectContaining({ ready: false, reason: 'BROKER_FEATURE_CONTEXT_UNAVAILABLE' }),
    );

    const staleM15 = fixture({ M15: rows(30, 15, new Date('2026-10-15T11:45:00.000Z')) });
    await expect(staleM15.service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();
    expect(staleM15.service.getLastReadiness('conn-1', 'EURUSD')).toEqual(
      expect.objectContaining({ ready: false, reason: 'BROKER_FEATURE_CONTEXT_UNAVAILABLE' }),
    );
  });

  it('records why a stale M1 snapshot was unavailable', async () => {
    const { service } = fixture({ M1: rows(60, 1, new Date('2026-10-15T12:20:00.000Z')) });

    await expect(service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();
    expect(service.getLastReadiness('conn-1', 'EURUSD')).toEqual(
      expect.objectContaining({
        ready: false,
        reason: 'BROKER_M1_STALE',
        authority: null,
      }),
    );
  });

  it('fails closed when positive spread evidence is stale or under-sampled', async () => {
    const stale = fixture();
    stale.getLatestPositiveSpreadQuote.mockResolvedValue(
      spread({ latestPositiveSampleAt: new Date('2026-10-15T12:20:00.000Z') }),
    );
    await expect(stale.service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();

    const sparse = fixture();
    sparse.getLatestPositiveSpreadQuote.mockResolvedValue(spread({ positiveSampleCount: 4 }));
    await expect(sparse.service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();
  });

  it('fails closed when the M1 history mixes provider sources', async () => {
    const m1 = rows(60, 1, new Date('2026-10-15T12:29:00.000Z'));
    m1[15] = { ...m1[15]!, source: 'unexpected-source' };
    const { service } = fixture({ M1: m1 });
    await expect(service.loadSnapshot('conn-1', 'EURUSD', DECISION)).resolves.toBeNull();
  });

  it('waits for Sunday-open warm-up instead of fabricating context', async () => {
    const sunday = new Date('2026-10-18T21:05:15.000Z');
    const { service } = fixture({
      M1: rows(5, 1, new Date('2026-10-18T21:04:00.000Z')),
      H1: rows(10, 60, new Date('2026-10-16T20:00:00.000Z')),
      H4: rows(10, 240, new Date('2026-10-16T16:00:00.000Z')),
    });
    await expect(service.loadSnapshot('conn-1', 'EURUSD', sunday)).resolves.toBeNull();
  });
});
