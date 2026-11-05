import { QueryRunner } from 'typeorm';
import { AddDemoPartialLegReconciliationEvidence1793966400000 } from './migrations/1793966400000-AddDemoPartialLegReconciliationEvidence';

describe('DEMO partial-close reconciliation evidence migration', () => {
  const harness = () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    return { runner, statements };
  };

  it('only adds evidence state and tightens CONFIRMED economics', async () => {
    const { runner, statements } = harness();
    await new AddDemoPartialLegReconciliationEvidence1793966400000().up(runner);
    const sql = statements.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS reconciliation_reason');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_reconciled_at');
    expect(sql).toContain('ck_demo_partial_close_confirmed_economics_v2');
    expect(sql).toContain("state <> 'CONFIRMED' OR economics_complete = TRUE");
    expect(sql).not.toMatch(/(?:INSERT|UPDATE)\s+trading\.trades/i);
  });

  it('reverts only its newly added fields and check', async () => {
    const { runner, statements } = harness();
    await new AddDemoPartialLegReconciliationEvidence1793966400000().down(runner);
    expect(statements.join('\n')).toContain('DROP COLUMN IF EXISTS reconciliation_reason');
    expect(statements.join('\n')).toContain('DROP CONSTRAINT IF EXISTS');
  });
});
