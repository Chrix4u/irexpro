import {
  evaluatePaperShadowLocalEdgePocket,
  isHighConvictionPaperShadowLocalEdgePocket,
} from './paper-shadow-local-edge-pocket';

const supported = {
  samples: 44,
  wins: 31,
  losses: 13,
  grossProfitR: 40.2,
  grossLossR: 14.33,
  netR: 25.87,
  averageNetR: 0.588,
  profitFactor: 2.542,
  recentSamples: 8,
  recentWins: 8,
  recentNetR: 10.98,
  latestResolvedAt: '2026-10-23T20:40:00.000Z',
};

describe('PAPER shadow local-edge pocket', () => {
  it('supports a mature profitable pocket with healthy recent evidence', () => {
    expect(evaluatePaperShadowLocalEdgePocket(supported)).toMatchObject({
      supported: true,
      state: 'SUPPORTED',
      reason: 'LOCAL_EDGE_POCKET_SUPPORTED',
      samples: 44,
      recentWins: 8,
    });
  });

  it('keeps sparse pockets collecting', () => {
    expect(
      evaluatePaperShadowLocalEdgePocket({ ...supported, samples: 19, wins: 13, losses: 6 }),
    ).toMatchObject({
      supported: false,
      state: 'COLLECTING',
      reason: 'INSUFFICIENT_LOCAL_EDGE_SAMPLES',
    });
  });

  it('rejects a mature pocket below the profit-factor floor', () => {
    expect(evaluatePaperShadowLocalEdgePocket({ ...supported, profitFactor: 1.19 })).toMatchObject({
      supported: false,
      state: 'WEAK',
      reason: 'LOCAL_EDGE_PROFIT_FACTOR_TOO_LOW',
    });
  });

  it('rejects a mature pocket below the average-R floor', () => {
    expect(evaluatePaperShadowLocalEdgePocket({ ...supported, averageNetR: 0.099 })).toMatchObject({
      supported: false,
      state: 'WEAK',
      reason: 'LOCAL_EDGE_AVERAGE_R_TOO_LOW',
    });
  });

  it('rejects recent deterioration even when long-run evidence is strong', () => {
    expect(
      evaluatePaperShadowLocalEdgePocket({
        ...supported,
        recentWins: 0,
        recentNetR: -10.353,
      }),
    ).toMatchObject({
      supported: false,
      state: 'DEGRADED',
      reason: 'LOCAL_EDGE_RECENT_DEGRADATION',
    });
  });

  it('fails closed when required metrics are non-finite', () => {
    expect(
      evaluatePaperShadowLocalEdgePocket({ ...supported, profitFactor: Number.NaN }),
    ).toMatchObject({
      supported: false,
      state: 'UNAVAILABLE',
      reason: 'LOCAL_EDGE_EVIDENCE_INVALID',
    });
  });

  it('identifies only unusually strong mature pockets for the three-vote scout', () => {
    const decision = evaluatePaperShadowLocalEdgePocket(supported);
    expect(isHighConvictionPaperShadowLocalEdgePocket(decision)).toBe(true);

    const merelySupported = evaluatePaperShadowLocalEdgePocket({
      ...supported,
      samples: 24,
      wins: 14,
      losses: 10,
      averageNetR: 0.12,
      profitFactor: 1.3,
      recentWins: 5,
      recentNetR: 0.6,
    });
    expect(merelySupported.supported).toBe(true);
    expect(isHighConvictionPaperShadowLocalEdgePocket(merelySupported)).toBe(false);
  });
});
