import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
    },
  ];

  beforeEach(async () => {
    brokerService = {
      getOhlcvForConnection: jest.fn().mockResolvedValue(mockCandles),
      getHistoricalOhlcvForConnection: jest.fn().mockResolvedValue(mockCandles),
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
    );
  });

  it('routes endTime requests through the cursor-based historical capability', async () => {
    const endTime = '2025-01-15T12:00:00.000Z';

    const result = await service.getInternalOhlcv({ ...query, endTime });

    expect(result.count).toBe(1);
    expect(brokerService.getHistoricalOhlcvForConnection).toHaveBeenCalledWith(
      query.userId,
      query.brokerConnectionId,
      'EURUSD',
      'H1',
      new Date(endTime),
      50,
    );
    expect(brokerService.getOhlcvForConnection).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ endTime }),
      }),
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

  it('rethrows unsupported historical capability as BadRequestException', async () => {
    (brokerService.getHistoricalOhlcvForConnection as jest.Mock).mockRejectedValue(
      new BadRequestException('Historical OHLCV not supported'),
    );

    await expect(
      service.getInternalOhlcv({
        ...query,
        endTime: '2025-01-15T12:00:00.000Z',
      }),
    ).rejects.toThrow(BadRequestException);
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
