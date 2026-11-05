import type { DataSource } from 'typeorm';
import { ProfitExitAlternativesService } from './profit-exit-alternatives.service';
import { ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT } from './profit-exit-alternatives';

describe('DEMO adverse-exit retrospective worker', () => {
  const closedAt = '2026-11-05T04:35:28.000Z';
  const candidate = {
    trade_id: 'trade-1',
    user_id: 'user-1',
    trade_intent_id: 'intent-1',
    broker_connection_id: 'broker-1',
    instrument: 'AUDUSD',
    account_currency: 'EUR',
    direction: 'SELL',
    closed_at: closedAt,
    fill_price: '0.6500',
    exit_price: '0.6502',
    stop_loss: '0.6508',
    take_profit: '0.6494',
    realised_pnl: '-3.91',
    commission: '-1.12',
    swap: '0',
    trigger_reason: 'ADVERSE_THESIS_FAILED',
  };
  it('limits evidence to authenticated broker DEMO AI adverse closes with durable trigger', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new ProfitExitAlternativesService({ query } as unknown as DataSource).runOnce(
      new Date('2026-11-05T06:00:00.000Z'),
    );
    expect(query).toHaveBeenCalledTimes(2);
    const sql = String(query.mock.calls[1]?.[0]);
    expect(sql).toContain("t.close_reason = 'AI_CLOSE_SIGNAL'");
    expect(sql).toContain("bc.account_type = 'DEMO'");
    expect(sql).toContain("audit0.action = 'TRADE_CLOSED'");
    expect(sql).toContain(
      "audit0.metadata #>> '{aiCloseTrigger,source}' = 'BROKER_ADVERSE_PROTECTION'",
    );
    expect(sql).toContain('ADVERSE_THESIS_FAILED');
    expect(sql).toContain('t.closed_at <= $1::timestamptz');
    expect(sql).toContain('NOT EXISTS');
    expect(query.mock.calls[1]?.[1]).toEqual([
      '2026-11-05T06:00:00.000Z',
      ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT,
    ]);
  });

  it('persists independent, idempotent shadow research when quotes prove stop first', async () => {
    const afterClose = new Date('2026-11-05T04:36:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // old profit lock candidates
      .mockResolvedValueOnce([candidate]) // adverse candidates
      .mockResolvedValueOnce([
        {
          bucket_time: afterClose,
          high: '0.6509',
          low: '0.6499',
          sample_count: 4,
          positive_quote_sample_count: 3,
          last_quote_sample_at: new Date(afterClose.getTime() + 30_000),
          source: 'ctrader-broker-native',
        },
      ])
      .mockResolvedValueOnce([]);
    await new ProfitExitAlternativesService({ query } as unknown as DataSource).runOnce(
      new Date('2026-11-05T06:00:00.000Z'),
    );
    expect(query).toHaveBeenCalledTimes(4);
    const selectCandles = String(query.mock.calls[2][0]);
    expect(selectCandles).toContain("source = 'ctrader-broker-native'");
    expect(selectCandles).toContain('positive_quote_sample_count > 0');
    expect(query.mock.calls[2][1]).toEqual(['broker-1', 'AUDUSD', closedAt]);
    const stored = query.mock.calls[3];
    expect(String(stored[0])).toContain(
      'ON CONFLICT (trade_id, artifact, checkpoint_minutes) DO NOTHING',
    );
    expect(String(stored[0])).toContain("'NONE',false");
    expect(stored[1][4]).toBe(ADVERSE_EXIT_COUNTERFACTUAL_ARTIFACT);
    expect(stored[1][6]).toBe('STOP_FIRST');
    const response = JSON.parse(String(stored[1][8]));
    expect(response).toMatchObject({
      modifiesExecution: false,
      brokerFillCertified: false,
      originalNetPnl: -5.03,
      brokerAdverseReason: 'ADVERSE_THESIS_FAILED',
      originalSlTpHold: { outcome: 'STOP_FIRST', netPnlProxy: expect.any(Number) },
    });
  });

  it('marks a missing next-minute quote as a data gap instead of inventing TP recovery', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await new ProfitExitAlternativesService({ query } as unknown as DataSource).runOnce(
      new Date('2026-11-05T06:00:00.000Z'),
    );
    const stored = query.mock.calls[3];
    const response = JSON.parse(String(stored[1][8]));
    expect(stored[1][6]).toBe('DATA_GAP');
    expect(response.originalSlTpHold).toMatchObject({ outcome: 'DATA_GAP', netPnlProxy: null });
  });
});
