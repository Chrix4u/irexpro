import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowMinute1PostEntryTelemetry1793205000000 implements MigrationInterface {
  name = 'AllowMinute1PostEntryTelemetry1793205000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_checkpoint
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      ADD CONSTRAINT chk_post_entry_shadow_checkpoint CHECK (
        checkpoint_minutes IN (1, 5, 10, 15, 30, 60, 120, 240)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM trading.post_entry_shadow_observations
      WHERE checkpoint_minutes = 1
        AND artifact = 'plan-b-v88-minute1-prospective-telemetry-v1'
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_checkpoint
    `);
    await queryRunner.query(`
      ALTER TABLE trading.post_entry_shadow_observations
      ADD CONSTRAINT chk_post_entry_shadow_checkpoint CHECK (
        checkpoint_minutes IN (5, 10, 15, 30, 60, 120, 240)
      )
    `);
  }
}
