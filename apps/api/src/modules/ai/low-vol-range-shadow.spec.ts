import {
  M1_TACTICAL_FEATURE_ARTIFACT,
  type M1TacticalFeatureSnapshot,
} from './m1-tactical-features';
import { evaluateLowVolRangeShadow } from './low-vol-range-shadow';

const at = new Date('2026-11-08T23:44:00.000Z');
const feature: M1TacticalFeatureSnapshot = {
  artifact: M1_TACTICAL_FEATURE_ARTIFACT,
  instrument: 'EURUSD',
  decisionTime: at,
  latestM1OpenTime: new Date('2026-11-08T23:43:00.000Z'),
  price: 1.1,
  atr14: 0.0001,
  rsi14: 32,
  bodyRangeRatio: 0.3,
  upperWickRatio: 0.2,
  lowerWickRatio: 0.4,
  closeLocation: 0.6,
  ema9: 1.10018,
  ema21: 1.1002,
  emaSeparationAtr: -0.2,
  emaSlopeAtr: 0,
  momentum1Atr: -0.1,
  momentum3Atr: -0.3,
  momentum5Atr: -0.2,
  m5BodyPressure3: 0,
  m5Momentum1Atr: 0,
  m5Momentum3Atr: 0,
  breakoutUpAtr: 0,
  breakoutDownAtr: 0,
  failedBreakoutUp: false,
  failedBreakoutDown: false,
  efficiency5: 0.1,
  volatilityChange: 0,
  extensionAtr: 0.3,
  volatilityScore: 0.07,
  session: 'ASIA',
  alignment: { m5: 0.1, m15: 0.2, h1: 0.3, h4: -0.1 },
  higherTimeframeAgreement: 0.05,
};

const input = {
  features: feature,
  direction: 'BUY' as const,
  evaluatedAt: at,
  eventRisk: 'CLEAR' as const,
  spreadEvidenceValid: true,
  observedExecutionCostR: 0.16,
};

describe('low-volatility ranging market research challenger', () => {
  it('records an oversold range reversal as shadow only, with next-bar causal entry', () => {
    expect(evaluateLowVolRangeShadow(input)).toMatchObject({
      artifact: 'low-vol-range-shadow-v1',
      mode: 'SHADOW_ONLY',
      executionAuthority: 'NONE',
      modifiesExecution: false,
      grantsExecution: false,
      qualificationEvidence: false,
      productionEligible: false,
      candidate: true,
      outcomeStudyEligible: true,
      hypothesisCohort: 'STABILIZED_ENTRY_HYPOTHESIS',
      direction: 'BUY',
      reasons: [],
      hypotheticalStopDistance: expect.closeTo(0.00015, 9),
      hypotheticalTargetDistance: expect.closeTo(0.0001, 9),
      entryPricing: 'NEXT_COMPLETED_BROKER_M1_OPEN',
      researchEpisodeMinutes: 16,
    });
  });

  it('never emits both BUY and SELL entry candidates for the same snapshot', () => {
    const buy = evaluateLowVolRangeShadow(input);
    const sell = evaluateLowVolRangeShadow({ ...input, direction: 'SELL' });
    expect(buy.candidate).toBe(true);
    expect(sell.candidate).toBe(false);
    expect(sell.reasons).toContain('RSI_NOT_EXTREME');
  });

  it('blocks a falling knife even when RSI is oversold', () => {
    const r = evaluateLowVolRangeShadow({
      ...input,
      features: { ...feature, momentum1Atr: -1.2 },
    });
    expect(r.candidate).toBe(false);
    expect(r.reasons).toContain('REVERSAL_MOMENTUM_NOT_STABILIZED');
    expect(r).toMatchObject({
      candidate: false,
      outcomeStudyEligible: true,
      hypothesisCohort: 'UNSTABLE_MOMENTUM_CONTROL',
      grantsExecution: false,
      productionEligible: false,
    });
  });

  it('does not confuse directional EMA opposition with a ranging market', () => {
    const r = evaluateLowVolRangeShadow({
      ...input,
      features: {
        ...feature,
        emaSeparationAtr: -0.95,
        alignment: { ...feature.alignment, h1: -1 },
      },
    });
    expect(r.candidate).toBe(false);
    expect(r.reasons).toEqual(
      expect.arrayContaining(['EMA_STRUCTURE_NOT_RANGE', 'HIGHER_TIMEFRAME_OPPOSES_PROPOSED_SIDE']),
    );
  });

  it.each([
    { eventRisk: 'HIGH_IMPACT_BLOCK' as const },
    { eventRisk: 'UNVERIFIED' as const },
    { spreadEvidenceValid: false },
    { observedExecutionCostR: null },
    { observedExecutionCostR: 0.8 },
  ])('does not ignore real broker/news safety restrictions: %j', (change) => {
    const r = evaluateLowVolRangeShadow({ ...input, ...change });
    expect(r.candidate).toBe(false);
    expect(r.outcomeStudyEligible).toBe(false);
    expect(r.grantsExecution).toBe(false);
  });

  it('rejects stale completed M1 features and invalid data', () => {
    const stale = evaluateLowVolRangeShadow({
      ...input,
      features: { ...feature, latestM1OpenTime: new Date(at.getTime() - 10 * 60_000) },
    });
    expect(stale.reasons).toContain('STALE_OR_INVALID_FEATURE_EVIDENCE');
    const invalid = evaluateLowVolRangeShadow({
      ...input,
      features: { ...feature, atr14: 0 },
    });
    expect(invalid.candidate).toBe(false);
    expect(invalid.reasons).toContain('STALE_OR_INVALID_FEATURE_EVIDENCE');
  });

  it('rejects a weak but non-extreme Sunday EURUSD SELL rather than forcing a trade', () => {
    const r = evaluateLowVolRangeShadow({
      ...input,
      direction: 'SELL',
      features: {
        ...feature,
        rsi14: 57.4545,
        ema21: 1.1002,
        volatilityScore: 0.058855,
        emaSeparationAtr: -0.1,
        alignment: { m5: 0.7727, m15: -0.0952, h1: 1, h4: 0.616 },
      },
    });
    expect(r.candidate).toBe(false);
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        'RSI_NOT_EXTREME',
        'PRICE_NOT_STRETCHED_FROM_EMA',
        'EMA_STRUCTURE_NOT_RANGE',
        'HIGHER_TIMEFRAME_OPPOSES_PROPOSED_SIDE',
      ]),
    );
  });
});
