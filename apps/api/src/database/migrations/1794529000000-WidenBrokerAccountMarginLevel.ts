import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correct the legacy broker account projection's financial shape.
 *
 * The authoritative snapshot has numeric(20,8), but its compatibility
 * projection was numeric(10,4). A 0.01-lot position with $1.36 margin
 * and $48k+ equity produces a valid broker-observed margin level of
 * ~3,583,906%, overflowing the legacy 999,999.9999% limit. Three routine
 * health failures then suspended the otherwise-healthy DEMO broker.
 *
 * Precision only: no account balance, risk %, volume, SL/TP, margin,
 * leverage, connection status, authority or live-order modifications.
 * Up is idempotent if an urgent safe schema patch was already applied.
 */
export class WidenBrokerAccountMarginLevel1794529000000 implements MigrationInterface {
  name = 'WidenBrokerAccountMarginLevel1794529000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE broker.broker_accounts
        ALTER COLUMN margin_level TYPE numeric(20,8)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Never silently truncate a genuine provider-observed % during rollback.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM broker.broker_accounts
          WHERE margin_level >= 1000000 OR margin_level <= -1000000
        ) THEN
          RAISE EXCEPTION
            'Cannot downgrade broker margin_level: genuine percentage exceeds numeric(10,4)';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      ALTER TABLE broker.broker_accounts
        ALTER COLUMN margin_level TYPE numeric(10,4)
    `);
  }
}
