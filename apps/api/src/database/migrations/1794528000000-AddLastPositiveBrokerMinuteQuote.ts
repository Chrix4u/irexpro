import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Preserve the LAST ACTUALLY OBSERVED POSITIVE bid/ask quote in each M1 bucket
 * separately from the last quote, which may legitimately have zero spread.
 *
 * Existing historical bars stay NULL: we cannot reconstruct prior positive
 * bid/ask ticks from a count or a close price. No backfill is performed.
 */
export class AddLastPositiveBrokerMinuteQuote1794528000000 implements MigrationInterface {
  name = 'AddLastPositiveBrokerMinuteQuote1794528000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE market_data.provider_quote_candles
        ADD COLUMN IF NOT EXISTS last_positive_bid numeric(20,10),
        ADD COLUMN IF NOT EXISTS last_positive_ask numeric(20,10),
        ADD COLUMN IF NOT EXISTS last_positive_spread numeric(20,10),
        ADD COLUMN IF NOT EXISTS last_positive_sample_at timestamptz
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_provider_quote_last_positive_tick'
            AND conrelid = 'market_data.provider_quote_candles'::regclass
        ) THEN
          ALTER TABLE market_data.provider_quote_candles
            ADD CONSTRAINT ck_provider_quote_last_positive_tick CHECK (
              last_positive_sample_at IS NULL
              OR (
                timeframe = 'M1'
                AND last_positive_bid > 0
                AND last_positive_ask > last_positive_bid
                AND last_positive_spread > 0
                AND last_positive_sample_at >= bucket_time
                AND last_positive_sample_at < bucket_time + interval '1 minute'
              )
            ) NOT VALID;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE market_data.provider_quote_candles
        DROP CONSTRAINT IF EXISTS ck_provider_quote_last_positive_tick,
        DROP COLUMN IF EXISTS last_positive_bid,
        DROP COLUMN IF EXISTS last_positive_ask,
        DROP COLUMN IF EXISTS last_positive_spread,
        DROP COLUMN IF EXISTS last_positive_sample_at
    `);
  }
}
