import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowDemoPostEntryExecutionGuard1793600000000 implements MigrationInterface {
  name = 'AllowDemoPostEntryExecutionGuard1793600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_authority
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_no_execution
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_execution_scope
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      ADD CONSTRAINT chk_post_entry_shadow_authority CHECK (
        execution_authority IN ('NONE', 'DEMO_ONLY')
      )
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      ADD CONSTRAINT chk_post_entry_shadow_execution_scope CHECK (
        (execution_authority = 'NONE' AND modifies_execution = false)
        OR execution_authority = 'DEMO_ONLY'
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM trading.post_entry_shadow_observations
      WHERE execution_authority = 'DEMO_ONLY'
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_execution_scope
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_authority
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      ADD CONSTRAINT chk_post_entry_shadow_authority CHECK (execution_authority = 'NONE')
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      ADD CONSTRAINT chk_post_entry_shadow_no_execution CHECK (modifies_execution = false)
    `);
  }
}
