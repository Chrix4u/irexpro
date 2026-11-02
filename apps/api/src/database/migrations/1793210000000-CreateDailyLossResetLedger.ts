import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDailyLossResetLedger1793210000000 implements MigrationInterface {
  name = 'CreateDailyLossResetLedger1793210000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.daily_loss_resets (
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL,
        logical_account_key varchar(200) NOT NULL,
        account_currency varchar(3) NOT NULL,
        risk_period_date date NOT NULL,
        reset_at timestamptz NOT NULL,
        reset_count integer NOT NULL DEFAULT 1,
        last_session_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_daily_loss_resets_scope
          UNIQUE (user_id, logical_account_key, account_currency, risk_period_date),
        CONSTRAINT chk_daily_loss_resets_count CHECK (reset_count >= 1)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_loss_resets_user_day
      ON trading.daily_loss_resets (user_id, risk_period_date)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS trading.daily_loss_resets`);
  }
}
