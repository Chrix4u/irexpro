import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDirectMt5ConnectorSchema1792809000000 implements MigrationInterface {
  name = 'CreateDirectMt5ConnectorSchema1792809000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.direct_mt5_connectors (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL UNIQUE,
        state varchar(20) NOT NULL CHECK (state IN ('PAIRING','ACTIVE','SUSPENDED','REVOKED')),
        pairing_code_hash char(64),
        pairing_expires_at timestamptz,
        token_hash char(64),
        account_login varchar(64),
        broker_server varchar(255),
        currency varchar(8),
        trade_allowed boolean NOT NULL DEFAULT false,
        paired_at timestamptz,
        last_heartbeat_at timestamptz,
        last_sequence bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_mt5_pairing_code_hash
      ON broker.direct_mt5_connectors(pairing_code_hash)
      WHERE pairing_code_hash IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_direct_mt5_connector_user_state
      ON broker.direct_mt5_connectors(user_id, state)
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS broker.direct_mt5_commands (
        id uuid PRIMARY KEY,
        connector_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL,
        idempotency_key varchar(255) NOT NULL,
        command_type varchar(40) NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        state varchar(20) NOT NULL CHECK (state IN ('PENDING','LEASED','SUCCEEDED','FAILED','UNCERTAIN','CANCELLED')),
        lease_owner varchar(64),
        lease_expires_at timestamptz,
        result jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT uq_direct_mt5_command_idempotency UNIQUE (broker_connection_id, idempotency_key)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_direct_mt5_commands_lease
      ON broker.direct_mt5_commands(connector_id, state, created_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS broker.direct_mt5_commands');
    await queryRunner.query('DROP TABLE IF EXISTS broker.direct_mt5_connectors');
  }
}
