import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDirectMt5ConnectorHostMode1793510000000 implements MigrationInterface {
  name = 'AddDirectMt5ConnectorHostMode1793510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      ADD COLUMN IF NOT EXISTS host_mode varchar(20) NOT NULL DEFAULT 'PERSONAL_PC'
    `);
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      DROP CONSTRAINT IF EXISTS ck_direct_mt5_connectors_host_mode
    `);
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      ADD CONSTRAINT ck_direct_mt5_connectors_host_mode
      CHECK (host_mode IN ('PERSONAL_PC', 'WINDOWS_VPS'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      DROP CONSTRAINT IF EXISTS ck_direct_mt5_connectors_host_mode
    `);
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      DROP COLUMN IF EXISTS host_mode
    `);
  }
}
