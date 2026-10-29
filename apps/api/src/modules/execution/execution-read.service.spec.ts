import { Repository } from 'typeorm';
import { ExecutionReadService } from './execution-read.service';
import { Trade, TradeStatus } from './entities/trade.entity';

describe('ExecutionReadService', () => {
  let service: ExecutionReadService;
  let tradeRepo: Pick<Repository<Trade>, 'find'> & { find: jest.Mock };

  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const BROKER_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    tradeRepo = { find: jest.fn().mockResolvedValue([]) };
    service = new ExecutionReadService(tradeRepo as unknown as Repository<Trade>);
  });

  it('scopes open positions to the authenticated user and OPEN status', async () => {
    await service.listOpenPositions(USER_ID);

    expect(tradeRepo.find).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: TradeStatus.OPEN },
      order: { openedAt: 'DESC', createdAt: 'DESC' },
      take: 100,
    });
  });

  it('scopes recent executions to the authenticated user', async () => {
    await service.listRecentExecutions(USER_ID, 25);

    expect(tradeRepo.find).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { createdAt: 'DESC' },
      take: 25,
    });
  });

  it('scopes all trader reads to the selected broker connection when supplied', async () => {
    await service.listOpenPositions(USER_ID, BROKER_CONNECTION_ID);
    expect(tradeRepo.find).toHaveBeenLastCalledWith({
      where: {
        userId: USER_ID,
        brokerConnectionId: BROKER_CONNECTION_ID,
        status: TradeStatus.OPEN,
      },
      order: { openedAt: 'DESC', createdAt: 'DESC' },
      take: 100,
    });

    await service.listRecentExecutions(USER_ID, 25, BROKER_CONNECTION_ID);
    expect(tradeRepo.find).toHaveBeenLastCalledWith({
      where: { userId: USER_ID, brokerConnectionId: BROKER_CONNECTION_ID },
      order: { createdAt: 'DESC' },
      take: 25,
    });

    await service.listClosedExecutions(USER_ID, 25, BROKER_CONNECTION_ID);
    expect(tradeRepo.find).toHaveBeenLastCalledWith({
      where: {
        userId: USER_ID,
        brokerConnectionId: BROKER_CONNECTION_ID,
        status: TradeStatus.CLOSED,
      },
      order: { closedAt: 'DESC', createdAt: 'DESC' },
      take: 25,
    });
  });

  it('clamps recent execution limits to 1..100', async () => {
    await service.listRecentExecutions(USER_ID, 999);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 100 }));

    await service.listRecentExecutions(USER_ID, -5);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }));
  });

  it('keeps closed trade history independent from rejected activity noise', async () => {
    await service.listClosedExecutions(USER_ID, 25);

    expect(tradeRepo.find).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: TradeStatus.CLOSED },
      order: { closedAt: 'DESC', createdAt: 'DESC' },
      take: 25,
    });
  });

  it('clamps closed trade history limits to 1..100', async () => {
    await service.listClosedExecutions(USER_ID, 999);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 100 }));

    await service.listClosedExecutions(USER_ID, -5);
    expect(tradeRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }));
  });

  it('returns a paginated closed-trade report with whole-filter realised totals', async () => {
    const trade = new Trade();
    trade.id = '33333333-3333-4333-8333-333333333333';

    const pageQuery = {
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[trade], 51]),
    };
    const summaryQuery = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          accountCurrency: 'USD',
          totalTrades: '51',
          pnlTradeCount: '50',
          wins: '30',
          losses: '19',
          flats: '1',
          grossProfit: '500.25',
          grossLoss: '200.10',
          netRealisedPnl: '300.15',
          averageWin: '16.675',
          averageLoss: '10.53157895',
          expectancyPerTrade: '6.003',
          largestWin: '80.00',
          largestLoss: '-40.00',
          totalCommission: '22.50',
          totalSwap: '-3.25',
          averageHoldMinutes: '42.5',
        },
      ]),
    };
    const baseQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      clone: jest.fn()
        .mockReturnValueOnce(pageQuery)
        .mockReturnValueOnce(summaryQuery),
    };
    const reportRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(baseQuery),
    } as unknown as Repository<Trade>;
    const reportService = new ExecutionReadService(reportRepo);

    const result = await reportService.listClosedTradeReport(USER_ID, {
      page: 2,
      pageSize: 25,
      brokerConnectionId: BROKER_CONNECTION_ID,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-29T23:59:59.999Z',
      instrument: 'usdjpy',
      direction: 'SELL',
      outcome: 'LOSS',
      closeReason: 'STOP_LOSS_HIT',
    });

    expect(baseQuery.where).toHaveBeenCalledWith('trade.userId = :userId', { userId: USER_ID });
    expect(baseQuery.andWhere).toHaveBeenCalledWith('trade.status = :status', {
      status: TradeStatus.CLOSED,
    });
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'trade.brokerConnectionId = :brokerConnectionId',
      { brokerConnectionId: BROKER_CONNECTION_ID },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith('trade.closedAt >= :from', {
      from: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(baseQuery.andWhere).toHaveBeenCalledWith('trade.closedAt <= :to', {
      to: new Date('2026-10-29T23:59:59.999Z'),
    });
    expect(baseQuery.andWhere).toHaveBeenCalledWith('trade.instrument = :instrument', {
      instrument: 'USDJPY',
    });
    expect(baseQuery.andWhere).toHaveBeenCalledWith('trade.direction = :direction', {
      direction: 'SELL',
    });
    expect(baseQuery.andWhere).toHaveBeenCalledWith('trade.realisedPnl < 0');
    expect(baseQuery.andWhere).toHaveBeenCalledWith('trade.closeReason = :closeReason', {
      closeReason: 'STOP_LOSS_HIT',
    });
    expect(pageQuery.skip).toHaveBeenCalledWith(25);
    expect(pageQuery.take).toHaveBeenCalledWith(25);
    expect(result).toMatchObject({
      page: 2,
      pageSize: 25,
      total: 51,
      totalPages: 3,
      trades: [trade],
      summary: {
        totalTrades: 51,
        pnlTradeCount: 50,
        unresolvedPnlCount: 1,
        wins: 30,
        losses: 19,
        flats: 1,
        winRate: 0.6,
        accountCurrency: 'USD',
        grossProfit: '500.25',
        grossLoss: '200.10',
        netRealisedPnl: '300.15',
        largestWin: '80.00',
        largestLoss: '-40.00',
        totalCommission: '22.50',
        totalSwap: '-3.25',
        averageHoldMinutes: 42.5,
      },
    });
    expect(result.summary.profitFactor).toBeCloseTo(500.25 / 200.10, 8);
    expect(result.summary.currencyBreakdown).toHaveLength(1);
  });

  it('rejects an inverted closed-trade report date range', async () => {
    await expect(
      service.listClosedTradeReport(USER_ID, {
        from: '2026-10-30T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('from must be on or before to');
  });
});
