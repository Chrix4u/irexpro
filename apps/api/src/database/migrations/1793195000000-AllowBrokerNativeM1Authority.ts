import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The M1 decision ledger originally predated provider-DEMO promotion and only
 * admitted NONE/PAPER_ONLY_RESEARCH. DEMO_FULL_AUTO now persists broker-native
 * execution authority before dispatch, so the durable database contract must
 * admit BROKER_NATIVE as well.
 */
export class AllowBrokerNativeM1Authority1793195000000 implements MigrationInterface {
  name = 'AllowBrokerNativeM1Authority1793195000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.m1_tactical_decisions
      DROP CONSTRAINT IF EXISTS chk_m1_tactical_authority
    `);
    await queryRunner.query(`
      ALTER TABLE trading.m1_tactical_decisions
      ADD CONSTRAINT chk_m1_tactical_authority
      CHECK (execution_authority IN ('NONE', 'PAPER_ONLY_RESEARCH', 'BROKER_NATIVE'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM trading.m1_tactical_decisions
      WHERE execution_authority = 'BROKER_NATIVE'
    `)) as Array<{ count: number | string }>;
    const brokerNativeCount = Number(rows[0]?.count ?? 0);
    if (brokerNativeCount > 0) {
      throw new Error(
        `Cannot roll back BROKER_NATIVE M1 authority while ${brokerNativeCount} durable decision row(s) use it`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE trading.m1_tactical_decisions
      DROP CONSTRAINT IF EXISTS chk_m1_tactical_authority
    `);
    await queryRunner.query(`
      ALTER TABLE trading.m1_tactical_decisions
      ADD CONSTRAINT chk_m1_tactical_authority
      CHECK (execution_authority IN ('NONE', 'PAPER_ONLY_RESEARCH'))
    `);
  }
}
