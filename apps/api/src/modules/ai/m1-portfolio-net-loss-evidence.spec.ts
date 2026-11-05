import type { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';

describe('portfolio net loss brake database scope', () => {
  it('keeps the exact current ACTIVE authority while reading prior same-account FULL_AUTO closes across Stop/Start', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        realised_pnl: '-2.00',
        commission: '1.00',
        swap: '0',
        account_currency: 'EUR',
        session_currency: 'EUR',
        closed_at: '2026-11-05T07:19:06.000Z',
      },
      {
        realised_pnl: '-3.00',
        commission: '1.00',
        swap: '0',
        account_currency: 'EUR',
        session_currency: 'EUR',
        closed_at: '2026-11-05T07:08:04.000Z',
      },
      {
        realised_pnl: '-4.00',
        commission: '1.00',
        swap: '0',
        account_currency: 'EUR',
        session_currency: 'EUR',
        closed_at: '2026-11-05T05:59:25.000Z',
      },
    ]);
    const evidence = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const evaluatedAt = new Date('2026-11-05T07:30:00.000Z');
    const result = await evidence.loadPortfolioNetLossStreakBrake({
      userId: 'user-a',
      brokerConnectionId: 'broker-b',
      tradingSessionId: 'session-c',
      evaluatedAt,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON active.id = $3'), [
      'user-a',
      'broker-b',
      'session-c',
      evaluatedAt.toISOString(),
    ]);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("s.execution_mode = 'FULL_AUTO'");
    expect(sql).toContain("active.status = 'ACTIVE'");
    expect(sql).toContain("active.execution_mode = 'FULL_AUTO'");
    expect(sql).toContain('s.account_currency = active.account_currency');
    expect(sql).toContain('bc.account_currency = active.account_currency');
    expect(sql).toContain("bc.account_type = 'DEMO'");
    expect(sql).not.toContain('t.trading_session_id = $3');
    expect(sql).not.toContain("s.status = 'ACTIVE'");
    expect(sql).toContain('t.closed_at <= $4::timestamptz');
    expect(sql).toContain('t.broker_connection_id = $2');
    expect(sql).toContain('ORDER BY t.closed_at DESC, t.id DESC');
    expect(result).toMatchObject({
      active: true,
      consecutiveNetLosses: 3,
      reason: 'RECENT_PORTFOLIO_NET_LOSS_STREAK',
    });
  });
});
