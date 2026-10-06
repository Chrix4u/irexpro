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

  it('keeps a fully-qualified extended trend shadow-only because it is not promotable', () => {
    const score = scorePlanBMultimodelShadow({
      instrument: 'AUDUSD',
      direction: 'BUY',
      confidence: 0.74892924,
      extensionAtr: 1.4139681489950369,
      volatilityScore: 0.2671723076211882,
      emaSeparation: 0.755431308825067,
      mtfStrength: 1,
      rsi14: 66.02630845628374,
      scanTime: new Date('2026-10-05T08:50:00.000Z'),
    });
    expect(score.regime).toBe('TREND_EXTENDED');
    expect(score.consensusPassed).toBeGreaterThanOrEqual(score.consensusRequired);
    expect(score.paperAdmitted).toBe(false);
    expect(score.admitted).toBe(false);
    expect(score.reasons).toContain('REGIME_TREND_EXTENDED');
  });

  it('rejects high-volatility conditions independently of meta probability', () => {
    const score = scorePlanBMultimodelShadow({
      ...base,
      volatilityScore: 0.7,
    });
    expect(score.regime).toBe('VOLATILE');
    expect(score.paperAdmitted).toBe(false);
    expect(score.admitted).toBe(false);
  });

  it('returns bounded component scores with explicit reasons', () => {
    const score = scorePlanBMultimodelShadow(base);
    for (const value of [
      score.directionQuality,
      score.tradeQuality,
      score.exitQuality,
      score.pairSideQuality,
      score.sessionQuality,
      score.portfolioQuality,
      score.portfolioRiskScore,
      score.metaProbability,
      score.ensembleScore,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(score.reasons.length).toBeGreaterThan(0);
  });

  it('defers pair-side authority to prospective sleeve governance', () => {
    const score = scorePlanBMultimodelShadow(base);
    expect(score.pairSideRoute).toBe('GOVERNANCE');
    expect(score.pairSideQuality).toBe(0.5);
    expect(score.reasons.some((reason) => reason.startsWith('PAIR_SIDE_'))).toBe(false);
  });

  it('requires broad model consensus and rejects rollover-quality sessions', () => {
    const normal = scorePlanBMultimodelShadow(base);
    expect(normal.consensusRequired).toBe(6);
    expect(normal.consensusPassed).toBeGreaterThanOrEqual(0);
    expect(normal.consensusPassed).toBeLessThanOrEqual(7);

    const rollover = scorePlanBMultimodelShadow({
      ...base,
      scanTime: new Date('2026-10-02T22:20:00.000Z'),
    });
    expect(rollover.sessionQuality).toBeLessThan(0.5);
    expect(rollover.admitted).toBe(false);
    expect(rollover.reasons).toContain('SESSION_QUALITY');
  });

  it('reduces portfolio quality for concentrated same-direction exposure', () => {
    const unexposed = scorePlanBMultimodelShadow(base);
    const concentrated = scorePlanBMultimodelShadow(base, [
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.10' },
      { instrument: 'GBPUSD', direction: 'BUY', lotSize: '0.10' },
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.10' },
    ]);
    expect(concentrated.openPositionCount).toBe(3);
    expect(concentrated.sameInstrumentCount).toBe(2);
    expect(concentrated.sameInstrumentDirectionalLots).toBeCloseTo(0.2, 8);
    expect(concentrated.portfolioRiskScore).toBeGreaterThan(unexposed.portfolioRiskScore);
    expect(concentrated.portfolioQuality).toBeLessThan(unexposed.portfolioQuality);
  });

  it('scores equal lot exposure identically regardless of ticket count', () => {
    const singleTicket = scorePlanBMultimodelShadow(base, [
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.30' },
    ]);
    const splitTickets = scorePlanBMultimodelShadow(base, [
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.10' },
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.10' },
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.10' },
    ]);

    expect(singleTicket.sameInstrumentCount).toBe(1);
    expect(splitTickets.sameInstrumentCount).toBe(3);
    expect(singleTicket.sameInstrumentDirectionalLots).toBeCloseTo(0.3, 8);
    expect(splitTickets.sameInstrumentDirectionalLots).toBeCloseTo(0.3, 8);
    expect(splitTickets.portfolioRiskScore).toBeCloseTo(singleTicket.portfolioRiskScore, 12);
    expect(splitTickets.portfolioQuality).toBeCloseTo(singleTicket.portfolioQuality, 12);
  });

  it('uses net directional exposure so an opposite position offsets concentration', () => {
    const longOnly = scorePlanBMultimodelShadow(base, [
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.20' },
    ]);
    const partiallyHedged = scorePlanBMultimodelShadow(base, [
      { instrument: 'EURUSD', direction: 'BUY', lotSize: '0.20' },
      { instrument: 'EURUSD', direction: 'SELL', lotSize: '0.10' },
    ]);

    expect(longOnly.sameInstrumentDirectionalLots).toBeCloseTo(0.2, 8);
    expect(partiallyHedged.sameInstrumentDirectionalLots).toBeCloseTo(0.1, 8);
    expect(partiallyHedged.portfolioRiskScore).toBeLessThan(longOnly.portfolioRiskScore);
    expect(partiallyHedged.portfolioQuality).toBeGreaterThan(longOnly.portfolioQuality);
  });
});
