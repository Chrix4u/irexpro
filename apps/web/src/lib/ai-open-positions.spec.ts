import type { TradeExecutionView } from '@irexpro/types/execution';

const OPEN_EXECUTION: TradeExecutionView = {
  id: 'trade-paper-1',
  instrument: 'AUDUSD',
  direction: 'BUY',
  lotSize: '0.19',
  requestedEntryPrice: '0.69300',
  fillPrice: '0.69302',
  stopLoss: '0.69250',
  takeProfit: '0.69420',
  trailingStopPips: null,
  status: 'OPEN',
  exitPrice: null,
  accountCurrency: 'USD',
  realisedPnl: null,
  commission: null,
  swap: null,
  closeReason: null,
  openedAt: '2026-10-15T09:20:09.000Z',
  closedAt: null,
  createdAt: '2026-10-15T09:20:09.000Z',
  updatedAt: '2026-10-15T09:20:09.000Z',
};

describe('PAPER open-position truth resolver', () => {
  it('keeps a durable PAPER execution visible when the live-account feed is empty', () => {
    let resolveAiOpenPositionRows: undefined | ((input: unknown) => unknown[]);
    try {
      // Dynamic require keeps this RED as an assertion failure until the resolver exists.
      resolveAiOpenPositionRows = require('./ai-open-positions').resolveAiOpenPositionRows;
    } catch {
      resolveAiOpenPositionRows = undefined;
    }

    expect(typeof resolveAiOpenPositionRows).toBe('function');

    const rows = resolveAiOpenPositionRows!({
      executionMode: 'PAPER_ONLY',
      executionOpenPositions: [OPEN_EXECUTION],
      livePositions: [],
      paperBrokerConnectionId: 'paper-connection-1',
      paperBrokerName: 'Paper Broker',
    }) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: 'trade-paper-1',
        instrument: 'AUDUSD',
        lotSize: '0.19',
        status: 'OPEN',
        environment: 'PAPER',
      }),
    );
  });
});

it('prefers a matching live-account row as PAPER enrichment without duplicating the durable trade', () => {
  const { resolveAiOpenPositionRows } = require('./ai-open-positions');
  const live = {
    id: 'trade-paper-1',
    brokerConnectionId: 'paper-connection-1',
    brokerName: 'Paper Broker',
    environment: 'PAPER',
    instrument: 'AUDUSD',
    direction: 'BUY',
    lotSize: '0.19',
    requestedEntryPrice: '0.69300',
    fillPrice: '0.69302',
    accountCurrency: 'USD',
    currentPrice: '0.69340',
    markSource: 'PROVIDER',
    markObservedAt: '2026-10-15T09:21:00.000Z',
    markIsStale: false,
    unrealisedPnl: '7.22',
    pathDiagnostics: null,
    commission: null,
    swap: null,
    stopLoss: '0.69250',
    takeProfit: '0.69420',
    trailingStopPips: null,
    status: 'OPEN',
    openedAt: '2026-10-15T09:20:09.000Z',
    createdAt: '2026-10-15T09:20:09.000Z',
  };

  const rows = resolveAiOpenPositionRows({
    executionMode: 'PAPER_ONLY',
    executionOpenPositions: [OPEN_EXECUTION],
    livePositions: [live],
    paperBrokerConnectionId: 'paper-connection-1',
    paperBrokerName: 'Paper Broker',
  });

  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(expect.objectContaining({ currentPrice: '0.69340', unrealisedPnl: '7.22' }));
});

it('leaves DEMO/LIVE position authority on the live-account feed', () => {
  const { resolveAiOpenPositionRows } = require('./ai-open-positions');
  const rows = resolveAiOpenPositionRows({
    executionMode: 'FULL_AUTO',
    executionOpenPositions: [OPEN_EXECUTION],
    livePositions: [],
    paperBrokerConnectionId: null,
    paperBrokerName: null,
  });
  expect(rows).toEqual([]);
});
