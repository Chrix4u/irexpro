import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reconcile trading.trading_sessions after migration-history / physical-schema drift.
 *
 * Why this exists:
 * - The baseline trading_sessions table predates execution_mode,
 *   authority_generation, opening-snapshot lineage, and the durable
 *   close_ai_positions_on_stop marker.
 * - Those fields were introduced by later migrations, but a database can
 *   report "No migrations are pending" even when its physical schema has
 *   drifted from the recorded migration history.
 * - The browser active-session read and Start/Stop authority path depend on
 *   these columns. Missing columns surface as 500s and the web app correctly
 *   fails closed with "AI session status could not be verified".
 *
 * This forward migration is intentionally idempotent and non-destructive:
 * - adds only missing columns;
 * - repairs safe defaults / NOT NULL requirements for authority columns;
 * - preserves all existing session rows;
 * - restores only the two safety indexes required by the current model.
 */
export class ReconcileTradingSessionSchema1754800000000 implements MigrationInterface {
  name = 'ReconcileTradingSessionSchema1754800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableRows = await queryRunner.query(`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'trading'
        AND table_name = 'trading_sessions'
      LIMIT 1
    `);

    if (!Array.isArray(tableRows) || tableRows.length === 0) {
      throw new Error(
        'Trading session schema reconciliation failed: trading.trading_sessions does not exist.',
      );
    }

    // Core browser / execution-authority columns.
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS execution_mode varchar(20)
    `);
    await queryRunner.query(`
      UPDATE trading.trading_sessions
      SET execution_mode = 'PAPER_ONLY'
      WHERE execution_mode IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ALTER COLUMN execution_mode SET DEFAULT 'PAPER_ONLY',
      ALTER COLUMN execution_mode SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS authority_generation integer
    `);
    const invalidGeneration = await queryRunner.query(`
      SELECT id, authority_generation
      FROM trading.trading_sessions
      WHERE authority_generation IS NOT NULL
        AND authority_generation < 1
      LIMIT 10
    `);
    if (Array.isArray(invalidGeneration) && invalidGeneration.length > 0) {
      throw new Error(
        'Trading session schema reconciliation failed: an existing authority_generation is below 1. Repair the invalid authority lineage explicitly before deployment.',
      );
    }

    await queryRunner.query(`
      UPDATE trading.trading_sessions
      SET authority_generation = 1
      WHERE authority_generation IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ALTER COLUMN authority_generation SET DEFAULT 1,
      ALTER COLUMN authority_generation SET NOT NULL
    `);

    // Round-6 session lineage used by the full Start/Stop authority path.
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS account_currency varchar(3)
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS opening_snapshot_id uuid
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS opening_snapshot_generation integer
    `);

    // Durable explicit Stop intent used by reconciliation to flatten late fills.
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS close_ai_positions_on_stop boolean
    `);
    await queryRunner.query(`
      UPDATE trading.trading_sessions
      SET close_ai_positions_on_stop = false
      WHERE close_ai_positions_on_stop IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ALTER COLUMN close_ai_positions_on_stop SET DEFAULT false,
      ALTER COLUMN close_ai_positions_on_stop SET NOT NULL
    `);

    // Re-create authority CHECK constraints only when absent.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ck_trading_sessions_execution_mode'
            AND conrelid = 'trading.trading_sessions'::regclass
        ) THEN
          ALTER TABLE trading.trading_sessions
          ADD CONSTRAINT ck_trading_sessions_execution_mode
          CHECK (execution_mode IN ('PAPER_ONLY', 'SEMI_AUTO', 'FULL_AUTO'));
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ck_trading_sessions_authority_generation_nonnegative'
            AND conrelid = 'trading.trading_sessions'::regclass
        ) THEN
          ALTER TABLE trading.trading_sessions
          ADD CONSTRAINT ck_trading_sessions_authority_generation_nonnegative
          CHECK (authority_generation >= 1);
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ck_trading_sessions_account_currency'
            AND conrelid = 'trading.trading_sessions'::regclass
        ) THEN
          ALTER TABLE trading.trading_sessions
          ADD CONSTRAINT ck_trading_sessions_account_currency
          CHECK (account_currency IS NULL OR account_currency ~ '^[A-Z]{3}$');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ck_trading_sessions_opening_snapshot_generation'
            AND conrelid = 'trading.trading_sessions'::regclass
        ) THEN
          ALTER TABLE trading.trading_sessions
          ADD CONSTRAINT ck_trading_sessions_opening_snapshot_generation
          CHECK (opening_snapshot_generation IS NULL OR opening_snapshot_generation >= 1);
        END IF;
      END $$;
    `);

    // Never silently pick a winner if drift allowed multiple ACTIVE sessions.
    const duplicateActive = await queryRunner.query(`
      SELECT user_id, COUNT(*) AS active_count
      FROM trading.trading_sessions
      WHERE status = 'ACTIVE'
      GROUP BY user_id
      HAVING COUNT(*) > 1
    `);
    if (Array.isArray(duplicateActive) && duplicateActive.length > 0) {
      throw new Error(
        `Trading session schema reconciliation failed: duplicate ACTIVE sessions exist for ${duplicateActive.length} user(s). Resolve the duplicate sessions explicitly before restoring the unique authority index.`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_trading_sessions_one_active_per_user
      ON trading.trading_sessions (user_id)
      WHERE status = 'ACTIVE'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_trading_sessions_ai_stop_flatten
      ON trading.trading_sessions (broker_connection_id, close_ai_positions_on_stop)
      WHERE close_ai_positions_on_stop = true
    `);

    const requiredColumns = [
      'execution_mode',
      'authority_generation',
      'account_currency',
      'opening_snapshot_id',
      'opening_snapshot_generation',
      'close_ai_positions_on_stop',
    ];
    const presentColumns = await queryRunner.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'trading'
        AND table_name = 'trading_sessions'
        AND column_name IN (
          'execution_mode',
          'authority_generation',
          'account_currency',
          'opening_snapshot_id',
          'opening_snapshot_generation',
          'close_ai_positions_on_stop'
        )
    `);
    const present = new Set(
      Array.isArray(presentColumns)
        ? presentColumns.map((row: { column_name: string }) => row.column_name)
        : [],
    );
    const missing = requiredColumns.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(
        `Trading session schema reconciliation failed verification; missing columns: ${missing.join(', ')}`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally non-destructive. This migration may have repaired objects
    // that legitimately predated it, so rollback must not remove columns,
    // constraints, or indexes whose provenance cannot be distinguished.
  }
}
