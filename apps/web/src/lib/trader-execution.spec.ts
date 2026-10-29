import {
  isTradeExecutionView,
  loadClosedTradeReport,
  summarizeRealisedExecutionWindow,
  summarizeRecentExecutionActivity,
} from './trader-execution';

const CLOSED_TRADE = {
  id: '11111111-1111-4111-8111-111111111111',
  instrument: 'USDJPY',
  direction: 'BUY',
  lotSize: '0.1000',
  requestedEntryPrice: '149.10000000',
  fillPrice: '149.10000000',
  stopLoss: '148.90000000',
  takeProfit: '149.50000000',
  trailingStopPips: null,
  status: 'CLOSED',
  exitPrice: '149.20000000',
  accountCurrency: 'USD',
  realisedPnl: '6.70',
  commission: '0.00',
  swap: '0.00',
  executionReasonCode: null,
  closeReason: 'MANUAL_CLOSE',
  openedAt: '2026-10-04T18:00:00.000Z',
  closedAt: '2026-10-04T19:00:00.000Z',
  createdAt: '2026-10-04T18:00:00.000Z',
  updatedAt: '2026-10-04T19:00:00.000Z',
};

describe('trader execution runtime contract', () => {
  it('accepts STRATEGY_CUTOVER history emitted by the execution API', () => {
    expect(
      isTradeExecutionView({
        ...CLOSED_TRADE,
        closeReason: 'STRATEGY_CUTOVER',
      }),
    ).toBe(true);
  });

  it('accepts PROFIT_PROTECTION history emitted by the execution API', () => {
    expect(
      isTradeExecutionView({
        ...CLOSED_TRADE,
        closeReason: 'PROFIT_PROTECTION',
      }),
    ).toBe(true);
  });

  it('still rejects unknown close reasons', () => {
    expect(
      isTradeExecutionView({
        ...CLOSED_TRADE,
        closeReason: 'UNRECOGNIZED_CLOSE_REASON',
      }),
    ).toBe(false);
  });
});

import { api } from './api';
import { loadTraderExecutionSnapshot } from './trader-execution';

describe('trader execution refresh resilience', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('scopes all execution reads to the selected broker account', async () => {
    const brokerConnectionId = 'ctrader/demo account';
    const encodedBrokerId = encodeURIComponent(brokerConnectionId);
    const request = jest.spyOn(api, 'request').mockResolvedValue([]);

    await loadTraderExecutionSnapshot(brokerConnectionId);

    expect(request).toHaveBeenCalledWith(
      `/execution/positions/open?brokerConnectionId=${encodedBrokerId}`,
    );
    expect(request).toHaveBeenCalledWith(
      `/execution/trades/recent?limit=100&brokerConnectionId=${encodedBrokerId}`,
    );
    expect(request).toHaveBeenCalledWith(
      `/execution/trades/closed?limit=50&brokerConnectionId=${encodedBrokerId}`,
    );
  });

  it('requests the paginated closed-trade report with the selected filters', async () => {
    const request = jest.spyOn(api, 'request').mockResolvedValue({
      trades: [],
      page: 2,
      pageSize: 25,
      total: 0,
      totalPages: 0,
      summary: {
        totalTrades: 0,
        pnlTradeCount: 0,
        unresolvedPnlCount: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        winRate: null,
        accountCurrency: null,
        grossProfit: null,
        grossLoss: null,
        netRealisedPnl: null,
        averageWin: null,
        averageLoss: null,
        expectancyPerTrade: null,
        profitFactor: null,
        largestWin: null,
        largestLoss: null,
        totalCommission: null,
        totalSwap: null,
        averageHoldMinutes: null,
        currencyBreakdown: [],
      },
    });

    await loadClosedTradeReport({
      page: 2,
      pageSize: 25,
      brokerConnectionId: 'ctrader/demo account',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-29T23:59:59.999Z',
      instrument: 'USDJPY',
      direction: 'SELL',
      outcome: 'LOSS',
      closeReason: 'STOP_LOSS_HIT',
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [path] = request.mock.calls[0];
    expect(path).toContain('/execution/trades/closed/report?');
    expect(path).toContain('page=2');
    expect(path).toContain('pageSize=25');
    expect(path).toContain('brokerConnectionId=ctrader%2Fdemo+account');
    expect(path).toContain('from=2026-10-01T00%3A00%3A00.000Z');
    expect(path).toContain('to=2026-10-29T23%3A59%3A59.999Z');
    expect(path).toContain('instrument=USDJPY');
    expect(path).toContain('direction=SELL');
    expect(path).toContain('outcome=LOSS');
    expect(path).toContain('closeReason=STOP_LOSS_HIT');
  });

  it('keeps recent and closed executions visible when the open-position read fails', async () => {
    const request = jest.spyOn(api, 'request').mockImplementation(async (path: string) => {
      if (path === '/execution/positions/open') {
        throw new Error('temporary open-position read failure');
      }
      if (path === '/execution/trades/recent?limit=100') return [CLOSED_TRADE];
      if (path === '/execution/trades/closed?limit=50') return [CLOSED_TRADE];
      throw new Error(`unexpected path ${path}`);
    });

    const snapshot = await loadTraderExecutionSnapshot();

    expect(request).toHaveBeenCalledTimes(3);
    expect(snapshot.recentExecutions).toEqual([CLOSED_TRADE]);
    expect(snapshot.closedExecutions).toEqual([CLOSED_TRADE]);
    expect(snapshot.openPositions).toEqual([]);
    expect(snapshot.degradedFeeds).toEqual(['OPEN_POSITIONS']);
  });

  it('reconstructs closed executions from the recent feed when the closed-history read fails', async () => {
    jest.spyOn(api, 'request').mockImplementation(async (path: string) => {
      if (path === '/execution/positions/open') return [];
      if (path === '/execution/trades/recent?limit=100') return [CLOSED_TRADE];
      if (path === '/execution/trades/closed?limit=50') {
        throw new Error('temporary closed-history read failure');
      }
      throw new Error(`unexpected path ${path}`);
    });

    const snapshot = await loadTraderExecutionSnapshot();

    expect(snapshot.closedExecutions).toEqual([CLOSED_TRADE]);
    expect(snapshot.recentExecutions).toEqual([CLOSED_TRADE]);
    expect(snapshot.degradedFeeds).toEqual(['CLOSED_EXECUTIONS']);
  });
});


describe('recent execution visibility summary', () => {
  it('summarizes the last 24 hours so a flat account is not mistaken for an idle engine', () => {
    const referenceTime = new Date('2026-10-15T15:16:00.000Z');
    const trades = [
      { ...CLOSED_TRADE, id: 'a', realisedPnl: '16.69', openedAt: '2026-10-15T13:50:08.000Z', closedAt: '2026-10-15T14:05:00.000Z', createdAt: '2026-10-15T13:50:08.000Z' },
      { ...CLOSED_TRADE, id: 'b', realisedPnl: '-9.76', openedAt: '2026-10-15T13:07:25.000Z', closedAt: '2026-10-15T13:55:00.000Z', createdAt: '2026-10-15T13:07:25.000Z' },
      { ...CLOSED_TRADE, id: 'old', realisedPnl: '99.00', openedAt: '2026-10-14T14:00:00.000Z', closedAt: '2026-10-14T14:05:00.000Z', createdAt: '2026-10-14T14:00:00.000Z' },
    ];

    const summary = summarizeRecentExecutionActivity(trades as any, referenceTime);

    expect(summary).toEqual({
      executionCount: 2,
      realisedTradeCount: 2,
      wins: 1,
      losses: 1,
      flats: 0,
      netRealisedPnl: '6.93',
      grossProfit: '16.69',
      grossLoss: '9.76',
      averageWin: '16.69',
      averageLoss: '9.76',
      expectancyPerTrade: '3.47',
      profitFactor: expect.any(Number),
      accountCurrency: 'USD',
      latestOpenedAt: '2026-10-15T13:50:08.000Z',
    });
    expect(summary.profitFactor).toBeCloseTo(16.69 / 9.76, 8);
  });

  it('uses close time for trailing 24-hour realised P&L even when the trade opened earlier', () => {
    const referenceTime = new Date('2026-10-15T15:16:00.000Z');
    const trades = [
      {
        ...CLOSED_TRADE,
        id: 'long-running-loss',
        realisedPnl: '-50.00',
        openedAt: '2026-10-14T12:00:00.000Z',
        closedAt: '2026-10-15T15:00:00.000Z',
        createdAt: '2026-10-14T12:00:00.000Z',
        updatedAt: '2026-10-15T15:00:00.000Z',
      },
      {
        ...CLOSED_TRADE,
        id: 'old-closed-win',
        realisedPnl: '99.00',
        openedAt: '2026-10-14T10:00:00.000Z',
        closedAt: '2026-10-14T11:00:00.000Z',
        createdAt: '2026-10-14T10:00:00.000Z',
        updatedAt: '2026-10-14T11:00:00.000Z',
      },
    ];

    const summary = summarizeRecentExecutionActivity(trades as any, referenceTime);

    expect(summary.executionCount).toBe(0);
    expect(summary.realisedTradeCount).toBe(1);
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.netRealisedPnl).toBe('-50');
  });

  it('summarizes the same realised closed-trade window used by the profit chart', () => {
    const trades = [
      { ...CLOSED_TRADE, id: 'older-win', realisedPnl: '20.00', closedAt: '2026-10-15T11:00:00.000Z', updatedAt: '2026-10-15T11:00:00.000Z' },
      { ...CLOSED_TRADE, id: 'win-1', realisedPnl: '10.00', closedAt: '2026-10-15T12:10:00.000Z', updatedAt: '2026-10-15T12:10:00.000Z' },
      { ...CLOSED_TRADE, id: 'loss-1', realisedPnl: '-5.00', closedAt: '2026-10-15T13:10:00.000Z', updatedAt: '2026-10-15T13:10:00.000Z' },
      { ...CLOSED_TRADE, id: 'win-2', realisedPnl: '5.00', closedAt: '2026-10-15T14:10:00.000Z', updatedAt: '2026-10-15T14:10:00.000Z' },
    ];

    expect(summarizeRealisedExecutionWindow(trades as any, 3)).toEqual({
      tradeCount: 3,
      wins: 2,
      losses: 1,
      flats: 0,
      winRate: 2 / 3,
    });
  });
});
