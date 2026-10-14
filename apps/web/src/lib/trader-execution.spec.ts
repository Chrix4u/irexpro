import { isTradeExecutionView } from './trader-execution';

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
