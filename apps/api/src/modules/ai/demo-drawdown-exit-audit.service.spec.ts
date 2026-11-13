import type { DataSource } from 'typeorm';
import { DemoDrawdownExitAuditService } from './demo-drawdown-exit-audit.service';

const broker = {
  broker_connection_id: '9a14f702-4f46-42d1-9aee-eb282b3f5321',
  broker_id: 'pepperstone-ctrader',
  account_currency: 'USD',
};
const trade = {
  id: 'd3a64184-9cc8-4267-ad93-1ffb09aa4a42',
  instrument: 'GBPUSD',
  direction: 'BUY',
  closed_at: new Date('2026-11-10T08:41:30Z'),
  stop_loss: '1.345140',
  take_profit: '1.346440',
  realised_pnl: '-68',
  commission: '-24',
  swap: '0',
  strategy_route: 'TREND_CONTINUATION',
  current_r: '-0.52',
};

describe('drawdown-guard exit-audit read-only database scope', () => {
  it('uses only user-owned connected DEMO account, completed trades with costs and same-broker quotes', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([broker])
      .mockResolvedValueOnce([trade])
      .mockResolvedValueOnce([]);
    const service = new DemoDrawdownExitAuditService({ query } as unknown as DataSource);
    const result = await service.getUserRetrospective('owner-21');
    expect(result.executionAuthority).toBe('NONE');
    expect(result.modifiesExecution).toBe(false);
    expect(result.broker).toBe('pepperstone-ctrader');
    expect(result.inspected).toBe(1);
    expect(result.trades[0]).toMatchObject({
      instrument: 'GBPUSD',
      actualNetPnl: -92,
      guardCheckpointR: -0.52,
      classification: 'INSUFFICIENT_QUOTE_COVERAGE',
    });
    expect(query).toHaveBeenCalledTimes(3);
    const [accountSql, accountArgs] = query.mock.calls[0] as [string, unknown[]];
    expect(accountArgs[0]).toBe('owner-21');
    expect(accountArgs[1]).toEqual(expect.arrayContaining(['pepperstone-ctrader']));
    expect(accountSql).toContain('b.user_id = $1');
    expect(accountSql).toContain("b.account_type = 'DEMO'");
    const [tradesSql, tradesArgs] = query.mock.calls[1] as [string, unknown[]];
    expect(tradesArgs).toEqual([
      'owner-21',
      broker.broker_connection_id,
      'USD',
      'plan-b-v89-demo-5m-drawdown-guard-v1',
    ]);
    expect(tradesSql).toContain('t.broker_connection_id = $2::uuid');
    expect(tradesSql).toContain('t.account_currency = $3');
    expect(tradesSql).toContain("t.status = 'CLOSED'");
    expect(tradesSql).toContain("o.action = 'CLOSE_DEMO'");
    expect(tradesSql).toContain('t.commission IS NOT NULL AND t.swap IS NOT NULL');
    const [quotesSql, quotesArgs] = query.mock.calls[2] as [string, unknown[]];
    expect(quotesArgs).toEqual([broker.broker_connection_id, 'GBPUSD', trade.closed_at]);
    expect(quotesSql).toContain('connection_id = $1::uuid');
    expect(quotesSql).toContain('instrument = $2');
    for (const [sql] of query.mock.calls) {
      expect(String(sql)).not.toMatch(/\\b(INSERT|UPDATE|DELETE|ALTER|DROP)\\b/i);
    }
  });

  it('never queries trades when no user-owned connected DEMO account exists', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const service = new DemoDrawdownExitAuditService({ query } as unknown as DataSource);
    const result = await service.getUserRetrospective('owner-33');
    expect(result.inspected).toBe(0);
    expect(result.trades).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
