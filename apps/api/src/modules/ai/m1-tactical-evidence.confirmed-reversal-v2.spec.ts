import type { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';

describe('Confirmed Reversal v2 persistent sleeve quarantine', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const brokerConnectionId = '22222222-2222-4222-8222-222222222222';
  const evaluatedAt = new Date('2026-11-01T22:00:00.000Z');

  it('quarantines a catastrophic confirmed-reversal sleeve after four exact pair-side losses across the weekend', async () => {
    const query = jest.fn().mockResolvedValue([
      { realised_pnl: '-9.84', closed_at: '2026-10-28T23:17:12.746Z' },
      { realised_pnl: '-10.41', closed_at: '2026-10-28T22:44:00.000Z' },
      { realised_pnl: '-11.12', closed_at: '2026-10-28T22:03:00.000Z' },
      { realised_pnl: '-11.22', closed_at: '2026-10-28T21:20:00.000Z' },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const result = await service.loadMultimodelLossStreakBrake({
      userId,
      brokerConnectionId,
      instrument: 'EURUSD',
      direction: 'SELL',
      strategyRoute: 'CONFIRMED_REVERSAL',
      evaluatedAt,
    });

    expect(result).toMatchObject({
      active: true,
      reason: 'PERSISTENT_NEGATIVE_PAYOFF',
      recentClosedTrades: 0,
      payoffClosedTrades: 4,
      persistentNegativePayoff: true,
    });
    expect(result.profitFactor).toBe(0);
  });

  it('keeps the eight-sample persistent maturity floor for non-reversal routes', async () => {
    const query = jest.fn().mockResolvedValue([
      { realised_pnl: '-9.00', closed_at: '2026-10-29T02:00:00.000Z' },
      { realised_pnl: '-8.00', closed_at: '2026-10-29T01:00:00.000Z' },
      { realised_pnl: '-7.00', closed_at: '2026-10-29T00:00:00.000Z' },
      { realised_pnl: '-6.00', closed_at: '2026-10-28T23:00:00.000Z' },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(
      service.loadMultimodelLossStreakBrake({
        userId,
        brokerConnectionId,
        instrument: 'EURUSD',
        direction: 'SELL',
        strategyRoute: 'TREND_CONTINUATION',
        evaluatedAt,
      }),
    ).resolves.toMatchObject({
      active: false,
      reason: 'CLEAR',
      payoffClosedTrades: 4,
      persistentNegativePayoff: false,
    });
  });

  it('does not quarantine a four-sample confirmed-reversal sleeve when PF is at least 0.50', async () => {
    const query = jest.fn().mockResolvedValue([
      { realised_pnl: '-10.00', closed_at: '2026-10-29T02:00:00.000Z' },
      { realised_pnl: '6.00', closed_at: '2026-10-29T01:00:00.000Z' },
      { realised_pnl: '-8.00', closed_at: '2026-10-29T00:00:00.000Z' },
      { realised_pnl: '4.00', closed_at: '2026-10-28T23:00:00.000Z' },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const result = await service.loadMultimodelLossStreakBrake({
      userId,
      brokerConnectionId,
      instrument: 'EURUSD',
      direction: 'SELL',
      strategyRoute: 'CONFIRMED_REVERSAL',
      evaluatedAt,
    });

    expect(result).toMatchObject({
      active: false,
      reason: 'CLEAR',
      payoffClosedTrades: 4,
      persistentNegativePayoff: false,
    });
    expect(result.profitFactor).toBeCloseTo(10 / 18, 8);
  });
});
