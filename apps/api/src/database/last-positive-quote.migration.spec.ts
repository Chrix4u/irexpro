import type { QueryRunner } from 'typeorm';
import { AddLastPositiveBrokerMinuteQuote1794528000000 } from './migrations/1794528000000-AddLastPositiveBrokerMinuteQuote';

describe('real last positive broker quote mark migration', () => {
  it('adds separate as-observed positive bid/ask metadata without backfilling prices', async () => {
    const sqls: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => { sqls.push(sql); return []; }),
    } as unknown as QueryRunner;
    await new AddLastPositiveBrokerMinuteQuote1794528000000().up(runner);
    const sql = sqls.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_positive_bid numeric(20,10)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_positive_ask numeric(20,10)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_positive_spread numeric(20,10)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_positive_sample_at timestamptz');
    expect(sql).toContain('last_positive_ask > last_positive_bid');
    expect(sql).toContain("last_positive_sample_at < bucket_time + interval '1 minute'");
    expect(sql).not.toContain('UPDATE market_data.provider_quote_candles');
  });

  it('removes only additive tick evidence columns on explicit rollback', async () => {
    const sqls: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => { sqls.push(sql); return []; }),
    } as unknown as QueryRunner;
    await new AddLastPositiveBrokerMinuteQuote1794528000000().down(runner);
    const sql = sqls.join('\n');
    expect(sql).toContain('DROP COLUMN IF EXISTS last_positive_bid');
    expect(sql).toContain('DROP COLUMN IF EXISTS last_positive_sample_at');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DELETE FROM');
  });
});
