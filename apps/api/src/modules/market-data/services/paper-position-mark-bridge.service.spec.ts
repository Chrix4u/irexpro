import { ConfigService } from '@nestjs/config';
import { BrokerService } from '../../broker/broker.service';
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

  it('bridges the latest sampled broker quote into the PAPER mark cache once per new sample', async () => {
    const now = new Date('2026-10-05T10:55:30.000Z');
    const paperState = {
      load: jest.fn().mockResolvedValue({
        positions: [{ instrument: 'USDCAD' }, { instrument: 'USDCAD' }, { instrument: 'USDJPY' }],
      }),
    } as unknown as PaperBrokerStateService;
    const broker = {
      getStreamingPricesForInternalConnection: jest.fn().mockResolvedValue([]),
    } as unknown as BrokerService;
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
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      broker,
      store,
      livePaper,
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
  });

  it('prefers a fresh MetaApi streaming terminal-state quote and skips the sampled fallback', async () => {
    const now = new Date('2026-10-05T10:55:30.000Z');
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [{ instrument: 'USDJPY' }] }),
    } as unknown as PaperBrokerStateService;
    const broker = {
      getStreamingPricesForInternalConnection: jest.fn().mockResolvedValue([
        {
          instrument: 'USDJPY',
          bid: '158.281',
          ask: '158.283',
          spread: '0.002',
          timestamp: new Date('2026-10-05T10:55:29.000Z'),
        },
      ]),
    } as unknown as BrokerService;
    const store = {
      getLatestQuote: jest.fn(),
    } as unknown as ProviderQuoteCandleStoreService;
    const livePaper = {
      updateProviderQuote: jest.fn(),
    } as unknown as LivePaperMarketDataService;
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      broker,
      store,
      livePaper,
    );

    await service.collectOnce(now);

    expect(broker.getStreamingPricesForInternalConnection).toHaveBeenCalledWith('metaapi-1', [
      'USDJPY',
    ]);
    expect(store.getLatestQuote).not.toHaveBeenCalled();
    expect(livePaper.updateProviderQuote).toHaveBeenCalledWith(
      'USDJPY',
      '158.281',
      '158.283',
      new Date('2026-10-05T10:55:29.000Z'),
      'paper-1',
    );
  });

  it('ignores stale sampled quotes instead of presenting them as live marks', async () => {
    const paperState = {
      load: jest.fn().mockResolvedValue({ positions: [{ instrument: 'USDCAD' }] }),
    } as unknown as PaperBrokerStateService;
    const broker = {
      getStreamingPricesForInternalConnection: jest.fn().mockResolvedValue([]),
    } as unknown as BrokerService;
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
    const service = new PaperPositionMarkBridgeService(
      config(),
      paperState,
      broker,
      store,
      livePaper,
    );

    await service.collectOnce(new Date('2026-10-05T10:55:00.000Z'));

    expect(livePaper.updateProviderQuote).not.toHaveBeenCalled();
  });
});
