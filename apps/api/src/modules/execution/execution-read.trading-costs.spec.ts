import { Repository } from 'typeorm';
import { ExecutionReadService } from './execution-read.service';
import { Trade } from './entities/trade.entity';

describe('ExecutionReadService trading-cost accounting', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';

  it('separates gross realised P&L from commission/swap and reports true net after explicit costs', async () => {
    const pageQuery = {
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 2]),
    };
    const summaryQuery = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          accountCurrency: 'USD',
          totalTrades: '2',
          pnlTradeCount: '2',
          wins: '1',
          losses: '1',
          flats: '0',
          grossProfit: '500.25',
          grossLoss: '200.10',
          grossRealisedPnl: '300.15',
          totalCommission: '22.50',
          totalSwap: '-3.25',
          netRealisedPnl: '274.40',
          totalExplicitCosts: '25.75',
          averageWin: '500.25',
          averageLoss: '200.10',
          expectancyPerTrade: '137.20',
          largestWin: '500.25',
          largestLoss: '-200.10',
          averageHoldMinutes: '42.5',
        },
      ]),
    };
    const baseQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      clone: jest.fn().mockReturnValueOnce(pageQuery).mockReturnValueOnce(summaryQuery),
    };
    const repo = {
      createQueryBuilder: jest.fn().mockReturnValue(baseQuery),
    } as unknown as Repository<Trade>;
    const service = new ExecutionReadService(repo);

    const report = await service.listClosedTradeReport(USER_ID);
    const summary = report.summary as typeof report.summary & {
      grossRealisedPnl?: string | null;
      totalExplicitCosts?: string | null;
    };

    expect(summary.grossProfit).toBe('500.25');
    expect(summary.grossLoss).toBe('200.10');
    expect(summary.grossRealisedPnl).toBe('300.15');
    expect(summary.totalCommission).toBe('22.50');
    expect(summary.totalSwap).toBe('-3.25');
    expect(summary.totalExplicitCosts).toBe('25.75');
    expect(summary.netRealisedPnl).toBe('274.40');
    expect(summary.expectancyPerTrade).toBe('137.20');
  });
});
