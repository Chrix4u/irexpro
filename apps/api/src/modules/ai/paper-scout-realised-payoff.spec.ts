import {
  applyPaperScoutRealisedPayoffAuthority,
  evaluatePaperScoutRealisedPayoff,
  PAPER_SCOUT_REALISED_PAYOFF_MIN_TRADES,
} from './paper-scout-realised-payoff';

describe('PAPER scout realised-payoff governor', () => {
  it('keeps an immature generation collecting without reducing participation', () => {
    expect(
      evaluatePaperScoutRealisedPayoff({
        closedTrades: PAPER_SCOUT_REALISED_PAYOFF_MIN_TRADES - 1,
        grossProfit: 2,
        grossLoss: 6,
        netPnl: -4,
      }),
    ).toMatchObject({ state: 'COLLECTING', executionAuthority: 'PAPER', maxLotCap: null });
  });

  it('keeps a mature profitable generation healthy', () => {
    expect(
      evaluatePaperScoutRealisedPayoff({
        closedTrades: 8,
        grossProfit: 12,
        grossLoss: 8,
        netPnl: 4,
      }),
    ).toMatchObject({ state: 'HEALTHY', executionAuthority: 'PAPER', maxLotCap: null });
  });

  it('reduces a mature marginal negative generation to 0.05 lots', () => {
    expect(
      evaluatePaperScoutRealisedPayoff({
        closedTrades: 8,
        grossProfit: 7.6,
        grossLoss: 8,
        netPnl: -0.4,
      }),
    ).toMatchObject({ state: 'REDUCED', executionAuthority: 'PAPER', maxLotCap: 0.05 });
  });

  it('makes a mature clearly negative generation shadow-only', () => {
    expect(
      evaluatePaperScoutRealisedPayoff({
        closedTrades: 7,
        grossProfit: 4.79,
        grossLoss: 9.46,
        netPnl: -4.67,
      }),
    ).toMatchObject({ state: 'SHADOW_ONLY', executionAuthority: 'SHADOW_ONLY', maxLotCap: 0 });
  });

  it('treats a mature zero-loss profitable cohort as healthy', () => {
    expect(
      evaluatePaperScoutRealisedPayoff({
        closedTrades: 6,
        grossProfit: 9,
        grossLoss: 0,
        netPnl: 9,
      }),
    ).toMatchObject({ state: 'HEALTHY', executionAuthority: 'PAPER', profitFactor: null });
  });

  it('reduces the dispatch lot cap when realised payoff is marginal', () => {
    const decision = evaluatePaperScoutRealisedPayoff({
      closedTrades: 8,
      grossProfit: 7.6,
      grossLoss: 8,
      netPnl: -0.4,
    });
    expect(applyPaperScoutRealisedPayoffAuthority(0.1, decision)).toEqual({
      executionAllowed: true,
      lotUpperBound: 0.05,
    });
  });

  it('refuses dispatch when the exact scout generation is shadow-only', () => {
    const decision = evaluatePaperScoutRealisedPayoff({
      closedTrades: 7,
      grossProfit: 4.79,
      grossLoss: 9.46,
      netPnl: -4.67,
    });
    expect(applyPaperScoutRealisedPayoffAuthority(0.1, decision)).toEqual({
      executionAllowed: false,
      lotUpperBound: 0,
    });
  });
});
