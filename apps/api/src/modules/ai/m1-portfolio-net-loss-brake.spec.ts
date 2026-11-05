import { evaluateM1PortfolioNetLossBrake } from './m1-portfolio-net-loss-brake';

const now = new Date('2026-11-05T07:30:00.000Z');
const row = (
  minutesAgo: number,
  realisedPnl: number,
  commission: number | null = 1,
  swap: number | null = 0,
) => ({
  realisedPnl,
  commission,
  swap,
  accountCurrency: 'EUR',
  sessionCurrency: 'EUR',
  closedAt: new Date(now.getTime() - minutesAgo * 60_000),
});

describe('exact-session portfolio net loss safety brake', () => {
  it('halts new entries after three cross-pair losses including broker commissions', () => {
    const result = evaluateM1PortfolioNetLossBrake({
      evaluatedAt: now,
      rows: [row(11, -4.62), row(22, -3.31), row(91, -2.29)],
    });
    expect(result).toMatchObject({
      active: true,
      reason: 'RECENT_PORTFOLIO_NET_LOSS_STREAK',
      consecutiveNetLosses: 3,
      cooldownRemainingSeconds: 109 * 60,
    });
  });
  it('counts a gross winner as a net loser if the broker fee exceeds the gain', () => {
    const result = evaluateM1PortfolioNetLossBrake({
      evaluatedAt: now,
      rows: [row(11, 0.3, 1), row(22, -2), row(91, -3)],
    });
    expect(result.active).toBe(true);
  });
  it('resets after a net winner and allows trading once cooldown expires', () => {
    expect(
      evaluateM1PortfolioNetLossBrake({
        evaluatedAt: now,
        rows: [row(11, -3), row(22, 2, 1), row(91, -3)],
      }).active,
    ).toBe(false);
    expect(
      evaluateM1PortfolioNetLossBrake({
        evaluatedAt: now,
        rows: [row(130, -3), row(150, -2), row(160, -4)],
      }),
    ).toMatchObject({ active: false, reason: 'CLEAR' });
  });
  it('fails closed on missing provider fees or mismatched account currency', () => {
    expect(
      evaluateM1PortfolioNetLossBrake({ evaluatedAt: now, rows: [row(11, -3, null)] }).reason,
    ).toBe('COST_OR_CURRENCY_UNVERIFIED');
    expect(
      evaluateM1PortfolioNetLossBrake({
        evaluatedAt: now,
        rows: [{ ...row(11, -3), accountCurrency: 'USD' }],
      }).active,
    ).toBe(true);
  });
  it('does not invent a losing streak from no or insufficient evidence', () => {
    expect(evaluateM1PortfolioNetLossBrake({ evaluatedAt: now, rows: [] }).active).toBe(false);
    expect(
      evaluateM1PortfolioNetLossBrake({ evaluatedAt: now, rows: [row(11, -2), row(22, -3)] })
        .active,
    ).toBe(false);
  });
});
