import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProviderQuoteCandles1755100000000 implements MigrationInterface {
  name = 'CreateProviderQuoteCandles1755100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS market_data`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS market_data.provider_quote_candles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        connection_id uuid NOT NULL REFERENCES broker.broker_connections(id) ON DELETE CASCADE,
        instrument varchar(20) NOT NULL,
        timeframe varchar(8) NOT NULL DEFAULT 'M1',
        bucket_time timestamptz NOT NULL,
        open numeric(20,10) NOT NULL,
        high numeric(20,10) NOT NULL,
        low numeric(20,10) NOT NULL,
        close numeric(20,10) NOT NULL,
        bid_close numeric(20,10) NOT NULL,
        ask_close numeric(20,10) NOT NULL,
        spread_close numeric(20,10) NOT NULL,
        sample_count integer NOT NULL DEFAULT 1,
        source varchar(40) NOT NULL DEFAULT 'metaapi-rpc-sampled',
        first_sample_at timestamptz NOT NULL,
        last_sample_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_provider_quote_candles_bucket UNIQUE(connection_id, instrument, timeframe, bucket_time),
        CONSTRAINT ck_provider_quote_candles_positive_samples CHECK (sample_count > 0),
        CONSTRAINT ck_provider_quote_candles_ohlc CHECK (
          high >= low AND high >= open AND high >= close AND low <= open AND low <= close
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_provider_quote_candles_lookup
      ON market_data.provider_quote_candles(connection_id, instrument, timeframe, bucket_time DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS market_data.provider_quote_candles`);
  }
}
