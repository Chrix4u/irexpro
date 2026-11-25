import type { QueryRunner } from 'typeorm';
import { CreateOrderFillEvidenceLedger1795564800000 } from './1795564800000-CreateOrderFillEvidenceLedger';

/**
 * Accounting-integrity correction 2026-11-25 — regression spec for the
 * immutable per-fill accounting evidence ledger migration.
 *
 * The migration must be ADDITIVE and replay-detectable-forever:
 * - CREATE TABLE (no data rewrite, no backfill of historical fills —
 *   pre-ledger fills are never fabricated into rows),
 * - partial unique index uq_order_fill_evidence_deal
 *   (broker_connection_id, provider_deal_id) WHERE provider_deal_id IS
 *   NOT NULL AND <> '' — one native deal credited to at most ONE internal
 *   fill per connection, NULLs outside the index,
 * - append-only enforcement trigger on UPDATE OR DELETE,
 * - symmetric down() that drops trigger, function, table (indexes go with
 *   the table) and nothing else.
 */
describe('order fill evidence ledger migration', () => {
  function capturingQueryRunner(): { queryRunner: QueryRunner; sql: string[] } {
    const sql: string[] = [];
    const queryRunner = {
      query: jest.fn(async (statement: string) => {
        sql.push(statement);
        return [];
      }),
    } as unknown as QueryRunner;
    return { queryRunner, sql };
  }

  it('creates the append-only ledger with deal-uniqueness and class-parity guards', async () => {
    const { queryRunner, sql } = capturingQueryRunner();
    const migration = new CreateOrderFillEvidenceLedger1795564800000();
    await migration.up(queryRunner);

    const joined = sql.join('\n---\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS trading.order_fill_evidence');
    expect(joined).toContain('quantity numeric(10,4) NOT NULL');
    expect(joined).toContain('price numeric(18,8) NOT NULL');
    // Exact decimal columns for the fill economics.
    expect(joined).toContain('evidence_class varchar(32) NOT NULL');
    // Deal-id parity: PROVIDER_DEAL grade iff a native deal id exists.
    expect(joined).toContain('ck_order_fill_evidence_class_consistent CHECK');
    expect(joined).toContain("(evidence_class = 'PROVIDER_DEAL') = (provider_deal_id IS NOT NULL)");
    // The partial unique index — the replay/duplicate-attribution core.
    expect(joined).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_order_fill_evidence_deal');
    expect(joined).toContain(
      'ON trading.order_fill_evidence (broker_connection_id, provider_deal_id)',
    );
    expect(joined).toContain("WHERE provider_deal_id IS NOT NULL AND provider_deal_id <> ''");
    // History preservation: an order with booked fills cannot be deleted.
    expect(joined).toContain('REFERENCES trading.orders(id) ON DELETE RESTRICT');
    // Append-only enforcement at the database level.
    expect(joined).toContain('fn_order_fill_evidence_append_only()');
    expect(joined).toContain('BEFORE UPDATE OR DELETE ON trading.order_fill_evidence');
    expect(joined).toContain('RAISE EXCEPTION');
    // Identifier shape — no empty-string identifiers on any native column.
    expect(joined).toContain('ck_order_fill_evidence_identifier_shape CHECK');
  });

  it('up() never rewrites or fabricates historical fill rows (schema-only, no backfill)', async () => {
    const { queryRunner, sql } = capturingQueryRunner();
    const migration = new CreateOrderFillEvidenceLedger1795564800000();
    await migration.up(queryRunner);

    for (const statement of sql) {
      expect(statement).not.toMatch(/INSERT\s+INTO\s+trading\.order_fill_evidence/i);
      expect(statement).not.toMatch(/INSERT\s+INTO.*SELECT/i);
      expect(statement).not.toMatch(/UPDATE\s+trading\.orders/i);
      expect(statement).not.toMatch(/DELETE\s+FROM\s+trading\.orders/i);
    }
  });

  it('down() drops the trigger, the function and the table — nothing else', async () => {
    const { queryRunner, sql } = capturingQueryRunner();
    const migration = new CreateOrderFillEvidenceLedger1795564800000();
    await migration.down(queryRunner);

    expect(sql).toHaveLength(3);
    expect(sql[0]).toContain('DROP TRIGGER IF EXISTS trg_order_fill_evidence_append_only');
    expect(sql[1]).toContain(
      'DROP FUNCTION IF EXISTS trading.fn_order_fill_evidence_append_only()',
    );
    expect(sql[2]).toContain('DROP TABLE IF EXISTS trading.order_fill_evidence');
    // The rollback must never touch the order rows or their identifiers.
    for (const statement of sql) {
      expect(statement).not.toMatch(/ALTER\s+TABLE\s+trading\.orders/i);
      expect(statement).not.toMatch(/DROP\s+(COLUMN|INDEX).*provider_deal_id/i);
    }
  });

  it('up() and down() are idempotent-guarded (IF EXISTS / IF NOT EXISTS)', async () => {
    const up = capturingQueryRunner();
    const migration = new CreateOrderFillEvidenceLedger1795564800000();
    await migration.up(up.queryRunner);
    expect(up.sql.join('\n')).toContain('CREATE TABLE IF NOT EXISTS');
    expect(up.sql.join('\n')).toContain('CREATE OR REPLACE FUNCTION');

    const down = capturingQueryRunner();
    await migration.down(down.queryRunner);
    expect(down.sql.join('\n')).toContain('DROP TRIGGER IF EXISTS');
    expect(down.sql.join('\n')).toContain('DROP FUNCTION IF EXISTS');
    expect(down.sql.join('\n')).toContain('DROP TABLE IF EXISTS');
  });
});
