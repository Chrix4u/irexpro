import type { DataSource } from 'typeorm';
import { SmartProfitProtectionReplayService } from './smart-profit-protection-replay.service';

const broker = {
  broker_connection_id: '9a14f702-4f46-42d1-9aee-eb282b3f5321',
  broker_id: 'pepperstone-ctrader',
  account_currency: 'USD',
};
const trade = {
  instrument: 'USDCHF',
  direction: 'SELL',
  strategy_route: 'TREND_CONTINUATION',
  opened_at: new Date('2026-11-10T06:26:30.000Z'),
  closed_at: new Date('2026-11-10T07:00:25.000Z'),
  fill_price: '0.81902',
  stop_loss: '0.81958',
  take_profit: '0.81828',
  exit_price: '0.81826',
  initial_risk_pnl: '244.17',
  realised_pnl: '371.52',
  commission: '-24.00',
  swap: '0',
  broker_connection_id: broker.broker_connection_id,
  account_currency: 'USD',
};

describe('smart profit-protection replay database boundary', () => {
  it('reads only the authenticated user exact connected DEMO account, same-connection candles, settled costs; no orders', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([broker])
      .mockResolvedValueOnce([trade])
      .mockResolvedValueOnce([]);
    const service = new SmartProfitProtectionReplayService({ query } as unknown as DataSource);

    const result = await service.getUserReplay('owner-11');
    expect(result).toMatchObject({
      version: 'smart-protection-replay-v1',
      broker: 'pepperstone-ctrader',
      accountCurrency: 'USD',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      liveStopAmendmentEnabled: false,
      autoPromotionEnabled: false,
      closedTradesInspected: 1,
      completeReplays: 0,
    });
    expect(result.routeComparisons).toHaveLength(4);
    expect(result.trades[0]).toMatchObject({
      instrument: 'USDCHF',
      actualNetPnl: 347.52,
      dataQuality: 'INSUFFICIENT_CAUSAL_MARKS',
      executionAuthority: 'NONE',
    });

    expect(query).toHaveBeenCalledTimes(3);
    const [selectionSql, selectionArgs] = query.mock.calls[0] as [string, unknown[]];
    expect(selectionArgs).toEqual([
      'owner-11',
      ['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader'],
    ]);
    expect(selectionSql).toContain('b.user_id = s.user_id');
    expect(selectionSql).toContain("b.account_type = 'DEMO'");
    expect(selectionSql).toContain('b.broker_id = ANY($2::text[])');
    const [tradesSql, tradeArgs] = query.mock.calls[1] as [string, unknown[]];
    expect(tradeArgs).toEqual(['owner-11', broker.broker_connection_id, 'USD', 12]);
    expect(tradesSql).toContain('t.user_id = $1');
    expect(tradesSql).toContain('t.broker_connection_id = $2::uuid');
    expect(tradesSql).toContain('t.account_currency = $3');
    expect(tradesSql).toContain("t.status = 'CLOSED'");
    expect(tradesSql).toContain('t.commission IS NOT NULL');
    expect(tradesSql).toContain('t.swap IS NOT NULL');
    const [quoteSql, quoteArgs] = query.mock.calls[2] as [string, unknown[]];
    expect(quoteArgs).toEqual([
      broker.broker_connection_id,
      'USDCHF',
      ['M1', 'M5', 'M15'],
      trade.opened_at,
      trade.closed_at,
      1200,
    ]);
    expect(quoteSql).toContain('connection_id = $1::uuid');
    expect(quoteSql).toContain('instrument = $2');
    expect(quoteSql).toContain('LIMIT $6');
    for (const sql of [selectionSql, tradesSql, quoteSql]) {
      expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|ALTER|DROP)\b/i);
    }
  });

  it('does not query trade history when this user has no eligible connected DEMO account', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const service = new SmartProfitProtectionReplayService({ query } as unknown as DataSource);
    const result = await service.getUserReplay('owner-2');
    expect(result.broker).toBeNull();
    expect(result.trades).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses to promote any scenario even when a small historical sample appears better', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([broker])
      .mockResolvedValueOnce([trade])
      .mockResolvedValueOnce([]);
    const result = await new SmartProfitProtectionReplayService({
      query,
    } as unknown as DataSource).getUserReplay('owner-11');
    expect(result.routeComparisons.every((x) => !x.dataSufficientForPromotion)).toBe(true);
    expect(result.routeComparisons.every((x) => x.qualifiedTrades === 0)).toBe(true);
  });
});
