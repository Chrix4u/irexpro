import { QueryRunner } from 'typeorm';
import { CreateDemoPartialCloseLegLedger1793880000000 } from './migrations/1793880000000-CreateDemoPartialCloseLegLedger';

describe('DEMO partial-close ledger migration is additive and fail-closed', () => {
  const collect = () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    return { runner, statements };
  };

  it('creates DEMO-only ledger with durable idempotency, proof and single-pilot constraints', async () => {
    const { runner, statements } = collect();
    await new CreateDemoPartialCloseLegLedger1793880000000().up(runner);
    const sql = statements.join('\n');
    expect(sql).toContain('trading.demo_partial_close_legs');
    expect(sql).toContain("account_type = 'DEMO'");
    expect(sql).toContain("broker_id = 'ctrader'");
    expect(sql).toContain('UNIQUE (client_order_id)');
    expect(sql).toContain('uq_demo_partial_close_one_p1_per_trade');
    expect(sql).toContain('uq_demo_partial_close_inflight_trade');
    expect(sql).toContain('uq_demo_partial_close_provider_deal');
    expect(sql).toContain('broker_lots_before = broker_filled_lots + broker_lots_after');
    expect(sql).toContain('broker_filled_lots = requested_close_lots');
    expect(sql).toContain('broker_lots_after = requested_close_lots');
    expect(sql).toContain('original_lots = 2 * requested_close_lots');
    expect(sql).toContain('gross_realised_pnl IS NOT NULL');
    expect(sql).toContain('commission IS NOT NULL');
    expect(sql).toContain('swap IS NOT NULL');
    expect(sql).not.toMatch(/(?:INSERT|UPDATE)\s+trading\.trades/i);
  });

  it('rolls back only the new unused ledger', async () => {
    const { runner, statements } = collect();
    await new CreateDemoPartialCloseLegLedger1793880000000().down(runner);
    expect(statements).toEqual(['DROP TABLE IF EXISTS trading.demo_partial_close_legs']);
  });
});
