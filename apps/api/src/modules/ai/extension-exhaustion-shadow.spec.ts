import { scoreExtensionExhaustionShadow } from './extension-exhaustion-shadow';

describe('scoreExtensionExhaustionShadow', () => {
  const base = {
    regime: 'TREND_EXTENDED' as const,
    driftState: 'NORMAL' as const,
    confidence: 0.6968,
    netExpectedR: 0.2853,
    directionQuality: 0.4178,
    tradeQuality: 0.3757,
    exitQuality: 0.357,
    extensionAtr: 1.12,
    executionSpreadEvidenceValid: true,
  };

  it('tags a NORMAL-drift extended setup as shadow candidate without execution authority', () => {
    const score = scoreExtensionExhaustionShadow(base);
    expect(score).toMatchObject({
      artifact: 'extension-exhaustion-shadow-v1',
      candidate: true,
      reason: 'SHADOW_CANDIDATE',
      executionAuthority: 'NONE',
      modifiesExecution: false,
    });
  });

  it('rejects OOD drift even when expected edge is high', () => {
    expect(
      scoreExtensionExhaustionShadow({ ...base, driftState: 'OUT_OF_DISTRIBUTION' }),
    ).toMatchObject({
      candidate: false,
      reason: 'DRIFT_NOT_NORMAL',
    });
  });

  it('rejects weak direction quality instead of globally lowering continuation gates', () => {
    expect(scoreExtensionExhaustionShadow({ ...base, directionQuality: 0.2 })).toMatchObject({
      candidate: false,
      reason: 'DIRECTION_QUALITY_TOO_LOW',
    });
  });

  it('rejects weak or unavailable economics', () => {
    expect(scoreExtensionExhaustionShadow({ ...base, netExpectedR: 0.05 })).toMatchObject({
      candidate: false,
      reason: 'NET_EXPECTED_R_TOO_LOW',
    });
    expect(
      scoreExtensionExhaustionShadow({ ...base, executionSpreadEvidenceValid: false }),
    ).toMatchObject({
      candidate: false,
      reason: 'SPREAD_EVIDENCE_INVALID',
    });
  });
});
