import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist the read-side indexes installed online on 2026-11-12 after high
 * CPU / status-query timeouts. No model or execution policies are changed.
 *
 * On a populated trading database, create these with CONCURRENTLY before
 * running migrations; these idempotent statements then become no-ops.
 */
export class AccelerateM1AndShadowDecisionReads1794486000000 implements MigrationInterface {
  name = 'AccelerateM1AndShadowDecisionReads1794486000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_m1_tactical_user_bar_time
      ON trading.m1_tactical_decisions (user_id, bar_time DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_m1_tactical_broker_eval_time
      ON trading.m1_tactical_decisions (broker_connection_id, evaluated_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_ensemble_shadow_user_broker_engine_time
      ON trading.ensemble_shadow_decisions
        (user_id, broker_connection_id, engine_code, evaluated_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS trading.ix_ensemble_shadow_user_broker_engine_time`);
    await queryRunner.query(`DROP INDEX IF EXISTS trading.ix_m1_tactical_broker_eval_time`);
    await queryRunner.query(`DROP INDEX IF EXISTS trading.ix_m1_tactical_user_bar_time`);
  }
}
