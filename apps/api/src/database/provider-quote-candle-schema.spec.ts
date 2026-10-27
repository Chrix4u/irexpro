import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryRunner } from 'typeorm';
import { CreateProviderQuoteCandles1755100000000 } from './migrations/1755100000000-CreateProviderQuoteCandles';

describe('provider quote candle spread-column nullability', () => {
  it('creates fresh schemas with historical bid/ask/spread fields nullable', async () => {
    const sql: string[] = [];
    const queryRunner = {
      query: jest.fn(async (statement: string) => {
        sql.push(String(statement));
        return [];
      }),
    } as unknown as QueryRunner;

    await new CreateProviderQuoteCandles1755100000000().up(queryRunner);

    const createTable = sql.find((statement) =>
      statement.includes('CREATE TABLE IF NOT EXISTS market_data.provider_quote_candles'),
    );
    expect(createTable).toBeDefined();
    expect(createTable).not.toContain('bid_close numeric(20,10) NOT NULL');
    expect(createTable).not.toContain('ask_close numeric(20,10) NOT NULL');
    expect(createTable).not.toContain('spread_close numeric(20,10) NOT NULL');
  });

  it('contains a forward migration that relaxes existing spread columns without fabricating data', () => {
    const migrationsDir = join(__dirname, 'migrations');
    const migrationSources = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.ts') && !name.startsWith('1755100000000-'))
      .map((name) => readFileSync(join(migrationsDir, name), 'utf8'));

    const nullabilityMigration = migrationSources.find(
      (source) =>
        source.includes('ALTER TABLE market_data.provider_quote_candles') &&
        source.includes('ALTER COLUMN bid_close DROP NOT NULL') &&
        source.includes('ALTER COLUMN ask_close DROP NOT NULL') &&
        source.includes('ALTER COLUMN spread_close DROP NOT NULL'),
    );

    expect(nullabilityMigration).toBeDefined();
  });
});
