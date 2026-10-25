import { evaluatePaperChampionDirectionPrior } from './paper-champion-direction-prior';

describe('PAPER champion directional prior', () => {
  const base = {
    instrument: 'GBPUSD',
    direction: 'SELL' as const,
    evidence: {
      trades: 12,
      grossProfit: 27.8,
      grossLoss: 20.4,
      netPnl: 7.4,
    },
  };

  it('supports a mature profitable direction with PF at or above 1.15', () => {
    expect(evaluatePaperChampionDirectionPrior(base)).toMatchObject({
      supported: true,
      reason: 'CHAMPION_DIRECTION_SUPPORTED',
      trades: 12,
      profitFactor: expect.closeTo(27.8 / 20.4, 8),
      netPnl: 7.4,
    });
  });

  it('does not support sparse evidence even when the observed PnL is positive', () => {
    expect(
      evaluatePaperChampionDirectionPrior({
        ...base,
        evidence: { trades: 7, grossProfit: 20, grossLoss: 5, netPnl: 15 },
      }),
    ).toMatchObject({ supported: false, reason: 'INSUFFICIENT_CHAMPION_DIRECTION_EVIDENCE' });
  });

  it('does not support a mature direction with non-positive net PnL', () => {
    expect(
      evaluatePaperChampionDirectionPrior({
        ...base,
        evidence: { trades: 10, grossProfit: 10, grossLoss: 11, netPnl: -1 },
      }),
    ).toMatchObject({ supported: false, reason: 'CHAMPION_DIRECTION_NET_PNL_NOT_POSITIVE' });
  });

  it('does not support a mature profitable direction below the 1.15 PF floor', () => {
    expect(
      evaluatePaperChampionDirectionPrior({
        ...base,
        evidence: { trades: 10, grossProfit: 11, grossLoss: 10, netPnl: 1 },
      }),
    ).toMatchObject({ supported: false, reason: 'CHAMPION_DIRECTION_PROFIT_FACTOR_TOO_LOW' });
  });

  it('supports an all-winning mature direction without inventing an infinite PF number', () => {
    expect(
      evaluatePaperChampionDirectionPrior({
        ...base,
        evidence: { trades: 8, grossProfit: 16, grossLoss: 0, netPnl: 16 },
      }),
    ).toMatchObject({ supported: true, profitFactor: null });
  });
});
