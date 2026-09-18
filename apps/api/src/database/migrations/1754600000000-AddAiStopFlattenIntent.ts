import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Novice AI Trading Start/Stop hardening.
 *
 * The marker is intentionally stored on the trading session rather than
 * inferred from status or audit history. Existing ENDED/suspended sessions
 * default to false, so deploying the new Stop semantics can never
 * retroactively flatten historical positions.
 *
 * New explicit Stop AI Trading requests set this marker in the same CAS that
 * revokes session execution authority. The reconciliation worker then uses it
 * to close any AI position that appears late from a provider dispatch that had
 * already crossed the final dispatch commitment before Stop.
 */
export class AddAiStopFlattenIntent1754600000000 implements MigrationInterface {
  name = 'AddAiStopFlattenIntent1754600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      ADD COLUMN IF NOT EXISTS close_ai_positions_on_stop boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_trading_sessions_ai_stop_flatten
      ON trading.trading_sessions (broker_connection_id, close_ai_positions_on_stop)
      WHERE close_ai_positions_on_stop = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS trading.ix_trading_sessions_ai_stop_flatten
    `);
    await queryRunner.query(`
      ALTER TABLE trading.trading_sessions
      DROP COLUMN IF EXISTS close_ai_positions_on_stop
    `);
  }
}
