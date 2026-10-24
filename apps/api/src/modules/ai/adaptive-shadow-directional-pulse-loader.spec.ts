import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';

describe('adaptive shadow directional pulse loader', () => {
  const evaluatedAt = new Date('2026-10-23T19:30:00.000Z');

  it('loads pair-side outcomes causally and ignores future-resolved evidence defensively', async () => {
    const query = jest.fn().mockResolvedValue([
      { direction: 'BUY', net_r: '1.4', resolved_at: '2026-10-23T18:00:00.000Z' },
      { direction: 'BUY', net_r: '1.2', resolved_at: '2026-10-23T18:20:00.000Z' },
      { direction: 'BUY', net_r: '1.5', resolved_at: '2026-10-23T18:40:00.000Z' },
      { direction: 'BUY', net_r: '1.3', resolved_at: '2026-10-23T19:00:00.000Z' },
      { direction: 'SELL', net_r: '-1.0', resolved_at: '2026-10-23T18:05:00.000Z' },
      { direction: 'SELL', net_r: '-1.2', resolved_at: '2026-10-23T18:25:00.000Z' },
      { direction: 'SELL', net_r: '-1.1', resolved_at: '2026-10-23T18:45:00.000Z' },
      { direction: 'SELL', net_r: '-1.3', resolved_at: '2026-10-23T19:05:00.000Z' },
      { direction: 'BUY', net_r: '-50', resolved_at: '2026-10-23T19:45:00.000Z' },
    ]);
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    collector.dataSource = { query };
    collector.shadowDirectionalOutcomeCache = new Map();

    const result = await collector.loadAdaptiveShadowDirectionalPulse(
      'user-1',
      'conn-1',
      'GBPUSD',
      'BUY',
      evaluatedAt,
    );

    expect(result.available).toBe(true);
    expect(result.status).toBe('SUPPORTED');
    expect(result.candidateSamples).toBe(4);
    expect(result.oppositeSamples).toBe(4);
    expect(result.quality).toBeGreaterThan(0.75);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toContain("components->'outcome'->>'resolvedAt'");
    expect(query.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(['user-1', 'conn-1', 'GBPUSD', evaluatedAt]),
    );
  });

  it('fails to a neutral pulse when shadow evidence storage is unavailable', async () => {
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    collector.dataSource = { query: jest.fn().mockRejectedValue(new Error('db unavailable')) };
    collector.shadowDirectionalOutcomeCache = new Map();

    const result = await collector.loadAdaptiveShadowDirectionalPulse(
      'user-1',
      'conn-1',
      'EURUSD',
      'SELL',
      evaluatedAt,
    );

    expect(result.available).toBe(false);
    expect(result.status).toBe('INSUFFICIENT');
    expect(result.quality).toBe(0.5);
  });
});
