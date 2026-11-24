import { QueryRunner } from 'typeorm';
import { CreateDemoProfitStopAmendmentIntents1795082400000 as Migration } from './migrations/1795082400000-CreateDemoProfitStopAmendmentIntents';

describe('DEMO positive broker stop intent ledger: schema-only and fail-closed', () => {
  const stub = () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    return { runner, statements };
  };
  it('creates owner-only DEMO immutable proof gates with no order dispatch', async () => {
    const { runner, statements } = stub();
    await new Migration().up(runner);
    const sql = statements.join('\n');
    expect(sql).toContain('trading.demo_profit_stop_amendment_intents');
    expect(sql).toContain("broker_id = 'pepperstone-ctrader'");
    expect(sql).toContain("account_type = 'DEMO'");
    expect(sql).toContain("account_currency = 'USD'");
    expect(sql).toContain("'EARLY_TRANSITION','CONFIRMED_REVERSAL'");
    expect(sql).toContain('original_stop < entry_price');
    expect(sql).toContain('entry_price < proposed_positive_stop');
    expect(sql).toContain('proposed_positive_stop < entry_price');
    expect(sql).toContain('broker_readback_stop = proposed_positive_stop');
    expect(sql).toContain('broker_verified_at IS NOT NULL');
    expect(sql).toContain('authority_committed_at IS NOT NULL');
    expect(sql).toContain('uq_demo_profit_stop_unresolved_trade');
    expect(sql).toContain('client_request_id varchar(255) NOT NULL UNIQUE');
    expect(sql).not.toMatch(/(?:UPDATE|INSERT)\s+trading\.trades/i);
    expect(sql).not.toMatch(/(?:TRUNCATE|DELETE)\s+FROM/i);
  });
  it('drops only the additive ledger on an explicitly controlled rollback', async () => {
    const { runner, statements } = stub();
    await new Migration().down(runner);
    expect(statements).toEqual(['DROP TABLE IF EXISTS trading.demo_profit_stop_amendment_intents']);
  });
});
