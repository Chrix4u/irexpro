import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { OrderFillEvidence } from './order-fill-evidence.entity';

/**
 * Order-fill-evidence schema reconciliation (accounting-integrity
 * correction 2026-11-25).
 *
 * Verifies that every column mapped by the OrderFillEvidence entity has a
 * corresponding column in migration 1795564800000's CREATE TABLE
 * trading.order_fill_evidence, and that the ledger's defining guarantees —
 * the connection-scoped partial unique index on the native deal id and the
 * append-only trigger — are part of the same migration.
 *
 * Source-level test — no running database required (same pattern as
 * order.schema-reconciliation.spec.ts).
 */
describe('OrderFillEvidence ledger schema reconciliation', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../../database/migrations/1795564800000-CreateOrderFillEvidenceLedger.ts',
  );
  let migrationSource: string;

  beforeAll(() => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    migrationSource = fs.readFileSync(migrationPath, 'utf-8');
  });

  /** Extract ledger column names from real TypeORM decorator metadata. */
  function extractLedgerColumnNames(): string[] {
    return getMetadataArgsStorage()
      .columns.filter((c) => c.target === OrderFillEvidence)
      .map((c) => {
        const explicit = (c.options as { name?: string }).name;
        return explicit ?? c.propertyName;
      });
  }

  /** Extract column names from CREATE TABLE trading.order_fill_evidence. */
  function extractLedgerTableColumns(source: string): Set<string> {
    const match = source.match(
      /CREATE TABLE IF NOT EXISTS trading\.order_fill_evidence \(([\s\S]*?)\n      \)/,
    );
    expect(match).not.toBeNull();
    const body = match![1]!;
    const columns = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      const columnMatch = line.match(/^([a-z_]+)\s+(uuid|varchar|numeric|timestamptz)\b/);
      if (columnMatch) columns.add(columnMatch[1]!);
    }
    return columns;
  }

  it('every entity column exists in the ledger migration (and vice versa)', () => {
    const entityColumns = new Set(extractLedgerColumnNames());
    const migrationColumns = extractLedgerTableColumns(migrationSource);

    expect(entityColumns.size).toBeGreaterThan(0);
    for (const column of entityColumns) {
      expect(migrationColumns.has(column)).toBe(true);
    }
    for (const column of migrationColumns) {
      expect(entityColumns.has(column)).toBe(true);
    }
  });

  it('monetary columns are exact-decimal NUMERIC (never float/double)', () => {
    expect(migrationSource).toContain('quantity numeric(10,4) NOT NULL');
    expect(migrationSource).toContain('price numeric(18,8) NOT NULL');
    expect(migrationSource).not.toMatch(/order_fill_evidence[^;]*(float8|double precision|real)/i);
  });

  it('the connection-scoped partial unique index guards native deal attribution', () => {
    expect(migrationSource).toContain('uq_order_fill_evidence_deal');
    expect(migrationSource).toContain(
      'ON trading.order_fill_evidence (broker_connection_id, provider_deal_id)',
    );
    expect(migrationSource).toContain(
      "WHERE provider_deal_id IS NOT NULL AND provider_deal_id <> ''",
    );
  });

  it('the append-only trigger forbids UPDATE and DELETE of ledger rows', () => {
    expect(migrationSource).toContain('fn_order_fill_evidence_append_only()');
    expect(migrationSource).toContain('BEFORE UPDATE OR DELETE ON trading.order_fill_evidence');
    expect(migrationSource).toContain('RAISE EXCEPTION');
  });

  it('ledger rows are bound to their order (ON DELETE RESTRICT — history preservation)', () => {
    expect(migrationSource).toContain(
      'order_id uuid NOT NULL REFERENCES trading.orders(id) ON DELETE RESTRICT',
    );
  });

  it('the entity has no update path (immutable — created-only timestamp)', () => {
    const entitySource = fs.readFileSync(
      path.resolve(__dirname, './order-fill-evidence.entity.ts'),
      'utf-8',
    );
    expect(entitySource).not.toContain('@UpdateDateColumn');
    expect(entitySource).toContain('@CreateDateColumn');
    expect(entitySource).not.toMatch(/@Column[\s\S]{0,200}nullable:\s*false[\s\S]{0,200}updated/i);
  });
});
