import { MigrationInterface, QueryRunner } from 'typeorm';

export class VersionPerformanceFeePolicies1755000000000 implements MigrationInterface {
  name = 'VersionPerformanceFeePolicies1755000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE performance_fees.performance_fee_policies
      ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS effective_to TIMESTAMPTZ
    `);

    await queryRunner.query(`
      UPDATE performance_fees.performance_fee_policies
      SET effective_from = created_at
      WHERE version = 1
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_perf_fee_policy_active_version
      ON performance_fees.performance_fee_policies (is_active, version DESC)
      WHERE plan_id IS NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_perf_fee_single_active_global
      ON performance_fees.performance_fee_policies (is_active)
      WHERE plan_id IS NULL AND is_active = TRUE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS performance_fees.uq_perf_fee_single_active_global',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS performance_fees.idx_perf_fee_policy_active_version',
    );
    await queryRunner.query(`
      ALTER TABLE performance_fees.performance_fee_policies
      DROP COLUMN IF EXISTS effective_to,
      DROP COLUMN IF EXISTS effective_from,
      DROP COLUMN IF EXISTS version
    `);
  }
}