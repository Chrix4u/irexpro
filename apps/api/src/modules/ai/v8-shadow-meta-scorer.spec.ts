import {
  scoreV8ShadowMeta,
  V8_SHADOW_ADMISSION_THRESHOLD,
  V8_SHADOW_ARTIFACT,
  V8_SHADOW_MODE,
} from './v8-shadow-meta-scorer';

describe('v8 shadow meta scorer', () => {
  it('scores deterministically without mutating execution authority', () => {
    const score = scoreV8ShadowMeta({
      instrument: 'EURUSD',
      direction: 'BUY',
      confidence: 0.68,
      extensionAtr: 0.6,
      volatilityScore: 0.3,
      emaSeparation: 0.5,
      mtfStrength: 0.4,
      rsi14: 60,
      scanTime: new Date('2026-10-02T12:20:00.000Z'),
    });

    expect(score.artifact).toBe(V8_SHADOW_ARTIFACT);
    expect(score.mode).toBe(V8_SHADOW_MODE);
    expect(score.admissionThreshold).toBe(V8_SHADOW_ADMISSION_THRESHOLD);
    expect(score.probability).toBeGreaterThan(0);
    expect(score.probability).toBeLessThan(1);
    expect(score.expectedR).toBeCloseTo(
      score.probability * (2.5 / 1.5) - (1 - score.probability),
      12,
    );
    expect(score.reason).toBe(score.admitted ? 'ADMIT' : 'REJECT_EXPECTED_VALUE');
  });

  it('includes pair/side context in the score', () => {
    const common = {
      confidence: 0.68,
      extensionAtr: 0.6,
      volatilityScore: 0.3,
      emaSeparation: 0.5,
      mtfStrength: 0.4,
      rsi14: 40,
      scanTime: new Date('2026-10-02T12:20:00.000Z'),
    } as const;

    const cadSell = scoreV8ShadowMeta({
      ...common,
      instrument: 'USDCAD',
      direction: 'SELL',
    });
    const chfSell = scoreV8ShadowMeta({
      ...common,
      instrument: 'USDCHF',
      direction: 'SELL',
    });

    expect(cadSell.probability).toBeGreaterThan(chfSell.probability);
  });

  it('rejects invalid numeric inputs instead of inventing a score', () => {
    expect(() =>
      scoreV8ShadowMeta({
        instrument: 'EURUSD',
        direction: 'BUY',
        confidence: Number.NaN,
        extensionAtr: 0.5,
        volatilityScore: 0.2,
        emaSeparation: 0.4,
        mtfStrength: 0.4,
        rsi14: 60,
        scanTime: new Date(),
      }),
    ).toThrow(/must be finite/);
  });
});
