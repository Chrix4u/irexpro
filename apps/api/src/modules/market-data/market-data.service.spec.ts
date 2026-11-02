import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { InternalOhlcvQueryDto } from './dto/internal-ohlcv-query.dto';
import { ProviderQuoteCandleStoreService } from './services/provider-quote-candle-store.service';
import { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';

describe('MarketDataService', () => {
  let service: MarketDataService;
  let brokerService: jest.Mocked<Partial<BrokerService>>;
  let auditService: jest.Mocked<Partial<AuditService>>;
  let providerQuoteStore: { getCandles: jest.Mock; getLatestPositiveSpreadQuote: jest.Mock };
  let livePaperMarketData: { isLiveConnection: jest.Mock };

  const query: InternalOhlcvQueryDto = {
    userId: '00000000-0000-0000-0000-000000000001',
    brokerConnectionId: '00000000-0000-0000-0000-000000000002',
    instrument: 'EURUSD',
    timeframe: 'H1',
    limit: 50,
  };

  const mockCandles = [
    {
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
      volume: '1000',
      tickVolume: '1000',
      tradeVolume: '4.25',
      spreadPoints: '13',
      priceDigits: 5,
      brokerTime: '2024-01-01 02:00:00.000',
    },
  ];

  beforeEach(async () => {
    brokerService = {
      findConnectionById: jest.fn().mockResolvedValue({
        id: query.brokerConnectionId,
        brokerId: 'metatrader5',
      } as never),
      getCurrentPriceForConnection: jest.fn().mockResolvedValue({
        instrument: 'EURUSD',
        bid: '1.10000',
        ask: '1.10010',
        spread: '0.00010',
        timestamp: new Date(),
      }),
      getOhlcvForConnection: jest.fn().mockResolvedValue(mockCandles),
    };
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    providerQuoteStore = {
      getCandles: jest.fn().mockResolvedValue([]),
      getLatestPositiveSpreadQuote: jest.fn().mockResolvedValue(null),
    };
    livePaperMarketData = {
      isLiveConnection: jest.fn().mockReturnValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketDataService,
        { provide: BrokerService, useValue: brokerService },
        { provide: AuditService, useValue: auditService },
        { provide: ProviderQuoteCandleStoreService, useValue: providerQuoteStore },
        { provide: LivePaperMarketDataService, useValue: livePaperMarketData },
      ],
    }).compile();

    service = module.get(MarketDataService);
  });

  it('returns normalized OHLCV candles with string prices', async () => {
    const result = await service.getInternalOhlcv(query);

    expect(result.instrument).toBe('EURUSD');
    expect(result.timeframe).toBe('H1');
    expect(result.source).toBe('broker');
    expect(result.count).toBe(1);
    expect(result.candles[0]).toMatchObject({
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
      volume: '1000',
      tickVolume: '1000',
      tradeVolume: '4.25',
      spreadPoints: '13',
      priceDigits: 5,
      brokerTime: '2024-01-01 02:00:00.000',
      instrument: 'EURUSD',
      timeframe: 'H1',
      source: 'broker',
    });
    expect(brokerService.getOhlcvForConnection).toHaveBeenCalledWith(
      query.userId,
      query.brokerConnectionId,
      'EURUSD',
      'H1',
      50,
      undefined,
    );
  });

  it('advances paper simulation exactly once and marks simulator provenance', async () => {
    (brokerService.findConnectionById as jest.Mock).mockResolvedValueOnce({
      id: query.brokerConnectionId,
      brokerId: 'paper-broker',
    });

    const result = await service.getInternalOhlcv({
      ...query,
      advanceSimulation: true,
    });

    expect(brokerService.getCurrentPriceForConnection).toHaveBeenCalledTimes(1);
    expect(brokerService.getCurrentPriceForConnection).toHaveBeenCalledWith(
      query.userId,
      query.brokerConnectionId,
      'EURUSD',
      { advanceSimulation: true },
    );
    expect(result.source).toBe('paper-broker');
    expect(result.candles[0]?.source).toBe('paper-broker');
  });

  it('marks live PAPER provider candles separately from deterministic simulator data', async () => {
    (brokerService.findConnectionById as jest.Mock).mockResolvedValueOnce({
      id: query.brokerConnectionId,
      brokerId: 'paper-broker',
    });
    livePaperMarketData.isLiveConnection.mockReturnValueOnce(true);

    const result = await service.getInternalOhlcv(query);

    expect(result.source).toBe('paper-live-provider');
    expect(result.candles[0]?.source).toBe('paper-live-provider');
  });

  it('does not advance provider-backed market data when simulation heartbeat is requested', async () => {
    await service.getInternalOhlcv({
      ...query,
      advanceSimulation: true,
    });

    expect(brokerService.getCurrentPriceForConnection).not.toHaveBeenCalled();
  });

  it('passes an ISO historical cursor to the broker service', async () => {
    const cursorQuery: InternalOhlcvQueryDto = {
      ...query,
      before: '2025-01-15T12:00:00.000Z',
    };

    await service.getInternalOhlcv(cursorQuery);

    expect(brokerService.getOhlcvForConnection).toHaveBeenCalledWith(
      query.userId,
      query.brokerConnectionId,
      'EURUSD',
      'H1',
      50,
      new Date('2025-01-15T12:00:00.000Z'),
    );
  });

  it('audits successful market-data requests', async () => {
    await service.getInternalOhlcv(query);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.MARKET_DATA_REQUESTED,
        actorUserId: query.userId,
        resourceId: query.brokerConnectionId,
      }),
    );
  });

  it('serves persisted cTrader broker-native candles before any on-demand broker history request', async () => {
    (brokerService.findConnectionById as jest.Mock).mockResolvedValueOnce({
      id: query.brokerConnectionId,
      brokerId: 'ctrader',
    });
    const localM1 = Array.from({ length: 25 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 9, 27, 20, index, 0)),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
      volume: '20',
      spreadClose: index === 0 ? '0.0000100000' : '0.0000200000',
    }));
    providerQuoteStore.getCandles.mockResolvedValueOnce(localM1);
    providerQuoteStore.getLatestPositiveSpreadQuote.mockResolvedValueOnce({
      instrument: 'EURUSD',
      bid: '1.10045',
      ask: '1.10055',
      spread: '0.00010',
      timestamp: new Date('2026-10-27T20:25:00.000Z'),
      positiveSampleCount: 20,
      latestPositiveSampleAt: new Date('2026-10-27T20:24:55.000Z'),
    });

    const result = await service.getInternalOhlcv({
      ...query,
      timeframe: 'M1',
      limit: 100,
    });

    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(providerQuoteStore.getCandles).toHaveBeenCalledWith(
      query.brokerConnectionId,
      'EURUSD',
      'M1',
      100,
    );
    expect(result.source).toBe('broker');
    expect(result.count).toBe(25);
    expect(result.candles[0]).toMatchObject({
      source: 'broker',
      spreadPoints: '100000',
      priceDigits: 10,
    });
    expect(result.candles[1]).toMatchObject({
      source: 'broker',
      spreadPoints: '200000',
      priceDigits: 10,
    });
    expect(result.candles.at(-1)).toMatchObject({
      source: 'broker',
      spreadPoints: '1000000',
      priceDigits: 10,
    });
  });

  it('does not fabricate historical cTrader spread metadata for provider-native backfill rows', async () => {
    (brokerService.findConnectionById as jest.Mock).mockResolvedValueOnce({
      id: query.brokerConnectionId,
      brokerId: 'ctrader',
    });
    const localM1 = Array.from({ length: 25 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 9, 27, 21, index, 0)),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
      volume: '20',
      spreadClose: null,
    }));
    providerQuoteStore.getCandles.mockResolvedValueOnce(localM1);
    providerQuoteStore.getLatestPositiveSpreadQuote.mockResolvedValueOnce({
      instrument: 'EURUSD',
      bid: '1.10045',
      ask: '1.10055',
      spread: '0.00010',
      timestamp: new Date('2026-10-27T21:25:00.000Z'),
      positiveSampleCount: 20,
      latestPositiveSampleAt: new Date('2026-10-27T21:24:55.000Z'),
    });

    const result = await service.getInternalOhlcv({
      ...query,
      timeframe: 'M1',
      limit: 100,
    });

    expect(result.candles[0]).toMatchObject({
      source: 'broker',
      spreadPoints: undefined,
      priceDigits: undefined,
    });
    expect(result.candles.at(-1)).toMatchObject({
      source: 'broker',
      spreadPoints: '1000000',
      priceDigits: 10,
    });
  });

  it('fails closed for cTrader AI OHLCV when the persisted broker-native store is too sparse instead of bursting broker history', async () => {
    (brokerService.findConnectionById as jest.Mock).mockResolvedValueOnce({
      id: query.brokerConnectionId,
      brokerId: 'ctrader',
    });
    providerQuoteStore.getCandles.mockResolvedValueOnce(mockCandles.slice(0, 1));

    await expect(
      service.getInternalOhlcv({ ...query, timeframe: 'M15', limit: 100 }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
  });

  it('falls back to sampled provider candles when MetaApi historical data is unavailable', async () => {
    (brokerService.getOhlcvForConnection as jest.Mock).mockRejectedValueOnce(
      new Error('To allow market data access please top up your account.'),
    );
    providerQuoteStore.getCandles.mockResolvedValueOnce(mockCandles);

    const result = await service.getInternalOhlcv(query);

    expect(result.source).toBe('provider-sampled-local');
    expect(result.count).toBe(1);
    expect(result.candles[0]?.source).toBe('provider-sampled-local');
    expect(providerQuoteStore.getCandles).toHaveBeenCalledWith(
      query.brokerConnectionId,
      'EURUSD',
      'H1',
      50,
    );
  });

  it('rethrows ForbiddenException from broker service', async () => {
    (brokerService.getOhlcvForConnection as jest.Mock).mockRejectedValue(
      new ForbiddenException('Broker connection is not active'),
    );

    await expect(service.getInternalOhlcv(query)).rejects.toThrow(ForbiddenException);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.MARKET_DATA_REQUEST_FAILED,
      }),
    );
  });

  it('maps broker failures to safe ServiceUnavailableException', async () => {
    (brokerService.getOhlcvForConnection as jest.Mock).mockRejectedValue(
      new Error('MetaAPI timeout'),
    );

    await expect(service.getInternalOhlcv(query)).rejects.toThrow(ServiceUnavailableException);
    await expect(service.getInternalOhlcv(query)).rejects.toMatchObject({
      response: {
        code: 'MARKET_DATA_UNAVAILABLE',
      },
    });
  });
});
