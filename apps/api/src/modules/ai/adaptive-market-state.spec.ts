import {
  ADAPTIVE_MARKET_STATE_ARTIFACT,
  classifyAdaptiveMarketState,
  type AdaptiveMarketStateInput,
} from './adaptive-market-state';

const base = (): AdaptiveMarketStateInput => ({
  scanTime: new Date('2026-10-15T14:30:00.000Z'),
  legacyRegime: 'TREND_HEALTHY',
  strategyRoute: 'TREND_CONTINUATION',
  driftState: 'NORMAL',
  confidence: 0.7,
  emaSeparation: 0.32,
  mtfStrength: 0.35,
  extensionAtr: 0.55,
  shortHorizonMomentumAtr: 0.42,
  volatilityScore: 0.22,
  rsi14: 58,
  executionCostUsable: true,
  dataFreshness: 'FRESH',
});

describe('classifyAdaptiveMarketState', () => {
  it('preserves a healthy aligned trend as TREND_HEALTHY', () => {
    const result = classifyAdaptiveMarketState(base());
    expect(result).toMatchObject({
      artifact: ADAPTIVE_MARKET_STATE_ARTIFACT,
      state: 'TREND_HEALTHY',
      session: 'NEW_YORK',
      canUpsize: true,
    });
    expect(result.stateConfidence).toBeGreaterThan(0.6);
  });

  it.each([
    [{ legacyRegime: 'TREND_EXTENDED' }, 'TREND_EXTENDED'],
    [{ legacyRegime: 'TREND_WEAK', strategyRoute: 'TREND_CONTINUATION' }, 'TREND_WEAK'],
    [{ legacyRegime: 'TRANSITION_EARLY', strategyRoute: 'EARLY_TRANSITION' }, 'TRANSITION'],
    [{ legacyRegime: 'REVERSAL_CONFIRMED', strategyRoute: 'CONFIRMED_REVERSAL' }, 'REVERSAL'],
    [{ legacyRegime: 'VOLATILE', volatilityScore: 0.78 }, 'HIGH_VOLATILITY'],
  ] as const)('maps legacy evidence %j to canonical %s', (override, expected) => {
    const result = classifyAdaptiveMarketState({ ...base(), ...override });
    expect(result.state).toBe(expected);
  });

  it('classifies rollover explicitly and forbids upsize', () => {
    const result = classifyAdaptiveMarketState({
      ...base(),
      scanTime: new Date('2026-10-15T21:15:00.000Z'),
      legacyRegime: 'ROLLOVER_RISK',
    });
    expect(result.state).toBe('ROLLOVER_RISK');
    expect(result.canUpsize).toBe(false);
  });

  it('classifies hard OOD drift as DISLOCATED and forbids upsize', () => {
    const result = classifyAdaptiveMarketState({ ...base(), driftState: 'OUT_OF_DISTRIBUTION' });
    expect(result.state).toBe('DISLOCATED');
    expect(result.canUpsize).toBe(false);
    expect(result.reasons).toContain('DRIFT_OUT_OF_DISTRIBUTION');
  });

  it('returns UNKNOWN for stale or incomplete evidence instead of inventing confidence', () => {
    const stale = classifyAdaptiveMarketState({ ...base(), dataFreshness: 'STALE' });
    expect(stale.state).toBe('UNKNOWN');
    expect(stale.canUpsize).toBe(false);
    expect(stale.stateConfidence).toBeLessThanOrEqual(0.25);

    const incomplete = classifyAdaptiveMarketState({ ...base(), mtfStrength: Number.NaN });
    expect(incomplete.state).toBe('UNKNOWN');
    expect(incomplete.canUpsize).toBe(false);
  });

  it('uses H4 alignment to refine healthy-trend confidence without making H4 a hard veto', () => {
    const aligned = classifyAdaptiveMarketState({
      ...base(),
      h4ContextAvailable: true,
      h4Alignment: 0.9,
    });
    const conflict = classifyAdaptiveMarketState({
      ...base(),
      h4ContextAvailable: true,
      h4Alignment: 0.05,
    });

    expect(aligned.state).toBe('TREND_HEALTHY');
    expect(conflict.state).toBe('TREND_HEALTHY');
    expect(aligned.higherTimeframeAgreement).toBeGreaterThan(conflict.higherTimeframeAgreement);
    expect(aligned.stateConfidence).toBeGreaterThan(conflict.stateConfidence);
    expect(aligned.canUpsize).toBe(true);
    expect(conflict.canUpsize).toBe(false);
    expect(conflict.reasons).toContain('H4_CONTEXT_CONFLICT');
  });

  it('keeps existing state behavior when H4 context is unavailable', () => {
    const withoutH4 = classifyAdaptiveMarketState(base());
    const explicitlyUnavailable = classifyAdaptiveMarketState({
      ...base(),
      h4ContextAvailable: false,
      h4Alignment: 0,
    });
    expect(explicitlyUnavailable.state).toBe(withoutH4.state);
    expect(explicitlyUnavailable.canUpsize).toBe(withoutH4.canUpsize);
    expect(explicitlyUnavailable.higherTimeframeAgreement).toBeCloseTo(
      withoutH4.higherTimeframeAgreement,
      10,
    );
  });

  it('keeps state confidence separate from trading confidence', () => {
    const result = classifyAdaptiveMarketState({ ...base(), confidence: 0.99 });
    expect(result.stateConfidence).not.toBe(0.99);
    expect(result.tradingConfidence).toBe(0.99);
  });
});
