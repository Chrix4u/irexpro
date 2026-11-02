import type { TradeExecutionView } from '@irexpro/types/execution';
import { executionPathDiagnostics } from './trade-path-diagnostics';

const trade = (overrides: Partial<TradeExecutionView> = {}): TradeExecutionView => ({
  id: 'trade-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.2000',
  requestedEntryPrice: '1.11180',
  fillPrice: '1.11180',
  stopLoss: '1.11130',
  takeProfit: '1.11310',
  trailingStopPips: null,
  status: 'CLOSED',
  exitPrice: '1.11283',
  accountCurrency: 'EUR',
  realisedPnl: '9.53000000',
  commission: '-1.80',
  swap: '0.00',
  closeReason: 'PROFIT_PROTECTION',
  openedAt: '2026-10-28T01:10:17.589Z',
  closedAt: '2026-10-28T10:37:26.675Z',
  createdAt: '2026-10-28T01:10:16.822Z',
  updatedAt: '2026-10-28T11:21:24.418Z',
  ...overrides,
});

describe('executionPathDiagnostics', () => {
  it('keeps durable closed-trade peak/giveback telemetry visible after closure', () => {
    expect(executionPathDiagnostics(trade({
      maxFavorablePnl: '10.60000000',
      maxAdversePnl: '0.00000000',
      profitGiveback: '2.15000000',
      pathObservationCount: 54,
      pathPeakObservedAt: '2026-10-28T10:36:08.871Z',
      pathLastObservedAt: '2026-10-28T10:37:24.733Z',
    }))).toEqual({
      maxFavorablePnl: '10.60000000',
      maxAdversePnl: '0.00000000',
      profitGiveback: '2.15000000',
      observationCount: 54,
      peakObservedAt: '2026-10-28T10:36:08.871Z',
      lastObservedAt: '2026-10-28T10:37:24.733Z',
    });
  });

  it('returns null instead of inventing path diagnostics for legacy trades', () => {
    expect(executionPathDiagnostics(trade())).toBeNull();
  });
});
