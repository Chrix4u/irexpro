import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHostedMt5WorkerLease1793520000000 implements MigrationInterface {
  name = 'AddHostedMt5WorkerLease1793520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      DROP CONSTRAINT IF EXISTS ck_direct_mt5_connectors_host_mode
    `);
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      ADD CONSTRAINT ck_direct_mt5_connectors_host_mode
      CHECK (host_mode IN ('PERSONAL_PC', 'WINDOWS_VPS', 'IREXPRO_HOSTED'))
    `);
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      ADD COLUMN IF NOT EXISTS host_worker_id varchar(128),
      ADD COLUMN IF NOT EXISTS host_lease_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS host_last_seen_at timestamptz,
      ADD COLUMN IF NOT EXISTS host_last_error text
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_direct_mt5_hosted_worker_lease
      ON broker.direct_mt5_connectors(host_mode, state, host_lease_expires_at)
      WHERE host_mode = 'IREXPRO_HOSTED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS broker.idx_direct_mt5_hosted_worker_lease');
    await queryRunner.query(`
      ALTER TABLE broker.direct_mt5_connectors
      DROP COLUMN IF EXISTS host_last_error,
      DROP COLUMN IF EXISTS host_last_seen_at,
      DROP COLUMN IF EXISTS host_lease_expires_at,
      DROP COLUMN IF EXISTS host_worker_id
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
}
