import { QueryRunner } from 'typeorm';
import { AddOrderProviderNativeIdentifiers1795220000000 } from './migrations/1795220000000-AddOrderProviderNativeIdentifiers';

describe('Order native identifier separation migration is additive and reversible', () => {
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

  it('adds provider_position_id and provider_deal_id without touching existing data', async () => {
    const { runner, statements } = collect();
    await new AddOrderProviderNativeIdentifiers1795220000000().up(runner);
    const sql = statements.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS provider_position_id varchar(255) NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS provider_deal_id varchar(255) NULL');
    // Non-empty-string guard — NULL stays legal for legacy rows.
    expect(sql).toContain("provider_position_id IS NULL OR provider_position_id <> ''");
    expect(sql).toContain("provider_deal_id IS NULL OR provider_deal_id <> ''");
    expect(sql).toContain('COMMENT ON COLUMN trading.orders.provider_position_id');
    expect(sql).toContain('COMMENT ON COLUMN trading.orders.provider_deal_id');
    // Duplicate-deal attribution guard: partial unique index, one native deal
    // per broker connection, NULL/'' outside the index (legacy rows untouched).
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_provider_deal_id');
    expect(sql).toContain('ON trading.orders (broker_connection_id, provider_deal_id)');
    expect(sql).toContain("WHERE provider_deal_id IS NOT NULL AND provider_deal_id <> ''");
    expect(sql).toContain('COMMENT ON INDEX trading.uq_orders_provider_deal_id');
    // Additive only — no rewrite of existing identifier columns or rows.
    expect(sql).not.toMatch(/UPDATE\s+trading\.orders/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN\s+provider_order_id/i);
    // No NOT NULL constraints on the added columns (a partial-index predicate
    // legitimately references IS NOT NULL — scope the check to ADD COLUMN).
    expect(sql).not.toMatch(/ADD\s+COLUMN[^(]*NOT\s+NULL/i);
  });

  it('drops exactly the added constraint, index and columns on rollback', async () => {
    const { runner, statements } = collect();
    await new AddOrderProviderNativeIdentifiers1795220000000().down(runner);
    const sql = statements.join('\n');
    expect(sql).toContain('DROP COLUMN IF EXISTS provider_position_id');
    expect(sql).toContain('DROP COLUMN IF EXISTS provider_deal_id');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS ck_orders_native_identifier_shape');
    expect(sql).toContain('DROP INDEX IF EXISTS trading.uq_orders_provider_deal_id');
    expect(sql).not.toMatch(/DROP\s+COLUMN\s+provider_order_id/i);
  });
});
