import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { Order } from './order.entity';

/**
 * Order-domain schema reconciliation (Sprint 50 PR-2).
 *
 * Verifies that every column mapped by the Order entity has a corresponding
 * column in the migration that creates trading.orders, and that the three
 * new position columns on the Trade entity (external_position_id,
 * commission, swap) exist in the same migration's ALTER TABLE statements.
 *
 * Source-level test — no running database required (same pattern as
 * broker-connection.schema-reconciliation.spec.ts).
 */
describe('Order domain schema reconciliation', () => {
  const tradeEntityPath = path.resolve(__dirname, '../entities/trade.entity.ts');
  const migrationPath = path.resolve(
    __dirname,
    '../../../database/migrations/1753600000000-CreateNormalizedOrderDomain.ts',
  );

  let tradeEntitySource: string;
  let migrationSource: string;

  beforeAll(() => {
    tradeEntitySource = fs.readFileSync(tradeEntityPath, 'utf-8');
    expect(fs.existsSync(migrationPath)).toBe(true);
    migrationSource = fs.readFileSync(migrationPath, 'utf-8');
  });

  /**
   * Extract Order column names from real TypeORM decorator metadata
   * (robust to multi-line decorators — same approach as
   * schema-hardening-phase2a.spec.ts).
   */
  function extractOrderColumnNames(): string[] {
    return getMetadataArgsStorage()
      .columns.filter((c) => c.target === Order)
      .map((c) => {
        const explicit = (c.options as { name?: string }).name;
        return explicit ?? c.propertyName;
      });
  }

  /** Extract column names from CREATE TABLE "trading"."orders" block. */
  function extractOrdersTableColumns(source: string): Set<string> {
    const columns = new Set<string>();
    const match = source.match(
      /CREATE TABLE IF NOT EXISTS "trading"\."orders"\s*\(([\s\S]+?)\n\s*\)/,
    );
    expect(match).not.toBeNull();
    const body = match![1];
    for (const line of body.split('\n')) {
      const colMatch = line.match(/^\s*"([a-z_0-9]+)"/);
      if (colMatch && !line.includes('CONSTRAINT')) columns.add(colMatch[1]);
    }
    return columns;
  }

  it('every Order entity column exists in the CREATE TABLE block', () => {
    const entityColumns = extractOrderColumnNames();
    expect(entityColumns.length).toBeGreaterThanOrEqual(23);

    const migrationColumns = extractOrdersTableColumns(migrationSource);

    const missing = entityColumns.filter((c) => !migrationColumns.has(c));
    if (missing.length > 0) {
      throw new Error(`Entity columns missing from migration: ${missing.join(', ')}`);
    }
  });

  it('the idempotency_key unique index exists', () => {
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "uq_orders_idempotency_key"/,
    );
    expect(migrationSource).toMatch(/ON "trading"\."orders" \("idempotency_key"\)/);
  });

  it('the state-machine CHECK constraint covers all nine OrderStatus values', () => {
    const match = migrationSource.match(
      /CONSTRAINT "chk_orders_status" CHECK \("status" IN \(([\s\S]+?)\)/,
    );
    expect(match).not.toBeNull();
    const values = (match![1].match(/'([A-Z_]+)'/g) ?? []).map((v) => v.slice(1, -1));
    expect(new Set(values)).toEqual(
      new Set([
        'CREATED',
        'SUBMITTED',
        'ACKNOWLEDGED',
        'PARTIALLY_FILLED',
        'FILLED',
        'REJECTED',
        'CANCELLED',
        'EXPIRED',
        'RECONCILIATION_PENDING',
      ]),
    );
  });

  it('order_kind / time_in_force / direction CHECK constraints exist', () => {
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_kind" CHECK/);
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_tif" CHECK/);
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_direction" CHECK/);
  });

  it('fill-accounting CHECK constraints exist (quantity/fill invariants)', () => {
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_quantity_positive"/);
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_filled_range"/);
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_fill_price_consistency"/);
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_price_kind"/);
    expect(migrationSource).toMatch(/CONSTRAINT "chk_orders_filled_implies_submitted"/);
  });

  it('price-kind CHECK covers all four order kinds', () => {
    const match = migrationSource.match(
      /CONSTRAINT "chk_orders_price_kind" CHECK \(([\s\S]+?)\n\s*\)/,
    );
    expect(match).not.toBeNull();
    const body = match![1];
    for (const kind of ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']) {
      expect(body).toContain(`'${kind}'`);
    }
  });

  it('every new Trade position column has an ADD COLUMN in the migration', () => {
    const newTradeColumns = ['external_position_id', 'commission', 'swap'];
    for (const col of newTradeColumns) {
      const entityDeclaresIt = new RegExp(`@Column\\(\\{[^}]*name: '${col}'`).test(
        tradeEntitySource,
      );
      if (!entityDeclaresIt) {
        throw new Error(`Trade entity must declare ${col}`);
      }

      const migrationAddsIt = migrationSource.includes(`ADD COLUMN IF NOT EXISTS "${col}"`);
      if (!migrationAddsIt) {
        throw new Error(`Migration must ADD COLUMN ${col} to trading.trades`);
      }
    }
  });

  it('backfill for the new trade columns is conservative (NULL — no fabricated values)', () => {
    // Only the up() section counts — down() legitimately re-touches trades.
    const upSection = migrationSource.split('public async down')[0];
    // The only statements touching trading.trades are the three ADD COLUMNs;
    // there is deliberately no UPDATE backfill for the new columns.
    const tradesStatements = upSection.match(/ALTER TABLE "trading"\."trades"/g) ?? [];
    expect(tradesStatements.length).toBe(3);
    expect(upSection).not.toMatch(/UPDATE "trading"\."trades"/);
  });

  it('down() reverses the table, indexes, and added columns', () => {
    const downMatch = migrationSource.match(/public async down[\s\S]+$/);
    expect(downMatch).not.toBeNull();
    const down = downMatch![0];
    expect(down).toContain('DROP TABLE IF EXISTS "trading"."orders"');
    expect(down).toContain('DROP COLUMN IF EXISTS "external_position_id"');
    expect(down).toContain('DROP COLUMN IF EXISTS "commission"');
    expect(down).toContain('DROP COLUMN IF EXISTS "swap"');
    expect(down).toContain('DROP INDEX IF EXISTS "trading"."uq_orders_idempotency_key"');
  });

  it('Order entity is registered in the module (TypeOrmModule.forFeature)', () => {
    const moduleSource = fs.readFileSync(
      path.resolve(__dirname, '../execution.module.ts'),
      'utf-8',
    );
    expect(moduleSource).toMatch(/TypeOrmModule\.forFeature\(\[Trade, TradingSession, Order\]\)/);
    expect(moduleSource).toMatch(/providers:\s*\[[\s\S]*?OrderService/);
    expect(moduleSource).toMatch(/exports:\s*\[[\s\S]*?OrderService/);
  });
});
