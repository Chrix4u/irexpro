import { scoreTrendPersistenceShadow } from './trend-persistence-shadow';

describe('scoreTrendPersistenceShadow', () => {
  const base = {
    regime: 'TREND_WEAK' as const,
    driftState: 'NORMAL' as const,
    confidence: 0.68,
    grossExpectedR: 0.24,
    netExpectedR: 0.18,
    directionQuality: 0.08,
    tradeQuality: 0.2,
    exitQuality: 0.22,
    portfolioQuality: 0.72,
    extensionAtr: 0.62,
    shortHorizonMomentumAtr: 0.34,
    executionSpreadEvidenceValid: true,
  };

  it('collects trusted positive-economics TREND_WEAK setups without execution authority', () => {
    expect(scoreTrendPersistenceShadow(base)).toMatchObject({
      artifact: 'trend-persistence-shadow-v1',
      candidate: true,
      reason: 'SHADOW_CANDIDATE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      directionQuality: 0.08,
      tradeQuality: 0.2,
      exitQuality: 0.22,
    });
  });

  it('does not duplicate the existing TREND_EXTENDED extension-exhaustion observer', () => {
    expect(scoreTrendPersistenceShadow({ ...base, regime: 'TREND_EXTENDED' })).toMatchObject({
      candidate: false,
      reason: 'REGIME_NOT_WEAK_PERSISTENCE',
    });
  });

  it('fails shadow candidacy closed when evidence quality is not trustworthy', () => {
    expect(scoreTrendPersistenceShadow({ ...base, driftState: 'STRESSED' })).toMatchObject({
      candidate: false,
      reason: 'DRIFT_NOT_NORMAL',
    });
    expect(scoreTrendPersistenceShadow({ ...base, confidence: 0.6399 })).toMatchObject({
      candidate: false,
      reason: 'CONFIDENCE_TOO_LOW',
    });
    expect(scoreTrendPersistenceShadow({ ...base, netExpectedR: 0.0799 })).toMatchObject({
      candidate: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(scoreTrendPersistenceShadow({ ...base, portfolioQuality: 0.3499 })).toMatchObject({
      candidate: false,
      reason: 'PORTFOLIO_QUALITY_TOO_LOW',
    });
    expect(
      scoreTrendPersistenceShadow({ ...base, executionSpreadEvidenceValid: false }),
    ).toMatchObject({
      candidate: false,
      reason: 'SPREAD_EVIDENCE_INVALID',
    });
  });

  it('observes weak continuation geometry instead of reusing live direction/trade/exit gates', () => {
    expect(
      scoreTrendPersistenceShadow({
        ...base,
        directionQuality: 0.01,
        tradeQuality: 0.01,
        exitQuality: 0.01,
      }),
    ).toMatchObject({
      candidate: true,
      directionQuality: 0.01,
      tradeQuality: 0.01,
      exitQuality: 0.01,
    });
  });
});
