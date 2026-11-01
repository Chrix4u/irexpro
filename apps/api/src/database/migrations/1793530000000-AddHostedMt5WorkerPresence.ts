import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHostedMt5WorkerPresence1793530000000 implements MigrationInterface {
  name = 'AddHostedMt5WorkerPresence1793530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.hosted_mt5_workers (
        worker_id varchar(128) PRIMARY KEY,
        worker_version varchar(64) NOT NULL,
        runtime_ready boolean NOT NULL DEFAULT false,
        max_sessions integer NOT NULL,
        active_sessions integer NOT NULL DEFAULT 0,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_hosted_mt5_workers_capacity
          CHECK (max_sessions >= 1 AND active_sessions >= 0 AND active_sessions <= max_sessions)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hosted_mt5_workers_last_seen
      ON broker.hosted_mt5_workers(last_seen_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS broker.hosted_mt5_workers');
  }
}
