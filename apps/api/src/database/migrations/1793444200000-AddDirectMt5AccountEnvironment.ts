import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDirectMt5AccountEnvironment1793444200000 implements MigrationInterface {
  name = 'AddDirectMt5AccountEnvironment1793444200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE broker.direct_mt5_connectors ADD COLUMN IF NOT EXISTS account_type varchar(8)`);
    await queryRunner.query(`
      UPDATE broker.direct_mt5_connectors c
      SET account_type = bc.account_type
      FROM broker.broker_connections bc
      WHERE bc.id = c.broker_connection_id
        AND c.account_type IS NULL
        AND bc.account_type IN ('DEMO','LIVE')
    `);
    await queryRunner.query(`ALTER TABLE broker.direct_mt5_connectors ALTER COLUMN account_type SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE broker.direct_mt5_connectors DROP CONSTRAINT IF EXISTS ck_direct_mt5_connector_account_type`);
    await queryRunner.query(`ALTER TABLE broker.direct_mt5_connectors ADD CONSTRAINT ck_direct_mt5_connector_account_type CHECK (account_type IN ('DEMO','LIVE'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE broker.direct_mt5_connectors DROP CONSTRAINT IF EXISTS ck_direct_mt5_connector_account_type`);
    await queryRunner.query(`ALTER TABLE broker.direct_mt5_connectors DROP COLUMN IF EXISTS account_type`);
  }
}
