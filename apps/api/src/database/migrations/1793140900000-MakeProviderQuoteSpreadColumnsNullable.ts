import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provider-native historical OHLC bars do not contain executable bid/ask
 * spread observations. Keep those columns nullable so historical candles can
 * coexist with live quote samples without fabricating execution-spread data.
 */
export class MakeProviderQuoteSpreadColumnsNullable1793140900000 implements MigrationInterface {
  name = 'MakeProviderQuoteSpreadColumnsNullable1793140900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE market_data.provider_quote_candles
        ALTER COLUMN bid_close DROP NOT NULL,
        ALTER COLUMN ask_close DROP NOT NULL,
        ALTER COLUMN spread_close DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows without bid/ask evidence cannot satisfy the legacy schema. A rollback
    // therefore removes only those historical-only rows before restoring it.
    await queryRunner.query(`
      DELETE FROM market_data.provider_quote_candles
      WHERE bid_close IS NULL OR ask_close IS NULL OR spread_close IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE market_data.provider_quote_candles
        ALTER COLUMN bid_close SET NOT NULL,
        ALTER COLUMN ask_close SET NOT NULL,
        ALTER COLUMN spread_close SET NOT NULL
    `);
  }
}
