import {
  isTradeExecutionView,
  resolveTraderExecutionRefresh,
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

const OPEN_TRADE = {
  ...CLOSED_TRADE,
  id: '22222222-2222-4222-8222-222222222222',
  instrument: 'AUDUSD',
  direction: 'SELL',
  lotSize: '0.1900',
  status: 'OPEN',
  exitPrice: null,
  realisedPnl: null,
  closeReason: null,
  closedAt: null,
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

  it('keeps last-known-good open positions when only the open feed fails', async () => {
    const previous = {
      openPositions: [OPEN_TRADE],
      recentExecutions: [OPEN_TRADE],
      closedExecutions: [CLOSED_TRADE],
      degradedFeeds: [],
    };

    const snapshot = await resolveTraderExecutionRefresh(
      {
        openPositions: Promise.reject(new Error('temporary telemetry failure')),
        recentExecutions: Promise.resolve([CLOSED_TRADE]),
        closedExecutions: Promise.resolve([CLOSED_TRADE]),
      },
      previous,
    );

    expect(snapshot.openPositions).toEqual(previous.openPositions);
    expect(snapshot.recentExecutions).toEqual([CLOSED_TRADE]);
    expect(snapshot.closedExecutions).toEqual([CLOSED_TRADE]);
    expect(snapshot.degradedFeeds).toEqual(['openPositions']);
  });

  it('keeps live positions visible when only recent activity fails', async () => {
    const snapshot = await resolveTraderExecutionRefresh(
      {
        openPositions: Promise.resolve([OPEN_TRADE]),
        recentExecutions: Promise.reject(new Error('temporary history failure')),
        closedExecutions: Promise.resolve([CLOSED_TRADE]),
      },
      null,
    );

    expect(snapshot.openPositions).toEqual([OPEN_TRADE]);
    expect(snapshot.recentExecutions).toEqual([]);
    expect(snapshot.closedExecutions).toEqual([CLOSED_TRADE]);
    expect(snapshot.degradedFeeds).toEqual(['recentExecutions']);
  });

  it('fails closed only when every execution feed is unavailable and there is no prior snapshot', async () => {
    await expect(
      resolveTraderExecutionRefresh(
        {
          openPositions: Promise.reject(new Error('open failed')),
          recentExecutions: Promise.reject(new Error('recent failed')),
          closedExecutions: Promise.reject(new Error('closed failed')),
        },
        null,
      ),
    ).rejects.toThrow('Execution feeds unavailable');
  });
});
