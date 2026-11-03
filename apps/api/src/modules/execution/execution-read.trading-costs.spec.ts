import { Repository } from 'typeorm';
import { ExecutionReadService } from './execution-read.service';
import { Trade } from './entities/trade.entity';

describe('ExecutionReadService trading-cost accounting', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';

  it('separates gross realised P&L from explicit costs and reports spread telemetry without double-deducting it', async () => {
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
          totalEstimatedSpreadCost: '7.50',
          spreadCostEstimatedTradeCount: '1',
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
      totalEstimatedSpreadCost?: string | null;
      spreadCostEstimatedTradeCount?: number;
    };

    expect(summaryQuery.addSelect).toHaveBeenCalledWith(
      expect.stringContaining('SUM(trade.realisedPnl)'),
      'grossRealisedPnl',
    );
    expect(summaryQuery.addSelect).toHaveBeenCalledWith(
      expect.stringMatching(/SUM\(ABS\(trade\.commission\)\)/),
      'totalCommission',
    );
    expect(summaryQuery.addSelect).toHaveBeenCalledWith(
      expect.stringMatching(
        /SUM\(trade\.realisedPnl\).*SUM\(ABS\(trade\.commission\)\).*SUM\(trade\.swap\)/,
      ),
      'netRealisedPnl',
    );
    expect(summaryQuery.addSelect).toHaveBeenCalledWith(
      expect.stringMatching(/SUM\(ABS\(trade\.commission\)\).*SUM\(trade\.swap\)/),
      'totalExplicitCosts',
    );
    expect(summaryQuery.addSelect).toHaveBeenCalledWith(
      expect.stringMatching(/SUM\(trade\.estimatedSpreadCost\)/),
      'totalEstimatedSpreadCost',
    );
    expect(summaryQuery.addSelect).toHaveBeenCalledWith(
      expect.stringMatching(/trade\.estimatedSpreadCost IS NOT NULL/),
      'spreadCostEstimatedTradeCount',
    );

    expect(summary.grossProfit).toBe('500.25');
    expect(summary.grossLoss).toBe('200.10');
    expect(summary.grossRealisedPnl).toBe('300.15');
    expect(summary.totalCommission).toBe('22.50');
    expect(summary.totalSwap).toBe('-3.25');
    expect(summary.totalExplicitCosts).toBe('25.75');
    expect(summary.totalEstimatedSpreadCost).toBe('7.50');
    expect(summary.spreadCostEstimatedTradeCount).toBe(1);
    // The spread estimate is informational: realised P&L already contains
    // bid/ask execution impact, so net and expectancy must stay unchanged.
    expect(summary.netRealisedPnl).toBe('274.40');
    expect(summary.expectancyPerTrade).toBe('137.20');
  });

  it('never raw-sums spread money across different account currencies', async () => {
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
          accountCurrency: 'EUR',
          totalTrades: '1',
          pnlTradeCount: '1',
          wins: '1',
          losses: '0',
          flats: '0',
          grossProfit: '10',
          grossLoss: '0',
          grossRealisedPnl: '10',
          totalCommission: '1',
          totalSwap: '0',
          netRealisedPnl: '9',
          totalExplicitCosts: '1',
          totalEstimatedSpreadCost: '2.50',
          spreadCostEstimatedTradeCount: '1',
          averageWin: '10',
          averageLoss: null,
          expectancyPerTrade: '9',
          largestWin: '10',
          largestLoss: null,
          averageHoldMinutes: '5',
        },
        {
          accountCurrency: 'USD',
          totalTrades: '1',
          pnlTradeCount: '1',
          wins: '1',
          losses: '0',
          flats: '0',
          grossProfit: '20',
          grossLoss: '0',
          grossRealisedPnl: '20',
          totalCommission: '2',
          totalSwap: '0',
          netRealisedPnl: '18',
          totalExplicitCosts: '2',
          totalEstimatedSpreadCost: '4.00',
          spreadCostEstimatedTradeCount: '1',
          averageWin: '20',
          averageLoss: null,
          expectancyPerTrade: '18',
          largestWin: '20',
          largestLoss: null,
          averageHoldMinutes: '5',
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

    expect(report.summary.accountCurrency).toBeNull();
    expect(report.summary.totalEstimatedSpreadCost).toBeNull();
    expect(report.summary.spreadCostEstimatedTradeCount).toBe(2);
    expect(report.summary.currencyBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountCurrency: 'EUR',
          totalEstimatedSpreadCost: '2.50',
          spreadCostEstimatedTradeCount: 1,
        }),
        expect.objectContaining({
          accountCurrency: 'USD',
          totalEstimatedSpreadCost: '4.00',
          spreadCostEstimatedTradeCount: 1,
        }),
      ]),
    );
  });
});
