import { DataSource } from 'typeorm';
import {
  LiveDemoProfitProtectionService,
  evaluateLiveDemoAdverseProtection,
} from './live-demo-profit-protection.service';
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
    opened_at: new Date('2026-10-28T09:01:00.000Z'),
    is_m1_strategy: true,
    ...overrides,
  });

  function harness(
    rows = [candidate()],
    currentPnl = '7.00',
    accountType = 'DEMO',
    m1Rows: Array<Record<string, unknown>> = [],
  ) {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM trading.trades t')) return rows;
      if (sql.includes('FROM market_data.provider_quote_candles')) return m1Rows;
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
    const h = harness([candidate({ max_favorable_pnl: '3.00', max_adverse_pnl: '-1.00' })], '2.50');

    await h.service.runOnce(new Date('2026-10-28T09:05:00.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE trading.trades'),
      expect.arrayContaining(['trade-1', '3.00000000', '-1.00000000', '0.50000000', 6]),
    );
    expect(h.executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('closes a materially losing DEMO trade when completed broker-native M1 evidence confirms thesis failure', async () => {
    const h = harness(
      [candidate({ max_favorable_pnl: '0.50', max_adverse_pnl: '-5.00' })],
      '-5.00',
      'DEMO',
      [
        {
          bucket_time: new Date('2026-10-28T09:03:00.000Z'),
          open: '1.1000',
          high: '1.1001',
          low: '1.0994',
          close: '1.0995',
          sample_count: 10,
          source: 'ctrader-broker-native',
        },
        {
          bucket_time: new Date('2026-10-28T09:02:00.000Z'),
          open: '1.1005',
          high: '1.1006',
          low: '1.0999',
          close: '1.1000',
          sample_count: 9,
          source: 'ctrader-broker-native',
        },
        {
          bucket_time: new Date('2026-10-28T09:01:00.000Z'),
          open: '1.1008',
          high: '1.1009',
          low: '1.1004',
          close: '1.1005',
          sample_count: 8,
          source: 'ctrader-broker-native',
        },
      ],
    );

    await h.service.runOnce(new Date('2026-10-28T09:05:10.000Z'));

    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM market_data.provider_quote_candles'),
      ['conn-1', 'EURUSD', expect.any(String)],
    );
    expect(h.executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      'user-1',
      TradeCloseReason.AI_CLOSE_SIGNAL,
    );
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

describe('evaluateLiveDemoAdverseProtection', () => {
  const base = {
    elapsedMinutes: 4,
    currentPnl: -4.5,
    initialRiskPnl: 10,
    maxFavorablePnl: 0.5,
    profitLockArmed: false,
    m1Evidence: {
      completedBars: 3,
      adverseBars: 3,
      alignedLatestBodyPressure: -0.72,
      alignedMomentum3: -0.58,
      latestAgeSeconds: 8,
    },
  } as const;

  it('does not cut before one completed M1 minute exists', () => {
    expect(evaluateLiveDemoAdverseProtection({ ...base, elapsedMinutes: 0.8 })).toMatchObject({
      shouldClose: false,
      reason: 'TOO_EARLY',
    });
  });

  it('leaves a trade to profit protection once the favorable excursion has armed it', () => {
    expect(evaluateLiveDemoAdverseProtection({ ...base, profitLockArmed: true })).toMatchObject({
      shouldClose: false,
      reason: 'PROFIT_PROTECTION_OWNS_TRADE',
    });
  });

  it('cuts a losing thesis before full stop when adverse R and completed M1 evidence agree', () => {
    expect(evaluateLiveDemoAdverseProtection(base)).toMatchObject({
      shouldClose: true,
      reason: 'ADVERSE_THESIS_FAILED',
      currentR: -0.45,
    });
  });

  it('cuts an emergency fast loss when the first completed M1 bar confirms the adverse move', () => {
    expect(
      evaluateLiveDemoAdverseProtection({
        ...base,
        elapsedMinutes: 1.2,
        currentPnl: -7,
        m1Evidence: {
          completedBars: 1,
          adverseBars: 1,
          alignedLatestBodyPressure: -0.8,
          alignedMomentum3: -0.8,
          latestAgeSeconds: 5,
        },
      }),
    ).toMatchObject({ shouldClose: true, reason: 'EMERGENCY_ADVERSE_CUT' });
  });

  it('holds an adverse position when the completed M1 evidence is recovering with the trade direction', () => {
    expect(
      evaluateLiveDemoAdverseProtection({
        ...base,
        currentPnl: -5.2,
        m1Evidence: {
          completedBars: 3,
          adverseBars: 1,
          alignedLatestBodyPressure: 0.48,
          alignedMomentum3: 0.2,
          latestAgeSeconds: 6,
        },
      }),
    ).toMatchObject({ shouldClose: false, reason: 'RECOVERY_FORMING' });
  });

  it('holds when causal completed-M1 evidence is missing or stale', () => {
    expect(evaluateLiveDemoAdverseProtection({ ...base, m1Evidence: null })).toMatchObject({
      shouldClose: false,
      reason: 'M1_EVIDENCE_UNAVAILABLE',
    });
    expect(
      evaluateLiveDemoAdverseProtection({
        ...base,
        m1Evidence: { ...base.m1Evidence, latestAgeSeconds: 150 },
      }),
    ).toMatchObject({ shouldClose: false, reason: 'M1_EVIDENCE_UNAVAILABLE' });
  });
});
