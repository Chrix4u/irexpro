import { toLivePositionRowView } from './live-account-positions-response.dto';
import { LiveAccountEnvironment } from './live-account.enums';
import { Trade, TradeDirection, TradeStatus } from '../../execution/entities/trade.entity';

it('projects persisted cTrader path telemetry when the provider position has no PAPER pathDiagnostics', () => {
  const peakAt = new Date('2026-10-28T09:00:00.000Z');
  const lastAt = new Date('2026-10-28T09:05:00.000Z');
  const trade = {
    id: 'trade-1', brokerConnectionId: 'conn-1', instrument: 'EURUSD',
    direction: TradeDirection.BUY, lotSize: '0.20', requestedEntryPrice: '1.11300',
    fillPrice: '1.11300', accountCurrency: 'EUR', stopLoss: '1.11250',
    takeProfit: '1.11380', trailingStopPips: null, status: TradeStatus.OPEN,
    openedAt: new Date('2026-10-28T08:55:00.000Z'), createdAt: new Date('2026-10-28T08:54:59.000Z'),
    commission: '0', swap: '0', maxFavorablePnl: '10.00000000', maxAdversePnl: '-2.00000000',
    profitGiveback: '3.00000000', pathObservationCount: 6, pathPeakObservedAt: peakAt,
    pathLastObservedAt: lastAt, sameBarProtectionAmbiguityCount: 0,
    lastSameBarProtectionAmbiguityAt: null,
  } as Trade;
  const provider = {
    externalOrderId: 'position-7001', instrument: 'EURUSD', direction: 'BUY' as const,
    lotSize: '0.20', openPrice: '1.11300', currentPrice: '1.11340', stopLoss: '1.11250',
    takeProfit: '1.11380', unrealisedPnl: '7.00', openedAt: trade.openedAt!, commission: '0', swap: '0',
  };

  const view = toLivePositionRowView(trade, 'Spotware', LiveAccountEnvironment.DEMO, provider);

  expect(view.pathDiagnostics).toEqual(expect.objectContaining({
    maxFavorablePnl: '10.00000000', maxAdversePnl: '-2.00000000', latestUnrealisedPnl: '7.00',
    profitGiveback: '3.00000000', observationCount: 6,
    peakObservedAt: peakAt.toISOString(), lastObservedAt: lastAt.toISOString(),
  }));
});
