import type { QueryRunner } from 'typeorm';
import { AddLiveQuoteSpreadEvidence1793712000000 } from './migrations/1793712000000-AddLiveQuoteSpreadEvidence';

describe('dedicated live quote spread evidence migration', () => {
  it('introduces live quote observation count and timestamp independent of historical tick volume', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;

    await new AddLiveQuoteSpreadEvidence1793712000000().up(queryRunner);
    const sql = statements.join('\n');
    expect(sql).toContain('positive_quote_sample_count integer NOT NULL DEFAULT 0');
    expect(sql).toContain('last_quote_sample_at timestamptz');
    expect(sql).toContain('CREATE INDEX');
  });

  it('drops the new fields on rollback without disturbing historical candles', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    await new AddLiveQuoteSpreadEvidence1793712000000().down(queryRunner);
    const sql = statements.join('\n');
    expect(sql).toContain('DROP COLUMN IF EXISTS positive_quote_sample_count');
    expect(sql).toContain('DROP COLUMN IF EXISTS last_quote_sample_at');
    expect(sql).not.toContain('DELETE FROM market_data.provider_quote_candles');
  });
});
