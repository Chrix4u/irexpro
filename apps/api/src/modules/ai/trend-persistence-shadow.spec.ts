import { scoreTrendPersistenceShadow } from './trend-persistence-shadow';

describe('scoreTrendPersistenceShadow', () => {
  const base = {
    regime: 'TREND_EXTENDED' as const,
    driftState: 'NORMAL' as const,
    confidence: 0.68,
    grossExpectedR: 0.24,
    netExpectedR: 0.18,
    directionQuality: 0.31,
    tradeQuality: 0.42,
    exitQuality: 0.4,
    portfolioQuality: 0.72,
    extensionAtr: 1.08,
    shortHorizonMomentumAtr: 0.34,
    executionSpreadEvidenceValid: true,
  };

  it('collects positive-economics TREND_EXTENDED setups without execution authority', () => {
    expect(scoreTrendPersistenceShadow(base)).toMatchObject({
      artifact: 'trend-persistence-shadow-v1',
      candidate: true,
      reason: 'SHADOW_CANDIDATE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
  });

  it('also collects TREND_WEAK setups without requiring continuation direction quality', () => {
    expect(
      scoreTrendPersistenceShadow({
        ...base,
        regime: 'TREND_WEAK',
        directionQuality: 0.08,
        tradeQuality: 0.2,
        exitQuality: 0.22,
      }),
    ).toMatchObject({
      candidate: true,
      reason: 'SHADOW_CANDIDATE',
      directionQuality: 0.08,
      tradeQuality: 0.2,
      exitQuality: 0.22,
    });
  });

  it('rejects unsupported regimes rather than changing the live regime router', () => {
    expect(scoreTrendPersistenceShadow({ ...base, regime: 'TREND_HEALTHY' })).toMatchObject({
      candidate: false,
      reason: 'REGIME_NOT_PERSISTENCE_RESEARCH',
    });
  });

  it('fails shadow candidacy closed when economics or execution evidence is not trustworthy', () => {
    expect(scoreTrendPersistenceShadow({ ...base, netExpectedR: 0.0799 })).toMatchObject({
      candidate: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(scoreTrendPersistenceShadow({ ...base, driftState: 'OUT_OF_DISTRIBUTION' })).toMatchObject({
      candidate: false,
      reason: 'DRIFT_NOT_NORMAL',
    });
    expect(
      scoreTrendPersistenceShadow({ ...base, executionSpreadEvidenceValid: false }),
    ).toMatchObject({
      candidate: false,
      reason: 'SPREAD_EVIDENCE_INVALID',
    });
  });

  it('keeps the existing 64% confidence floor for comparable prospective evidence', () => {
    expect(scoreTrendPersistenceShadow({ ...base, confidence: 0.6399 })).toMatchObject({
      candidate: false,
      reason: 'CONFIDENCE_TOO_LOW',
    });
  });
});
