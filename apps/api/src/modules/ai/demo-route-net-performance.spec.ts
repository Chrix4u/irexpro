import type { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import {
  toDemoRouteNetPerformance,
  type DemoRouteNetPerformanceRow,
} from './demo-route-net-performance';

const base = (overrides: Partial<DemoRouteNetPerformanceRow> = {}): DemoRouteNetPerformanceRow => ({
  broker_id: 'pepperstone-ctrader',
  account_currency: 'USD',
  authority_path: 'PRIMARY_PLAN_B',
  strategy_route: 'TREND_CONTINUATION',
  closed_trades: 3,
  verified_trades: 3,
  net_wins: 1,
  net_losses: 2,
  gross_pnl: '12.50',
  commission: '-16.50',
  swap: '0.00',
  net_pnl: '-4.00',
  ...overrides,
});

describe('DEMO route net performance research', () => {
  it('preserves gross and commission separately and reports after-fee net without a new order authority', () => {
    expect(toDemoRouteNetPerformance([base()])).toEqual({
      mode: 'RESEARCH_ONLY',
      scope: 'LATEST_CONNECTED_CTRADER_DEMO',
      broker: 'pepperstone-ctrader',
      accountCurrency: 'USD',
      windowDays: 10,
      routes: [
        expect.objectContaining({
          authorityPath: 'PRIMARY_PLAN_B',
          strategyRoute: 'TREND_CONTINUATION',
          closedTrades: 3,
          verifiedTrades: 3,
          netWins: 1,
          netLosses: 2,
          grossPnl: '12.50',
          commission: '-16.50',
          swap: '0.00',
          netPnl: '-4.00',
        }),
      ],
      modifiesExecution: false,
    });
  });

  it('distinguishes missing fee evidence from actual zero P&L and never invents a winning route', () => {
    const response = toDemoRouteNetPerformance([
      base({
        strategy_route: 'EARLY_TRANSITION',
        closed_trades: '4',
        verified_trades: '0',
        net_wins: '0',
        net_losses: '0',
        gross_pnl: null,
        commission: null,
        swap: null,
        net_pnl: null,
      }),
    ]);
    expect(response.routes[0]).toMatchObject({
      closedTrades: 4,
      verifiedTrades: 0,
      netPnl: null,
    });
    expect(response.modifiesExecution).toBe(false);
  });

  it('shows the selected DEMO account without pretending it has route observations', () => {
    const response = toDemoRouteNetPerformance([
      base({ authority_path: null, strategy_route: null, closed_trades: null }),
    ]);
    expect(response.broker).toBe('pepperstone-ctrader');
    expect(response.routes).toEqual([]);
  });

  it('returns a bounded empty result without an eligible user-owned account', () => {
    expect(toDemoRouteNetPerformance([])).toMatchObject({
      scope: 'NO_CONNECTED_CTRADER_DEMO',
      broker: null,
      accountCurrency: null,
      routes: [],
      modifiesExecution: false,
    });
  });

  it('queries only the latest exact-user cTrader-family DEMO account and joins verified fee records', async () => {
    const query = jest.fn().mockResolvedValue([base()]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const response = await service.loadDemoRouteNetPerformance('user-99');
    expect(response.routes).toHaveLength(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['user-99', ['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader']]);
    expect(sql).toContain('s.user_id = $1');
    expect(sql).toContain('b.user_id = s.user_id');
    expect(sql).toContain("s.execution_mode = 'FULL_AUTO'");
    expect(sql).toContain("b.account_type = 'DEMO'");
    expect(sql).toContain("b.status = 'CONNECTED'");
    expect(sql).toContain('b.broker_id = ANY($2::text[])');
    expect(sql).toContain('s.broker_connection_id = t.broker_connection_id');
    expect(sql).toContain('s.account_currency = t.account_currency');
    expect(sql).toContain('ti.user_id = t.user_id');
    expect(sql).toContain('ti.broker_connection_id = t.broker_connection_id');
    expect(sql).toContain("t.status = 'CLOSED'");
    expect(sql).toContain("t.closed_at >= NOW() - interval '10 days'");
    expect(sql).toContain('t.realised_pnl IS NOT NULL');
    expect(sql).toContain('t.commission IS NOT NULL');
    expect(sql).toContain('t.swap IS NOT NULL');
    expect(sql).toContain('SUM(realised_pnl+commission+swap)');
    expect(sql).not.toContain('UPDATE trading.trades');
    expect(sql).not.toContain('INSERT INTO');
  });
});
