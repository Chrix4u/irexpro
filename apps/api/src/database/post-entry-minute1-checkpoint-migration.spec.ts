import type { QueryRunner } from 'typeorm';
import { AllowMinute1PostEntryTelemetry1793205000000 } from './migrations/1793205000000-AllowMinute1PostEntryTelemetry';

describe('AllowMinute1PostEntryTelemetry migration', () => {
  it('widens only the post-entry checkpoint constraint to include minute 1', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => queries.push(sql.replace(/\s+/g, ' ').trim())),
    } as unknown as QueryRunner;

    await new AllowMinute1PostEntryTelemetry1793205000000().up(queryRunner);

    const sql = queries.join(' ');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_checkpoint');
    expect(sql).toContain('checkpoint_minutes IN (1, 5, 10, 15, 30, 60, 120, 240)');
    expect(sql).not.toContain('execution_authority');
  });
});
