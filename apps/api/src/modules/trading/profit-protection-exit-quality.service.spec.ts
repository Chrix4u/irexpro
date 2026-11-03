import type { DataSource } from 'typeorm';
import { ProfitProtectionExitQualityService } from './profit-protection-exit-quality.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BROKER_ID = '22222222-2222-4222-8222-222222222222';

describe('ProfitProtectionExitQualityService', () => {
  it('keeps every query tenant-scoped and parameterizes all report filters', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          total: '2',
          resolved_count: '2',
          tp_first_count: '1',
          sl_first_count: '1',
          ambiguous_count: '0',
          neither_count: '0',
          data_gap_count: '0',
          small_profit_count: '1',
          small_profit_resolved_count: '1',
          small_profit_tp_first_count: '1',
          account_currency: 'EUR',
          actual_realised_pnl: '5.25',
          avg_actual_exit_r: '0.3200',
          avg_counterfactual_r: '0.4500',
          avg_r_delta: '0.1300',
        },
      ])
      .mockResolvedValueOnce([
        { account_currency: 'EUR', trade_count: '2', actual_realised_pnl: '5.25' },
      ])
      .mockResolvedValueOnce([
        {
          strategy_route: 'CONFIRMED_REVERSAL',
          total: '2',
          tp_first_count: '1',
          sl_first_count: '1',
          small_profit_count: '1',
          small_profit_resolved_count: '1',
          small_profit_comparable_count: '1',
          small_profit_tp_first_count: '1',
          small_profit_sl_first_count: '0',
          small_profit_avg_delta_r: '1.2500',
        },
      ])
      .mockResolvedValueOnce([
        {
          trade_id: 'trade-1',
          broker_connection_id: BROKER_ID,
          instrument: 'EURUSD',
          direction: 'SELL',
          strategy_route: 'CONFIRMED_REVERSAL',
          outcome: 'TP_FIRST',
          account_currency: 'EUR',
          realised_pnl: '3.25',
          actual_exit_r: '0.2500',
          original_target_r: '1.5000',
          counterfactual_r: '1.5000',
          r_delta: '1.2500',
          minutes_after_close: '17.5',
          closed_at: '2026-10-30T10:00:00.000Z',
          event_at: '2026-10-30T10:17:00.000Z',
          total_count: '2',
        },
      ]);
    const service = new ProfitProtectionExitQualityService({ query } as unknown as DataSource);

    const result = await service.getReport(USER_ID, {
      brokerConnectionId: BROKER_ID,
      from: '2026-10-28T00:00:00.000Z',
      to: '2026-10-31T23:59:59.999Z',
      instrument: 'eurusd',
      direction: 'SELL',
      strategyRoute: 'CONFIRMED_REVERSAL',
      outcome: 'TP_FIRST',
      smallProfitOnly: true,
      page: 2,
      pageSize: 1,
    });

    expect(query).toHaveBeenCalledTimes(4);
    for (const call of query.mock.calls) {
      expect(String(call[0])).toContain('t.user_id = $1');
      expect(call[1][0]).toBe(USER_ID);
      expect(call[1]).toContain(BROKER_ID);
      expect(call[1]).toContain('EURUSD');
      expect(call[1]).toContain('SELL');
      expect(call[1]).toContain('CONFIRMED_REVERSAL');
      expect(call[1]).toContain('TP_FIRST');
    }
    expect(String(query.mock.calls[0]![0])).toContain('t.realised_pnl > 0 AND t.realised_pnl <= 6');
    expect(result).toMatchObject({
      page: 2,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      summary: {
        total: 2,
        resolvedCount: 2,
        tpFirstCount: 1,
        slFirstCount: 1,
        tpFirstRate: 0.5,
        slFirstRate: 0.5,
        smallProfitCount: 1,
        smallProfitResolvedCount: 1,
        smallProfitTpFirstCount: 1,
        smallProfitTpFirstRate: 1,
        accountCurrency: 'EUR',
        actualRealisedPnl: '5.25',
        averageActualExitR: 0.32,
        averageCounterfactualR: 0.45,
        averageRDelta: 0.13,
      },
    });
    expect(result.routes[0]).toMatchObject({
      strategyRoute: 'CONFIRMED_REVERSAL',
      smallProfitCount: 1,
      smallProfitResolvedCount: 1,
      smallProfitComparableCount: 1,
      smallProfitTpFirstCount: 1,
      smallProfitSlFirstCount: 0,
      smallProfitTpFirstRate: 1,
      smallProfitAverageRDelta: 1.25,
    });
    const routeSql = String(query.mock.calls[2]![0]);
    expect(routeSql).toContain('small_profit_resolved_count');
    expect(routeSql).toContain('small_profit_comparable_count');
    expect(routeSql).toContain('AVG(f.r_delta)');
    expect(result.items[0]).toMatchObject({
      tradeId: 'trade-1',
      instrument: 'EURUSD',
      outcome: 'TP_FIRST',
      actualExitR: 0.25,
      originalTargetR: 1.5,
      counterfactualR: 1.5,
      rDelta: 1.25,
      minutesAfterClose: 17.5,
    });
  });

  it('never aggregates realised money across currencies and preserves currency breakdown', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          total: '2',
          resolved_count: '2',
          tp_first_count: '2',
          sl_first_count: '0',
          ambiguous_count: '0',
          neither_count: '0',
          data_gap_count: '0',
          small_profit_count: '2',
          small_profit_tp_first_count: '2',
          account_currency: null,
          actual_realised_pnl: null,
          avg_actual_exit_r: '0.2000',
          avg_counterfactual_r: '1.2000',
          avg_r_delta: '1.0000',
        },
      ])
      .mockResolvedValueOnce([
        { account_currency: 'EUR', trade_count: '1', actual_realised_pnl: '3.00' },
        { account_currency: 'USD', trade_count: '1', actual_realised_pnl: '4.00' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new ProfitProtectionExitQualityService({ query } as unknown as DataSource);

    const result = await service.getReport(USER_ID, {});

    expect(result.summary.accountCurrency).toBeNull();
    expect(result.summary.actualRealisedPnl).toBeNull();
    expect(result.summary.currencyBreakdown).toEqual([
      { accountCurrency: 'EUR', tradeCount: 1, actualRealisedPnl: '3.00' },
      { accountCurrency: 'USD', tradeCount: 1, actualRealisedPnl: '4.00' },
    ]);
  });

  it('uses fill/requested entry and original SL/TP to compute theoretical barrier R without inventing R for unresolved outcomes', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          total: '3',
          resolved_count: '2',
          tp_first_count: '1',
          sl_first_count: '1',
          ambiguous_count: '1',
          neither_count: '0',
          data_gap_count: '0',
          small_profit_count: '0',
          small_profit_tp_first_count: '0',
          account_currency: 'EUR',
          actual_realised_pnl: '6.00',
          avg_actual_exit_r: '0.3000',
          avg_counterfactual_r: '0.2500',
          avg_r_delta: '-0.0500',
        },
      ])
      .mockResolvedValueOnce([
        { account_currency: 'EUR', trade_count: '3', actual_realised_pnl: '6.00' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          trade_id: 'tp',
          broker_connection_id: BROKER_ID,
          instrument: 'EURUSD',
          direction: 'BUY',
          strategy_route: 'EARLY_TRANSITION',
          outcome: 'TP_FIRST',
          account_currency: 'EUR',
          realised_pnl: '2.00',
          actual_exit_r: '0.2500',
          original_target_r: '1.5000',
          counterfactual_r: '1.5000',
          r_delta: '1.2500',
          minutes_after_close: '20',
          closed_at: '2026-10-30T10:00:00Z',
          event_at: '2026-10-30T10:20:00Z',
          total_count: '3',
        },
        {
          trade_id: 'sl',
          broker_connection_id: BROKER_ID,
          instrument: 'EURUSD',
          direction: 'BUY',
          strategy_route: 'TREND_CONTINUATION',
          outcome: 'SL_FIRST',
          account_currency: 'EUR',
          realised_pnl: '2.00',
          actual_exit_r: '0.2500',
          original_target_r: '1.5000',
          counterfactual_r: '-1.0000',
          r_delta: '-1.2500',
          minutes_after_close: '12',
          closed_at: '2026-10-30T11:00:00Z',
          event_at: '2026-10-30T11:12:00Z',
          total_count: '3',
        },
        {
          trade_id: 'amb',
          broker_connection_id: BROKER_ID,
          instrument: 'EURUSD',
          direction: 'BUY',
          strategy_route: 'CONFIRMED_REVERSAL',
          outcome: 'AMBIGUOUS_SAME_M1',
          account_currency: 'EUR',
          realised_pnl: '2.00',
          actual_exit_r: '0.4000',
          original_target_r: null,
          counterfactual_r: null,
          r_delta: null,
          minutes_after_close: '8',
          closed_at: '2026-10-30T12:00:00Z',
          event_at: '2026-10-30T12:08:00Z',
          total_count: '3',
        },
      ]);
    const service = new ProfitProtectionExitQualityService({ query } as unknown as DataSource);
    const result = await service.getReport(USER_ID, { page: 1, pageSize: 25 });

    expect(result.items.map((row) => [row.outcome, row.counterfactualR, row.rDelta])).toEqual([
      ['TP_FIRST', 1.5, 1.25],
      ['SL_FIRST', -1, -1.25],
      ['AMBIGUOUS_SAME_M1', null, null],
    ]);
    expect(String(query.mock.calls[3]![0])).toContain(
      'COALESCE(t.fill_price, t.requested_entry_price)',
    );
    expect(String(query.mock.calls[3]![0])).toContain(
      "WHEN b.outcome = 'SL_FIRST' THEN -1::numeric",
    );
    expect(String(query.mock.calls[3]![0])).toContain(
      "WHEN b.outcome = 'TP_FIRST' THEN b.original_target_r",
    );
  });

  it('excludes data gaps from the resolved small-profit TP-first denominator', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{
        total: '3',
        resolved_count: '1',
        tp_first_count: '1',
        sl_first_count: '0',
        ambiguous_count: '0',
        neither_count: '0',
        data_gap_count: '2',
        small_profit_count: '3',
        small_profit_resolved_count: '1',
        small_profit_tp_first_count: '1',
        account_currency: 'EUR',
        actual_realised_pnl: '7.50',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        strategy_route: 'EARLY_TRANSITION',
        total: '3',
        tp_first_count: '1',
        sl_first_count: '0',
        small_profit_count: '3',
        small_profit_resolved_count: '1',
        small_profit_comparable_count: '1',
        small_profit_tp_first_count: '1',
        small_profit_sl_first_count: '0',
        small_profit_avg_delta_r: '0.25',
      }])
      .mockResolvedValueOnce([]);

    const service = new ProfitProtectionExitQualityService({ query } as unknown as DataSource);
    const result = await service.getReport(USER_ID, {});
    expect(result.summary.smallProfitCount).toBe(3);
    expect(result.summary.smallProfitResolvedCount).toBe(1);
    expect(result.summary.smallProfitTpFirstRate).toBe(1);
    expect(result.routes[0]).toMatchObject({
      smallProfitCount: 3,
      smallProfitResolvedCount: 1,
      smallProfitComparableCount: 1,
      smallProfitTpFirstRate: 1,
      smallProfitAverageRDelta: 0.25,
    });
  });

  it('caps page size at 100 and rejects invalid enum/date filters fail closed', async () => {
    const service = new ProfitProtectionExitQualityService({
      query: jest.fn(),
    } as unknown as DataSource);

    await expect(service.getReport(USER_ID, { pageSize: 1000 })).resolves.toMatchObject({
      pageSize: 100,
    });
    await expect(service.getReport(USER_ID, { direction: 'SIDEWAYS' as never })).rejects.toThrow(
      'Invalid direction',
    );
    await expect(service.getReport(USER_ID, { outcome: 'MAYBE' as never })).rejects.toThrow(
      'Invalid outcome',
    );
    await expect(service.getReport(USER_ID, { from: 'not-a-date' })).rejects.toThrow(
      'Invalid from',
    );
  });
});
