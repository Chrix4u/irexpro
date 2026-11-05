import { ProfitExitAlternativesService } from './profit-exit-alternatives.service';

// Research worker contracts.

import { DataSource } from 'typeorm';
import { EXIT_ALTERNATIVES_ARTIFACT } from './profit-exit-alternatives';

describe('ProfitExitAlternativesService', () => {
  it('is constrained to DEMO exits and idempotent research writes', async () => {
    const query = jest.fn().mockResolvedValue([] as unknown[]);
    const service = new ProfitExitAlternativesService({ query } as unknown as DataSource);
    await service.runOnce(new Date('2026-11-04T10:10:00.000Z'));
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain("bc.account_type = 'DEMO'");
    expect(sql).toContain("t.close_reason = 'PROFIT_PROTECTION'");
    expect(sql).toContain("audit0.metadata->>'mode' = 'SHADOW_ONLY'");
    expect(sql).toContain('NOT EXISTS');
    expect(query.mock.calls[0]?.[1]).toEqual([
      '2026-11-04T10:10:00.000Z',
      EXIT_ALTERNATIVES_ARTIFACT,
    ]);
  });
  it('records missing live-quote evidence as unresolved without a fake gain', async () => {
    const candidate = {
      trade_id: 'trade-1',
      user_id: 'user-1',
      trade_intent_id: 'intent-1',
      broker_connection_id: 'conn-1',
      instrument: 'EURUSD',
      account_currency: 'EUR',
      direction: 'BUY',
      observed_at: '2026-11-04T09:00:15.000Z',
      closed_at: '2026-11-04T09:00:30.000Z',
      fill_price: '1.1000',
      exit_price: '1.1003',
      stop_loss: '1.0997',
      take_profit: '1.1009',
      realised_pnl: '6',
      commission: '-1.6',
      swap: '0',
      runner_shadow: {
        eligibleForFurtherResearch: true,
        indicativeProtectedStopPrice: 1.10015,
      },
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // extra, independent adverse-exit candidate scan
    await new ProfitExitAlternativesService({ query } as unknown as DataSource).runOnce(
      new Date('2026-11-04T10:10:00.000Z'),
    );
    const saved = query.mock.calls[2];
    expect(String(saved?.[0])).toContain('ON CONFLICT');
    const response = JSON.parse(String(saved?.[1]?.[8]));
    expect(response).toMatchObject({
      modifiesExecution: false,
      originalNetPnl: 4.4,
      runner: { outcome: 'DATA_GAP', netPnlProxy: null },
      halfPartial: { outcome: 'DATA_GAP', netPnlProxy: null },
    });
  });
});
