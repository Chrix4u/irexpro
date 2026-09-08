import * as fs from 'fs';
import * as path from 'path';

/**
 * BrokerConnection entity-to-migration schema reconciliation test.
 *
 * Hotfix: this test verifies that every column mapped by the BrokerConnection
 * entity has a corresponding column in the migration that creates the
 * broker_connections table (or a subsequent ALTER migration). This catches
 * the exact bug that caused:
 *   QueryFailedError: column conn.last_sync_at does not exist
 *
 * The test reads the entity source (for @Column name annotations) and the
 * migration source (for CREATE TABLE / ADD COLUMN statements), then verifies
 * every entity column name appears in at least one migration.
 */
describe('BrokerConnection schema reconciliation (hotfix)', () => {
  const entityPath = path.resolve(__dirname, './entities/broker-connection.entity.ts');
  const baselineMigrationPath = path.resolve(
    __dirname,
    '../../database/migrations/1750800000000-CreateBaselineIdentityAndPlatformSchema.ts',
  );
  const reconcileMigrationPath = path.resolve(
    __dirname,
    '../../database/migrations/1752100000000-ReconcileBrokerConnectionSchema.ts',
  );
  // Sprint 50 — authorization state machine columns live in their own migration
  const authorizationMigrationPath = path.resolve(
    __dirname,
    '../../database/migrations/1753400000000-AddBrokerAuthorizationStateMachine.ts',
  );

  let entitySource: string;
  let baselineSource: string;
  let reconcileSource: string;
  let authorizationSource: string;

  beforeAll(() => {
    entitySource = fs.readFileSync(entityPath, 'utf-8');
    baselineSource = fs.readFileSync(baselineMigrationPath, 'utf-8');
    expect(fs.existsSync(reconcileMigrationPath)).toBe(true);
    reconcileSource = fs.readFileSync(reconcileMigrationPath, 'utf-8');
    expect(fs.existsSync(authorizationMigrationPath)).toBe(true);
    authorizationSource = fs.readFileSync(authorizationMigrationPath, 'utf-8');
  });

  /**
   * Extract all @Column({ name: 'xxx' }) column names from the entity source.
   * Only matches lines that start with @Column, @CreateDateColumn, etc.
   * (NOT @Entity which also has a name: property).
   */
  function extractEntityColumnNames(source: string): string[] {
    const names: string[] = [];
    const lines = source.split('\n');
    for (const line of lines) {
      // Only match decorator lines that define columns (not @Entity)
      if (
        line.includes('@Column') ||
        line.includes('@CreateDateColumn') ||
        line.includes('@UpdateDateColumn') ||
        line.includes('@DeleteDateColumn') ||
        line.includes('@PrimaryGeneratedColumn')
      ) {
        const match = line.match(/name:\s*['"]([^'"]+)['"]/);
        if (match && match[1]) {
          names.push(match[1]);
        }
      }
    }
    return names;
  }

  /**
   * Extract all column names from migration CREATE TABLE and ADD COLUMN statements.
   */
  function extractMigrationColumnNames(source: string): Set<string> {
    const columns = new Set<string>();
    // Match column names in CREATE TABLE blocks (indented column definitions)
    const createTableRegex = /CREATE TABLE[^;]+broker_connections\s*\(([^;]+)\)/gis;
    let match: RegExpExecArray | null;
    while ((match = createTableRegex.exec(source)) !== null) {
      const tableBody = match[1];
      // Each line is like "  column_name  type ..."
      for (const line of tableBody.split('\n')) {
        const trimmed = line.trim().replace(/,$/, '').trim();
        if (
          !trimmed ||
          trimmed.startsWith('--') ||
          trimmed.startsWith('PRIMARY') ||
          trimmed.startsWith('CONSTRAINT')
        ) {
          continue;
        }
        const colName = trimmed.split(/\s+/)[0];
        if (colName && !colName.startsWith('(')) {
          columns.add(colName);
        }
      }
    }
    // Match ADD COLUMN IF NOT EXISTS column_name
    const addColumnRegex = /ADD COLUMN IF NOT EXISTS\s+(\w+)/gi;
    while ((match = addColumnRegex.exec(source)) !== null) {
      if (match[1]) columns.add(match[1]);
    }
    return columns;
  }

  it('should have a reconciliation migration file', () => {
    expect(fs.existsSync(reconcileMigrationPath)).toBe(true);
  });

  it('reconciliation migration should use ADD COLUMN IF NOT EXISTS (non-destructive)', () => {
    expect(reconcileSource).toContain('ADD COLUMN IF NOT EXISTS');
    // The up() method must NOT drop existing columns (down() is allowed to reverse)
    // Extract only the up() method body by splitting on 'public async down'
    const upStart = reconcileSource.indexOf('public async up');
    const downStart = reconcileSource.indexOf('public async down');
    const upBody =
      upStart >= 0 && downStart >= 0 ? reconcileSource.substring(upStart, downStart) : '';
    expect(upBody).not.toMatch(/DROP COLUMN.*failure_count/i);
    expect(upBody).not.toMatch(/DROP COLUMN.*currency/i);
  });

  it('reconciliation migration should default live_trading_enabled to false', () => {
    expect(reconcileSource).toMatch(/live_trading_enabled boolean NOT NULL DEFAULT false/);
  });

  it('reconciliation migration should be ordered after 1752000000000', () => {
    // The filename starts with 1752100000000 which is > 1752000000000
    expect(reconcileMigrationPath).toContain('1752100000000');
  });

  it('every BrokerConnection entity column should exist in a migration', () => {
    const entityColumns = extractEntityColumnNames(entitySource);
    expect(entityColumns.length).toBeGreaterThan(0);

    const baselineColumns = extractMigrationColumnNames(baselineSource);
    const reconcileColumns = extractMigrationColumnNames(reconcileSource);
    const authorizationColumns = extractMigrationColumnNames(authorizationSource);
    const allMigrationColumns = new Set([
      ...baselineColumns,
      ...reconcileColumns,
      ...authorizationColumns,
    ]);

    // Every entity column must appear in at least one migration
    const missing: string[] = [];
    for (const col of entityColumns) {
      if (!allMigrationColumns.has(col)) {
        missing.push(col);
      }
    }

    expect(missing).toEqual([]);
  });

  // Specifically verify the columns that were missing before the hotfix
  it('last_sync_at should exist in the reconciliation migration', () => {
    const reconcileColumns = extractMigrationColumnNames(reconcileSource);
    expect(reconcileColumns.has('last_sync_at')).toBe(true);
  });

  it('consecutive_failure_count should exist in the reconciliation migration', () => {
    const reconcileColumns = extractMigrationColumnNames(reconcileSource);
    expect(reconcileColumns.has('consecutive_failure_count')).toBe(true);
  });

  it('live_trading_enabled should exist in the reconciliation migration', () => {
    const reconcileColumns = extractMigrationColumnNames(reconcileSource);
    expect(reconcileColumns.has('live_trading_enabled')).toBe(true);
  });

  it('account_currency should exist in the reconciliation migration', () => {
    const reconcileColumns = extractMigrationColumnNames(reconcileSource);
    expect(reconcileColumns.has('account_currency')).toBe(true);
  });

  it('account_leverage should exist in the reconciliation migration', () => {
    const reconcileColumns = extractMigrationColumnNames(reconcileSource);
    expect(reconcileColumns.has('account_leverage')).toBe(true);
  });

  it('reconciliation migration should migrate data from failure_count to consecutive_failure_count', () => {
    expect(reconcileSource).toContain('failure_count');
    expect(reconcileSource).toMatch(/consecutive_failure_count = failure_count/);
  });

  it('reconciliation migration should migrate data from currency to account_currency', () => {
    expect(reconcileSource).toContain('currency');
    expect(reconcileSource).toMatch(/account_currency = currency/);
  });
});
