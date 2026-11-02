import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';

function row(status: 'WIN' | 'LOSS', netR: number, evaluatedAt: string) {
  return { status, net_r: String(netR), evaluated_at: evaluatedAt };
}

describe('M1TacticalEvidenceService extension exhaustion reliability', () => {
  it('loads 7-day 15-minute-deduplicated settled shadow evidence and summarizes payoff', async () => {
    const query = jest.fn().mockResolvedValue([
      row('WIN', 1.5, '2026-11-02T06:00:00Z'),
      row('LOSS', -1, '2026-11-02T05:45:00Z'),
      row('WIN', 1.6, '2026-11-02T05:30:00Z'),
      row('LOSS', -1.1, '2026-11-02T05:15:00Z'),
      row('WIN', 1.4, '2026-11-02T05:00:00Z'),
      row('WIN', 1.3, '2026-11-02T04:45:00Z'),
    ]);
    const service = new M1TacticalEvidenceService({ query } as any);
    const asOf = new Date('2026-11-02T06:05:00Z');

    const result = await service.loadExtensionExhaustionShadowReliability({
      userId: 'user-1',
      instrument: 'audusd',
      direction: 'SELL',
      asOf,
    });

    expect(result).toEqual({
      samples: 6,
      wins: 4,
      losses: 2,
      totalNetR: 3.7,
      averageNetR: expect.closeTo(3.7 / 6, 10),
      profitFactor: expect.closeTo(5.8 / 2.1, 10),
      recent3R: 2.1,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('ROW_NUMBER() OVER');
    expect(String(sql)).toContain('/ 900');
    expect(String(sql)).toContain("INTERVAL '7 days'");
    expect(String(sql)).toMatch(/components\s*->\s*'extensionExhaustionShadow'\s*->>\s*'artifact'/);
    expect(String(sql)).toContain("components ? 'outcome'");
    expect(params).toEqual([
      'user-1',
      'AUDUSD',
      'SELL',
      asOf,
      'extension-exhaustion-shadow-v1',
    ]);
  });

  it('returns an empty fail-closed evidence snapshot when no resolved episodes exist', async () => {
    const service = new M1TacticalEvidenceService({ query: jest.fn().mockResolvedValue([]) } as any);
    await expect(
      service.loadExtensionExhaustionShadowReliability({
        userId: 'user-1',
        instrument: 'GBPUSD',
        direction: 'BUY',
        asOf: new Date('2026-11-02T06:05:00Z'),
      }),
    ).resolves.toEqual({
      samples: 0,
      wins: 0,
      losses: 0,
      totalNetR: 0,
      averageNetR: 0,
      profitFactor: null,
      recent3R: 0,
    });
  });
});
