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

  function brokerAdapters(getOpenPositions = jest.fn().mockResolvedValue([])): BrokerAdapterRegistry {
    return {
      getAdapterForConnection: jest.fn().mockReturnValue({ getOpenPositions }),
    } as unknown as BrokerAdapterRegistry;
  }

  it('bridges each new sampled broker quote and runs server-side PAPER protection heartbeat', async () => {
    const now = new Date('2026-10-05T10:55:30.000Z');
    const paperState = {
      load: jest.fn().mockResolvedValue({
        positions: [{ instrument: 'USDCAD' }, { instrument: 'USDCAD' }, { instrument: 'USDJPY' }],
      }),
    } as unknown as PaperBrokerStateService;
    const store = {
      getLatestQuote: jest
        .fn()
        .mockImplementation(async (_connectionId: string, instrument: string) => ({
          instrument,
          bid: instrument === 'USDCAD' ? '1.42480' : '149.120',
          ask: instrument === 'USDCAD' ? '1.42492' : '149.130',
          spread: instrument === 'USDCAD' ? '0.00012' : '0.010',
          timestamp: new Date('2026-10-05T10:55:20.000Z'),
        })),
    } as unknown as ProviderQuoteCandleStoreService;
    const livePaper = {
      updateProviderQuote: jest.fn(),
    } as unknown as LivePaperMarketDataService;
    const getOpenPositions = jest.fn().mockResolvedValue([]);
    const adapters = brokerAdapters(getOpenPositions);
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      store,
      livePaper,
      adapters,
    );

    await service.collectOnce(now);
    await service.collectOnce(new Date('2026-10-05T10:55:35.000Z'));

    expect((store.getLatestQuote as jest.Mock).mock.calls).toEqual([
      ['metaapi-1', 'USDCAD'],
      ['metaapi-1', 'USDJPY'],
      ['metaapi-1', 'USDCAD'],
      ['metaapi-1', 'USDJPY'],
    ]);
    expect(livePaper.updateProviderQuote).toHaveBeenCalledTimes(2);
    expect(livePaper.updateProviderQuote).toHaveBeenCalledWith(
      'USDCAD',
      '1.42480',
      '1.42492',
      new Date('2026-10-05T10:55:20.000Z'),
      'paper-1',
    );
    expect(adapters.getAdapterForConnection).toHaveBeenCalledTimes(2);
    expect(adapters.getAdapterForConnection).toHaveBeenCalledWith('paper-1', 'paper-broker');
    expect(getOpenPositions).toHaveBeenCalledTimes(2);
  });

  it('ignores stale sampled quotes but still invokes protection against any fresh cached mark', async () => {
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [{ instrument: 'USDCAD' }] }),
    } as unknown as PaperBrokerStateService;
    const store = {
      getLatestQuote: jest.fn().mockResolvedValue({
        instrument: 'USDCAD',
        bid: '1.42480',
        ask: '1.42492',
        spread: '0.00012',
        timestamp: new Date('2026-10-05T10:53:00.000Z'),
      }),
    } as unknown as ProviderQuoteCandleStoreService;
    const livePaper = {
      updateProviderQuote: jest.fn(),
    } as unknown as LivePaperMarketDataService;
    const getOpenPositions = jest.fn().mockResolvedValue([]);
    const adapters = brokerAdapters(getOpenPositions);
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      store,
      livePaper,
      adapters,
    );

    await service.collectOnce(new Date('2026-10-05T10:55:00.000Z'));

    expect(livePaper.updateProviderQuote).not.toHaveBeenCalled();
    expect(getOpenPositions).toHaveBeenCalledTimes(1);
  });

  it('never lets a temporary adapter/bootstrap failure stop the bridge loop', async () => {
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [{ instrument: 'USDCAD' }] }),
    } as unknown as PaperBrokerStateService;
    const store = {
      getLatestQuote: jest.fn().mockResolvedValue({
        instrument: 'USDCAD',
        bid: '1.42480',
        ask: '1.42492',
        spread: '0.00012',
        timestamp: new Date('2026-10-05T10:55:20.000Z'),
      }),
    } as unknown as ProviderQuoteCandleStoreService;
    const livePaper = {
      updateProviderQuote: jest.fn(),
    } as unknown as LivePaperMarketDataService;
    const adapters = {
      getAdapterForConnection: jest.fn().mockReturnValue({
        getOpenPositions: jest.fn().mockRejectedValue(new Error('adapter not connected yet')),
      }),
    } as unknown as BrokerAdapterRegistry;
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      store,
      livePaper,
      adapters,
    );

    await expect(service.collectOnce(new Date('2026-10-05T10:55:30.000Z'))).resolves.toBeUndefined();
    expect(livePaper.updateProviderQuote).toHaveBeenCalledTimes(1);
  });
});
