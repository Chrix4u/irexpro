import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Historical cTrader trendbars carry tick volume in sample_count. They must
 * never be mistaken for independently observed live bid/ask spread samples.
 * Existing rows deliberately start with zero evidence and no quote timestamp;
 * fresh broker-native quotes will repopulate these fields after migration.
 */
export class AddLiveQuoteSpreadEvidence1793712000000 implements MigrationInterface {
  name = 'AddLiveQuoteSpreadEvidence1793712000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE market_data.provider_quote_candles
        ADD COLUMN IF NOT EXISTS positive_quote_sample_count integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_quote_sample_at timestamptz
    `);
    await queryRunner.query(`
      ALTER TABLE market_data.provider_quote_candles
        ADD CONSTRAINT ck_provider_quote_candles_positive_quote_samples
        CHECK (positive_quote_sample_count >= 0)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_provider_quote_candles_live_quote
      ON market_data.provider_quote_candles
        (connection_id, instrument, last_quote_sample_at DESC)
      WHERE timeframe = 'M1' AND last_quote_sample_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS market_data.idx_provider_quote_candles_live_quote
    `);
    await queryRunner.query(`
      ALTER TABLE market_data.provider_quote_candles
        DROP CONSTRAINT IF EXISTS ck_provider_quote_candles_positive_quote_samples,
        DROP COLUMN IF EXISTS positive_quote_sample_count,
        DROP COLUMN IF EXISTS last_quote_sample_at
    `);
  }
}
