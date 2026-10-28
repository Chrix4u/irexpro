import { AllowBrokerNativeM1Authority1793195000000 } from './migrations/1793195000000-AllowBrokerNativeM1Authority';

describe('AllowBrokerNativeM1Authority migration', () => {
  it('widens the M1 execution authority check to admit BROKER_NATIVE without removing existing values', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql.replace(/\s+/g, ' ').trim());
      }),
    } as any;

    await new AllowBrokerNativeM1Authority1793195000000().up(queryRunner);

    const sql = queries.join(' ');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_m1_tactical_authority');
    expect(sql).toContain("execution_authority IN ('NONE', 'PAPER_ONLY_RESEARCH', 'BROKER_NATIVE')");
  });
});
