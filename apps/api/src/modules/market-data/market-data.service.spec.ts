import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { InternalOhlcvQueryDto } from './dto/internal-ohlcv-query.dto';

describe('MarketDataService', () => {
  let service: MarketDataService;
  let brokerService: jest.Mocked<Partial<BrokerService>>;
  let auditService: jest.Mocked<Partial<AuditService>>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketDataService,
        { provide: BrokerService, useValue: brokerService },
        { provide: AuditService, useValue: auditService },
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
    );
    expect(result.source).toBe('paper-broker');
    expect(result.candles[0]?.source).toBe('paper-broker');
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
