import { ProfitExitAlternativesService } from './profit-exit-alternatives.service';

// Research worker contracts.

import { DataSource } from 'typeorm';
import { EXIT_ALTERNATIVES_ARTIFACT } from './profit-exit-alternatives';

describe('ProfitExitAlternativesService', () => {
  it('is constrained to DEMO exits and idempotent research writes', async () => {
    const query = jest.fn().mockResolvedValueOnce([] as unknown[]);
    const service = new ProfitExitAlternativesService({ query } as unknown as DataSource);
    await service.runOnce(new Date('2026-11-04T10:10:00.000Z'));
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain("bc.account_type = 'DEMO'");
    expect(sql).toContain("t.close_reason = 'PROFIT_PROTECTION'");
    expect(sql).toContain("a.metadata->>'mode' = 'SHADOW_ONLY'");
    expect(sql).toContain('NOT EXISTS');
    expect(query.mock.calls[0]?.[1]).toEqual([
      '2026-11-04T10:10:00.000Z',
      EXIT_ALTERNATIVES_ARTIFACT,
    ]);
  });
});
