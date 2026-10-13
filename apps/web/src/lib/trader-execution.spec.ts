const mockExecutionApi = {
  listOpenPositions: jest.fn(),
  listRecentExecutions: jest.fn(),
  listClosedExecutions: jest.fn(),
};

jest.mock('@irexpro/api-client/execution', () => ({
  createExecutionApi: () => mockExecutionApi,
}));

import {
  isTradeExecutionView,
  loadTraderExecutionSnapshot,
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
  status: 'OPEN',
  exitPrice: null,
  realisedPnl: null,
  closeReason: null,
  closedAt: null,
};

describe('trader execution runtime contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it('preserves valid execution history when one stale row fails validation', async () => {
    const staleLegacyRow = {
      ...CLOSED_TRADE,
      id: '33333333-3333-4333-8333-333333333333',
      closeReason: 'LEGACY_UNKNOWN_CLOSE_REASON',
    };

    mockExecutionApi.listOpenPositions.mockResolvedValue([]);
    mockExecutionApi.listRecentExecutions.mockResolvedValue([
      CLOSED_TRADE,
      staleLegacyRow,
    ]);
    mockExecutionApi.listClosedExecutions.mockResolvedValue([
      CLOSED_TRADE,
      staleLegacyRow,
    ]);

    await expect(loadTraderExecutionSnapshot()).resolves.toEqual({
      openPositions: [],
      recentExecutions: [CLOSED_TRADE],
      closedExecutions: [CLOSED_TRADE],
    });
  });

  it('preserves valid open positions when one stale open-position row fails validation', async () => {
    const staleLegacyOpenRow = {
      ...OPEN_TRADE,
      id: '44444444-4444-4444-8444-444444444444',
      brokerConnectionId: 'must-never-reach-the-frontend',
    };

    mockExecutionApi.listOpenPositions.mockResolvedValue([
      OPEN_TRADE,
      staleLegacyOpenRow,
    ]);
    mockExecutionApi.listRecentExecutions.mockResolvedValue([OPEN_TRADE]);
    mockExecutionApi.listClosedExecutions.mockResolvedValue([]);

    await expect(loadTraderExecutionSnapshot()).resolves.toEqual({
      openPositions: [OPEN_TRADE],
      recentExecutions: [OPEN_TRADE],
      closedExecutions: [],
    });
  });

  it('still fails closed when an endpoint returns a non-array payload', async () => {
    mockExecutionApi.listOpenPositions.mockResolvedValue([]);
    mockExecutionApi.listRecentExecutions.mockResolvedValue({ bad: 'shape' });
    mockExecutionApi.listClosedExecutions.mockResolvedValue([]);

    await expect(loadTraderExecutionSnapshot()).rejects.toThrow(
      'Recent executions contract mismatch',
    );
  });
});
