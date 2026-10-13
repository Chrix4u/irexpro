import { ConfigService } from '@nestjs/config';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { LivePaperMarketDataService } from '../../broker/services/live-paper-market-data.service';
import { PaperBrokerStateService } from '../../broker/services/paper-broker-state.service';
import { PaperPositionMarkBridgeService } from './paper-position-mark-bridge.service';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

describe('PaperPositionMarkBridgeService', () => {
  function config(): ConfigService {
    return {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.brokerConnectionId': 'paper-1',
          'multimodelBrokerExpert.sourceConnectionId': 'metaapi-1',
          METAAPI_QUOTE_COLLECTION_ENABLED: 'true',
        };
        return key in values ? values[key] : fallback;
      }),
    } as unknown as ConfigService;
  }

  function brokerAdapters(
    getOpenPositions = jest.fn().mockResolvedValue([]),
  ): BrokerAdapterRegistry {
    return {
      getAdapterForConnection: jest.fn().mockReturnValue({ getOpenPositions }),
    } as unknown as BrokerAdapterRegistry;
  }

  function executionQuote(instrument: string, observedAt = '2026-10-05T10:55:20.000Z') {
    return {
      instrument,
      bid: instrument === 'USDJPY' ? '149.1185' : '1.099995',
      ask: instrument === 'USDJPY' ? '149.1215' : '1.100005',
      spread: instrument === 'USDJPY' ? '0.003' : '0.00001',
      timestamp: new Date(observedAt),
      positiveSampleCount: 20,
      latestPositiveSampleAt: new Date(observedAt),
    };
  }

  function livePaper(updateProviderQuote = jest.fn()): LivePaperMarketDataService {
    return {
      instruments: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'],
      updateProviderQuote,
    } as unknown as LivePaperMarketDataService;
  }

  it('primes executable provider quotes for all six PAPER instruments even with no open positions', async () => {
    const now = new Date('2026-10-05T10:55:30.000Z');
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [] }),
    } as unknown as PaperBrokerStateService;
    const getLatestPositiveSpreadQuote = jest
      .fn()
      .mockImplementation(async (_connectionId: string, instrument: string) =>
        executionQuote(instrument),
      );
    const store = { getLatestPositiveSpreadQuote } as unknown as ProviderQuoteCandleStoreService;
    const updateProviderQuote = jest.fn();
    const getOpenPositions = jest.fn().mockResolvedValue([]);
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      store,
      livePaper(updateProviderQuote),
      brokerAdapters(getOpenPositions),
    );

    await service.collectOnce(now);

    expect(getLatestPositiveSpreadQuote).toHaveBeenCalledTimes(6);
    expect(updateProviderQuote).toHaveBeenCalledTimes(6);
    expect(getOpenPositions).not.toHaveBeenCalled();
  });

  it('deduplicates sampled provider timestamps while keeping protection heartbeat server-side', async () => {
    const now = new Date('2026-10-05T10:55:30.000Z');
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [{ instrument: 'USDCAD' }] }),
    } as unknown as PaperBrokerStateService;
    const getLatestPositiveSpreadQuote = jest
      .fn()
      .mockImplementation(async (_connectionId: string, instrument: string) =>
        executionQuote(instrument),
      );
    const store = { getLatestPositiveSpreadQuote } as unknown as ProviderQuoteCandleStoreService;
    const updateProviderQuote = jest.fn();
    const getOpenPositions = jest.fn().mockResolvedValue([]);
    const adapters = brokerAdapters(getOpenPositions);
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      store,
      livePaper(updateProviderQuote),
      adapters,
    );

    await service.collectOnce(now);
    await service.collectOnce(new Date('2026-10-05T10:55:35.000Z'));

    expect(getLatestPositiveSpreadQuote).toHaveBeenCalledTimes(12);
    expect(updateProviderQuote).toHaveBeenCalledTimes(6);
    expect(adapters.getAdapterForConnection).toHaveBeenCalledTimes(2);
    expect(getOpenPositions).toHaveBeenCalledTimes(2);
  });

  it('fails closed on stale or insufficient positive-spread evidence but still checks open-position protection', async () => {
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [{ instrument: 'USDCAD' }] }),
    } as unknown as PaperBrokerStateService;
    const stale = executionQuote('USDCAD', '2026-10-05T10:53:00.000Z');
    stale.positiveSampleCount = 5;
    const store = {
      getLatestPositiveSpreadQuote: jest.fn().mockResolvedValue(stale),
    } as unknown as ProviderQuoteCandleStoreService;
    const updateProviderQuote = jest.fn();
    const getOpenPositions = jest.fn().mockResolvedValue([]);
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      store,
      livePaper(updateProviderQuote),
      brokerAdapters(getOpenPositions),
    );

    await service.collectOnce(new Date('2026-10-05T10:55:30.000Z'));

    expect(updateProviderQuote).not.toHaveBeenCalled();
    expect(getOpenPositions).toHaveBeenCalledTimes(1);
  });

  it('never lets a temporary adapter/bootstrap failure stop the bridge loop', async () => {
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [{ instrument: 'USDCAD' }] }),
    } as unknown as PaperBrokerStateService;
    const store = {
      getLatestPositiveSpreadQuote: jest
        .fn()
        .mockImplementation(async (_connectionId: string, instrument: string) =>
          executionQuote(instrument),
        ),
    } as unknown as ProviderQuoteCandleStoreService;
    const updateProviderQuote = jest.fn();
    const adapters = {
      getAdapterForConnection: jest.fn().mockReturnValue({
        getOpenPositions: jest.fn().mockRejectedValue(new Error('adapter not connected yet')),
      }),
    } as unknown as BrokerAdapterRegistry;
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      store,
      livePaper(updateProviderQuote),
      adapters,
    );

    await expect(
      service.collectOnce(new Date('2026-10-05T10:55:30.000Z')),
    ).resolves.toBeUndefined();
    expect(updateProviderQuote).toHaveBeenCalledTimes(6);
  });
});
