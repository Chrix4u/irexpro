import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaperBrokerStateStore1754900000000 implements MigrationInterface {
  name = 'CreatePaperBrokerStateStore1754900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.paper_broker_states (
        connection_id uuid PRIMARY KEY
          REFERENCES broker.broker_connections(id) ON DELETE CASCADE,
        state jsonb NOT NULL,
        revision bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_paper_broker_states_updated_at
        ON broker.paper_broker_states(updated_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS broker.paper_broker_states');
  }
}
