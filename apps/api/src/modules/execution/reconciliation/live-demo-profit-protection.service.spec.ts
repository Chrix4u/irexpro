import { DataSource } from 'typeorm';
import { LiveDemoProfitProtectionService } from './live-demo-profit-protection.service';
import { BrokerService } from '../../broker/broker.service';
import { ExecutionService } from '../execution.service';
import { TradeCloseReason } from '../entities/trade.entity';

describe('LiveDemoProfitProtectionService', () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    trade_id: 'trade-1',
    user_id: 'user-1',
    broker_connection_id: 'conn-1',
    external_order_id: 'order-777',
    external_position_id: 'position-7001',
    instrument: 'EURUSD',
    direction: 'BUY',
    max_favorable_pnl: '10.00',
    max_adverse_pnl: '-2.00',
    profit_giveback: '0.00',
    path_observation_count: 5,
    path_peak_observed_at: new Date('2026-10-28T09:00:00.000Z'),
    initial_risk_pnl: '9.00',
    is_m1_strategy: true,
    ...overrides,
  });

  function harness(rows = [candidate()], currentPnl = '7.00', accountType = 'DEMO') {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM trading.trades t')) return rows;
      if (sql.includes('UPDATE trading.trades')) return [];
      return [];
    });
    const dataSource = { query } as unknown as DataSource;
    const brokerService = {
      getOpenPositionsForConnection: jest.fn().mockResolvedValue({
        connection: { id: 'conn-1', brokerId: 'ctrader', accountType },
        positions: [
          {
            externalOrderId: 'position-7001',
            instrument: 'EURUSD',
            direction: 'BUY',
            lotSize: '0.20',
            openPrice: '1.11300',
            currentPrice: '1.11340',
            stopLoss: '1.11250',
            takeProfit: '1.11380',
            unrealisedPnl: currentPnl,
            openedAt: new Date('2026-10-28T08:55:00.000Z'),
            commission: '0',
            swap: '0',
          },
        ],
      }),
    } as unknown as BrokerService;
    const executionService = {
      closeTrade: jest.fn().mockResolvedValue({ status: 'CLOSED' }),
    } as unknown as ExecutionService;
    return {
      service: new LiveDemoProfitProtectionService(dataSource, brokerService, executionService),
      query,
      brokerService: brokerService as any,
      executionService: executionService as any,
    };
  }

  it('persists peak/giveback telemetry and profit-protects a cTrader DEMO winner that retraces through its R floor', async () => {
    const h = harness([candidate()], '7.00');

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trading.trades'),
      expect.arrayContaining(['trade-1', '10.00000000', '-2.00000000', '3.00000000', 6]),
    );
    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.PROFIT_PROTECTION,
    );
  });

  it('observes but does not close an M1 trade before the 0.40R rescue floor is armed', async () => {
    const h = harness(
      [candidate({ max_favorable_pnl: '3.00', max_adverse_pnl: '-1.00' })],
      '2.50',
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trading.trades'),
      expect.arrayContaining(['trade-1', '3.00000000', '-1.00000000', '0.50000000', 6]),
    );
    expect(h.executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('never applies automatic profit protection to a real-money LIVE connection', async () => {
    const h = harness([candidate()], '7.00', 'LIVE');

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.executionService.closeTrade).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trading.trades'),
      expect.anything(),
    );
  });
});
