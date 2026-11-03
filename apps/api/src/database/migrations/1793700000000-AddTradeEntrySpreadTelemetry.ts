import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTradeEntrySpreadTelemetry1793700000000 implements MigrationInterface {
  name = 'AddTradeEntrySpreadTelemetry1793700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trades
      ADD COLUMN IF NOT EXISTS entry_quote_bid numeric(20,10),
      ADD COLUMN IF NOT EXISTS entry_quote_ask numeric(20,10),
      ADD COLUMN IF NOT EXISTS entry_spread numeric(20,10),
      ADD COLUMN IF NOT EXISTS entry_quote_observed_at timestamptz,
      ADD COLUMN IF NOT EXISTS estimated_spread_cost numeric(20,8),
      ADD COLUMN IF NOT EXISTS spread_cost_estimate_method varchar(64),
      ADD COLUMN IF NOT EXISTS spread_cost_contract_size numeric(20,10),
      ADD COLUMN IF NOT EXISTS spread_cost_quote_currency varchar(3),
      ADD COLUMN IF NOT EXISTS spread_cost_conversion_rate numeric(20,12),
      ADD COLUMN IF NOT EXISTS spread_cost_conversion_instrument varchar(20)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.trades
      DROP COLUMN IF EXISTS spread_cost_conversion_instrument,
      DROP COLUMN IF EXISTS spread_cost_conversion_rate,
      DROP COLUMN IF EXISTS spread_cost_quote_currency,
      DROP COLUMN IF EXISTS spread_cost_contract_size,
      DROP COLUMN IF EXISTS spread_cost_estimate_method,
      DROP COLUMN IF EXISTS estimated_spread_cost,
      DROP COLUMN IF EXISTS entry_quote_observed_at,
      DROP COLUMN IF EXISTS entry_spread,
      DROP COLUMN IF EXISTS entry_quote_ask,
      DROP COLUMN IF EXISTS entry_quote_bid
    `);
  }
}
