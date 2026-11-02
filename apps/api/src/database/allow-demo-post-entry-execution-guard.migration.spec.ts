import { QueryRunner } from 'typeorm';
import { AllowDemoPostEntryExecutionGuard1793600000000 } from './migrations/1793600000000-AllowDemoPostEntryExecutionGuard';

describe('AllowDemoPostEntryExecutionGuard1793600000000', () => {
  it('permits DEMO_ONLY execution observations without weakening NONE or allowing LIVE authority', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AllowDemoPostEntryExecutionGuard1793600000000();

    await migration.up({ query } as unknown as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement).replace(/\s+/g, ' ')).join(' ');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_authority');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_post_entry_shadow_no_execution');
    expect(sql).toContain("execution_authority IN ('NONE', 'DEMO_ONLY')");
    expect(sql).toContain("execution_authority = 'NONE' AND modifies_execution = false");
    expect(sql).toContain("execution_authority = 'DEMO_ONLY'");
    expect(sql).not.toContain("execution_authority = 'LIVE'");
  });
});
