import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTradePathDiagnostics1755300000000 implements MigrationInterface {
  name = 'AddTradePathDiagnostics1755300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trades
        ADD COLUMN IF NOT EXISTS max_favorable_pnl numeric(18,8) NULL,
        ADD COLUMN IF NOT EXISTS max_adverse_pnl numeric(18,8) NULL,
        ADD COLUMN IF NOT EXISTS profit_giveback numeric(18,8) NULL,
        ADD COLUMN IF NOT EXISTS path_observation_count integer NULL,
        ADD COLUMN IF NOT EXISTS path_peak_observed_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS path_last_observed_at timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trades
        DROP COLUMN IF EXISTS path_last_observed_at,
        DROP COLUMN IF EXISTS path_peak_observed_at,
        DROP COLUMN IF EXISTS path_observation_count,
        DROP COLUMN IF EXISTS profit_giveback,
        DROP COLUMN IF EXISTS max_adverse_pnl,
        DROP COLUMN IF EXISTS max_favorable_pnl
    `);
  }
}
