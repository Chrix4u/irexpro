import {
  PLAN_B_ENSEMBLE_ARTIFACT,
  PLAN_B_ENSEMBLE_MODE,
  scorePlanBMultimodelShadow,
} from './plan-b-multimodel-shadow';

describe('Plan B multimodel prospective shadow', () => {
  const base = {
    instrument: 'EURUSD',
    direction: 'BUY' as const,
    confidence: 0.69,
    extensionAtr: 0.55,
    volatilityScore: 0.28,
    emaSeparation: 0.58,
    mtfStrength: 0.52,
    rsi14: 61,
    scanTime: new Date('2026-10-02T12:20:00.000Z'),
  };

  it('is deterministic and never modifies execution', () => {
    const a = scorePlanBMultimodelShadow(base);
    const b = scorePlanBMultimodelShadow(base);
    expect(a).toEqual(b);
    expect(a.artifact).toBe(PLAN_B_ENSEMBLE_ARTIFACT);
    expect(a.mode).toBe(PLAN_B_ENSEMBLE_MODE);
    expect(a.modifiesExecution).toBe(false);
  });
  it('rejects a stretched trend regime', () => {
    const score = scorePlanBMultimodelShadow({
      ...base,
      extensionAtr: 1.3,
    });
    expect(score.regime).toBe('TREND_EXTENDED');
    expect(score.regimeAllowed).toBe(false);
    expect(score.admitted).toBe(false);
    expect(score.reasons).toContain('REGIME_TREND_EXTENDED');
  });

  it('rejects high-volatility conditions independently of meta probability', () => {
    const score = scorePlanBMultimodelShadow({
      ...base,
      volatilityScore: 0.7,
    });
    expect(score.regime).toBe('VOLATILE');
    expect(score.admitted).toBe(false);
  });

  it('returns bounded component scores with explicit reasons', () => {
    const score = scorePlanBMultimodelShadow(base);
    for (const value of [
      score.directionQuality,
      score.tradeQuality,
      score.metaProbability,
      score.ensembleScore,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(score.reasons.length).toBeGreaterThan(0);
  });
});
