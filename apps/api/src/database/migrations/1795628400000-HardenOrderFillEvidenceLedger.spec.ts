import type { QueryRunner } from 'typeorm';
import { HardenOrderFillEvidenceLedger1795628400000 } from './1795628400000-HardenOrderFillEvidenceLedger';

/**
 * Independent-review correction round (PR #805, findings 1/3/5/6) —
 * regression spec for the ledger HARDENING migration 1795628400000.
 *
 * up() must remain ADDITIVE (no data rewrite, no backfill) and install:
 * - the LEGACY_BASELINE evidence class (baseline transcription of pre-ledger
 *   cumulative accounting — never fabricated per-fill deals) in both CHECKs,
 * - the BEFORE TRUNCATE statement trigger with the operator escape GUC
 *   (UPDATE/DELETE row trigger alone did not cover TRUNCATE),
 * - referential consistency: FK (order_id, broker_connection_id) → the
 *   trading.orders superkey (the ledger's connection must MATCH the order's)
 *   and FK broker_connection_id → broker.broker_connections (RESTRICT).
 *
 * down() must REFUSE to dismantle while booked evidence exists (unless the
 * operator sets IREXPRO_DESTROY_LEDGER_EVIDENCE=1 after exporting), and on
 * the empty ledger restore the original 4-class CHECKs and drop only its own
 * objects — never touching 1795564800000's table.
 */
describe('order fill evidence ledger HARDENING migration (1795628400000)', () => {
  function capturingQueryRunner(
    resultFor?: (statement: string) => Array<Record<string, unknown>>,
  ): { queryRunner: QueryRunner; sql: string[] } {
    const sql: string[] = [];
    const queryRunner = {
      query: jest.fn(async (statement: string) => {
        sql.push(statement);
        return resultFor ? resultFor(statement) : [];
      }),
    } as unknown as QueryRunner;
    return { queryRunner, sql };
  }

  it('up() installs the LEGACY_BASELINE class, the TRUNCATE trigger, and both referential FKs', async () => {
    const { queryRunner, sql } = capturingQueryRunner();
    const migration = new HardenOrderFillEvidenceLedger1795628400000();
    await migration.up(queryRunner);

    const joined = sql.join('\n---\n');
    // 1. LEGACY_BASELINE admitted by the class CHECK...
    expect(joined).toContain('ck_order_fill_evidence_class CHECK');
    expect(joined).toContain("'PROVIDER_ORDER_STATE','LEGACY_BASELINE'");
    // ...with the honest parity: PROVIDER_DEAL requires a deal id,
    // LEGACY_BASELINE may carry the retained legacy pointer, weaker classes
    // carry NULL.
    expect(joined).toContain("(evidence_class = 'PROVIDER_DEAL' AND provider_deal_id IS NOT NULL)");
    expect(joined).toContain("(evidence_class = 'LEGACY_BASELINE')");
    // 2. TRUNCATE refusal with the operator escape (role/privilege notes
    //    in the migration header — the GUC grants nothing by itself).
    expect(joined).toContain('fn_order_fill_evidence_no_truncate()');
    expect(joined).toContain('BEFORE TRUNCATE ON trading.order_fill_evidence');
    expect(joined).toContain("current_setting('irexpro.allow_ledger_truncate', true)");
    // 3a. Pair-consistency FK via the superkey unique index.
    expect(joined).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_id_broker_connection');
    expect(joined).toContain('fk_order_fill_evidence_order_connection');
    expect(joined).toContain('REFERENCES trading.orders (id, broker_connection_id)');
    // 3b. Broker-connection existence FK.
    expect(joined).toContain('REFERENCES broker.broker_connections (id)');
    expect(joined).toContain('ON DELETE RESTRICT');
  });

  it('up() never rewrites or fabricates ledger/order data (schema-only, no backfill)', async () => {
    const { queryRunner, sql } = capturingQueryRunner();
    const migration = new HardenOrderFillEvidenceLedger1795628400000();
    await migration.up(queryRunner);

    for (const statement of sql) {
      expect(statement).not.toMatch(/INSERT\s+INTO\s+trading\.order_fill_evidence/i);
      expect(statement).not.toMatch(/INSERT\s+INTO.*SELECT/i);
      expect(statement).not.toMatch(/UPDATE\s+trading\.order/i);
      expect(statement).not.toMatch(/DELETE\s+FROM\s+trading\./i);
    }
  });

  it('down() REFUSES while booked evidence exists (protective refusal, finding 6)', async () => {
    const { queryRunner } = capturingQueryRunner((statement) =>
      statement.includes('COUNT(*)')
        ? [{ n: 7 }] // 7 booked accounting-evidence rows
        : [],
    );
    const migration = new HardenOrderFillEvidenceLedger1795628400000();
    await expect(migration.down(queryRunner)).rejects.toThrow(
      /still holds 7 booked accounting-evidence row/,
    );
    // The refusal message names the export-first procedure and the
    // operator override.
    await expect(migration.down(queryRunner)).rejects.toThrow(/Export the evidence first/);
    await expect(migration.down(queryRunner)).rejects.toThrow(/IREXPRO_DESTROY_LEDGER_EVIDENCE=1/);
  });

  it('down() with the operator override on a POPULATED ledger drops the protections but does NOT attempt the impossible CHECK restoration', async () => {
    // LEGACY_BASELINE rows would violate the original 4-class CHECK — the
    // populated+override path skips the cosmetic restoration (the revert
    // chain's next step drops the table the operator chose to destroy
    // after exporting) and only removes this migration's protections.
    const previous = process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE;
    process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE = '1';
    try {
      const { queryRunner, sql } = capturingQueryRunner((statement) =>
        statement.includes('COUNT(*)') ? [{ n: 5 }] : [],
      );
      const migration = new HardenOrderFillEvidenceLedger1795628400000();
      await migration.down(queryRunner);
      const joined = sql.join('\n');
      expect(joined).toContain('DROP TRIGGER IF EXISTS trg_order_fill_evidence_no_truncate');
      expect(joined).toContain(
        'DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_broker_connection',
      );
      expect(joined).toContain('DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_order_connection');
      expect(joined).toContain(
        'DROP FUNCTION IF EXISTS trading.fn_order_fill_evidence_no_truncate()',
      );
      expect(joined).toContain('DROP INDEX IF EXISTS trading.uq_orders_id_broker_connection');
      // The impossible restoration is skipped — no ADD CONSTRAINT with the
      // 4-class form on a populated ledger.
      expect(joined).not.toContain('ADD CONSTRAINT ck_order_fill_evidence_class CHECK');
      expect(joined).not.toContain('ADD CONSTRAINT ck_order_fill_evidence_class_consistent');
    } finally {
      if (previous === undefined) delete process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE;
      else process.env.IREXPRO_DESTROY_LEDGER_EVIDENCE = previous;
    }
  });

  it('down() on an EMPTY ledger restores the original 4-class CHECKs and drops only its own objects', async () => {
    const { queryRunner, sql } = capturingQueryRunner((statement) =>
      statement.includes('COUNT(*)') ? [{ n: 0 }] : [],
    );
    const migration = new HardenOrderFillEvidenceLedger1795628400000();
    await migration.down(queryRunner);

    const joined = sql.join('\n---\n');
    // Protective count first.
    expect(sql[0]).toContain('COUNT(*)');
    // The original CHECKs restored (byte-compatible with 1795564800000).
    expect(joined).toContain("(evidence_class = 'PROVIDER_DEAL') = (provider_deal_id IS NOT NULL)");
    expect(joined).toContain(
      "'PROVIDER_DEAL','POSITION_FACTS','PROVIDER_RESPONSE','PROVIDER_ORDER_STATE'",
    );
    // Its own objects only.
    expect(joined).toContain('DROP TRIGGER IF EXISTS trg_order_fill_evidence_no_truncate');
    expect(joined).toContain(
      'DROP FUNCTION IF EXISTS trading.fn_order_fill_evidence_no_truncate()',
    );
    expect(joined).toContain('DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_broker_connection');
    expect(joined).toContain('DROP CONSTRAINT IF EXISTS fk_order_fill_evidence_order_connection');
    expect(joined).toContain('DROP INDEX IF EXISTS trading.uq_orders_id_broker_connection');
    // It must NOT drop the ledger table or the append-only row trigger —
    // those belong to 1795564800000 (reverted only afterwards, and only
    // after the refusal above has been consciously overridden).
    for (const statement of sql) {
      expect(statement).not.toMatch(/DROP\s+TABLE/i);
      expect(statement).not.toMatch(/DROP\s+TRIGGER.*append_only/i);
      expect(statement).not.toMatch(/UPDATE\s+trading\./i);
      expect(statement).not.toMatch(/DELETE\s+FROM\s+trading\./i);
    }
  });

  it('up() and down() are idempotent-guarded (IF EXISTS / IF NOT EXISTS / OR REPLACE)', async () => {
    const migration = new HardenOrderFillEvidenceLedger1795628400000();

    const up = capturingQueryRunner();
    await migration.up(up.queryRunner);
    const upJoined = up.sql.join('\n');
    expect(upJoined).toContain('CREATE OR REPLACE FUNCTION');
    expect(upJoined).toContain('DROP TRIGGER IF EXISTS trg_order_fill_evidence_no_truncate');
    expect(upJoined).toContain('DROP CONSTRAINT IF EXISTS ck_order_fill_evidence_class');
    expect(upJoined).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_id_broker_connection');

    const down = capturingQueryRunner((statement) =>
      statement.includes('COUNT(*)') ? [{ n: 0 }] : [],
    );
    await migration.down(down.queryRunner);
    const downJoined = down.sql.join('\n');
    expect(downJoined).toContain('DROP TRIGGER IF EXISTS');
    expect(downJoined).toContain('DROP CONSTRAINT IF EXISTS');
    expect(downJoined).toContain('DROP INDEX IF EXISTS');
  });
});
