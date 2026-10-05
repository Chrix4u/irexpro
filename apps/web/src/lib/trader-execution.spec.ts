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

  it('still rejects unknown close reasons', () => {
    expect(
      isTradeExecutionView({
        ...CLOSED_TRADE,
        closeReason: 'UNRECOGNIZED_CLOSE_REASON',
      }),
    ).toBe(false);
  });
});
