import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import type { DataSource } from 'typeorm';

describe('Pepperstone pair-side as-of evidence loader', () => {
  const params = {
    userId: 'user-owner',
    brokerConnectionId: 'owner-broker-connection',
    instrument: 'usdjpy',
    direction: 'SELL' as const,
    asOf: new Date('2026-11-16T06:17:00.000Z'),
  };

  it('uses exact user and broker scopes and strictly prior closed trades', async () => {
    const query = jest.fn().mockResolvedValue([{
      closed_at: '2026-11-16T06:02:09.197Z',
      net_pnl: '-102.83',
      risk_at_stop: '99.73154025',
    }]);
    const svc = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const rows = await svc.loadPepperstonePairSideAsOfRows(params);
    expect(rows).toEqual([{
      closedAt: '2026-11-16T06:02:09.197Z',
      netPnl: '-102.83',
      riskAtStop: '99.73154025',
    }]);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('t.user_id = $1 AND t.broker_connection_id = $2');
    expect(sql).toContain("b.broker_id = 'pepperstone-ctrader'");
    expect(sql).toContain("b.account_type = 'DEMO'");
    expect(sql).toContain("t.account_currency = 'USD'");
    expect(sql).toContain("t.status = 'CLOSED'");
    expect(sql).toContain('t.closed_at < $5::timestamptz');
    expect(sql).toContain('LIMIT 40');
    expect(values).toEqual([
      'user-owner','owner-broker-connection','USDJPY','SELL',
      '2026-11-16T06:17:00.000Z',
    ]);
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|DROP|ALTER)\s+(?:FROM|INTO|TABLE|trading)/i);
  });

  it('does not query invalid instruments or as-of time', async () => {
    const query = jest.fn();
    const svc = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    await expect(svc.loadPepperstonePairSideAsOfRows({
      ...params, instrument: 'not-a-symbol',
    })).rejects.toThrow('INVALID_PAIR_SIDE_ASOF_SCOPE');
    await expect(svc.loadPepperstonePairSideAsOfRows({
      ...params, asOf: new Date('invalid'),
    })).rejects.toThrow('INVALID_PAIR_SIDE_ASOF_SCOPE');
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps missing net costs unpriced rather than inventing zero', async () => {
    const query = jest.fn().mockResolvedValue([{
      closed_at: '2026-11-16T05:00:00Z',
      net_pnl: null,
      risk_at_stop: null,
    }]);
    const svc = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const rows = await svc.loadPepperstonePairSideAsOfRows(params);
    expect(rows[0].netPnl).toBeNull();
    expect(rows[0].riskAtStop).toBeNull();
  });
});
