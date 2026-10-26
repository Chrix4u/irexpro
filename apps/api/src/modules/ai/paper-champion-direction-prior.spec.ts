import {
  applyPaperChampionDirectionRiskCap,
  evaluatePaperChampionDirectionPrior,
} from './paper-champion-direction-prior';

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


describe('PAPER champion direction risk cap', () => {
  const weak = evaluatePaperChampionDirectionPrior({
    instrument: 'USDCAD',
    direction: 'BUY',
    evidence: { trades: 14, grossProfit: 17.9, grossLoss: 27.92, netPnl: -10.02 },
  });
  const healthy = evaluatePaperChampionDirectionPrior({
    instrument: 'USDJPY',
    direction: 'BUY',
    evidence: { trades: 11, grossProfit: 67.85, grossLoss: 25.93, netPnl: 41.92 },
  });

  it('caps only a mature weak NORMAL_PAPER direction at 0.50x', () => {
    expect(
      applyPaperChampionDirectionRiskCap({
        executionRoute: 'NORMAL_PAPER',
        rawMultiplier: 1,
        prior: weak,
      }),
    ).toMatchObject({
      active: true,
      reason: 'MATURE_CHAMPION_DIRECTION_WEAK',
      multiplierCap: 0.5,
      rawMultiplier: 1,
      effectiveMultiplier: 0.5,
    });
  });

  it('does not penalize a supported champion direction', () => {
    expect(
      applyPaperChampionDirectionRiskCap({
        executionRoute: 'NORMAL_PAPER',
        rawMultiplier: 1.25,
        prior: healthy,
      }),
    ).toMatchObject({
      active: false,
      reason: 'CHAMPION_DIRECTION_SUPPORTED',
      effectiveMultiplier: 1.25,
    });
  });

  it('does not cap sparse evidence or research routes', () => {
    const sparse = evaluatePaperChampionDirectionPrior({
      instrument: 'EURUSD',
      direction: 'BUY',
      evidence: { trades: 2, grossProfit: 26.3, grossLoss: 0, netPnl: 26.3 },
    });
    expect(
      applyPaperChampionDirectionRiskCap({
        executionRoute: 'NORMAL_PAPER',
        rawMultiplier: 1,
        prior: sparse,
      }),
    ).toMatchObject({ active: false, reason: 'CHAMPION_DIRECTION_NOT_MATURE' });
    expect(
      applyPaperChampionDirectionRiskCap({
        executionRoute: 'PAPER_RESEARCH_THROUGHPUT',
        rawMultiplier: 1,
        prior: weak,
      }),
    ).toMatchObject({ active: false, reason: 'NON_NORMAL_PAPER_ROUTE' });
  });

  it('never increases an already defensive raw multiplier', () => {
    expect(
      applyPaperChampionDirectionRiskCap({
        executionRoute: 'NORMAL_PAPER',
        rawMultiplier: 0.5,
        prior: weak,
      }),
    ).toMatchObject({ active: true, effectiveMultiplier: 0.5 });
  });
});
