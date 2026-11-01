import { BackfillBrokerCloseBarrierReasons1793495100000 } from './migrations/1793495100000-BackfillBrokerCloseBarrierReasons';

describe('BackfillBrokerCloseBarrierReasons migration', () => {
  it('reclassifies only provable generic broker closes using valid geometry and one-pip tolerance', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql.replace(/\s+/g, ' ').trim());
      }),
    } as any;

    await new BackfillBrokerCloseBarrierReasons1793495100000().up(queryRunner);

    expect(queries).toHaveLength(2);
    const sql = queries.join(' ');
    expect(sql).toContain('UPDATE trading.trades');
    expect(sql).toContain('broker.broker_connections');
    expect(sql).toContain("broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')");
    expect(sql).toContain("close_reason = 'BROKER_CLOSE'");
    expect(sql).toContain("close_reason = 'STOP_LOSS_HIT'");
    expect(sql).toContain("close_reason = 'TAKE_PROFIT_HIT'");
    expect(sql).toContain('COALESCE(fill_price, requested_entry_price)');
    expect(sql).toContain("UPPER(instrument) LIKE '%JPY'");
    expect(sql).toContain('0.01::numeric');
    expect(sql).toContain('0.0001::numeric');
    expect(sql).toContain("direction = 'BUY'");
    expect(sql).toContain("direction = 'SELL'");
    expect(sql).not.toContain('realised_pnl =');
    expect(sql).not.toContain('exit_price =');
  });

  it('has a no-op down migration because corrected provenance is not safely reversible', async () => {
    const queryRunner = { query: jest.fn() } as any;
    await new BackfillBrokerCloseBarrierReasons1793495100000().down(queryRunner);
    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
