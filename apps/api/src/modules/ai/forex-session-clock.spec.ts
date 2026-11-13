import { classifyForexSessionClock, isForexPreRolloverHour } from './forex-session-clock';
import { adaptiveMarketSession, classifyAdaptiveMarketState } from './adaptive-market-state';
import { classifyPaperSpreadSession } from './paper-spread-calibration-shadow';

describe('Forex session clock New York DST rollover integrity', () => {
  it.each([
    ['2026-11-12T12:59:00Z', 'LONDON'],
    ['2026-11-12T13:00:00Z', 'NEW_YORK'],
    ['2026-11-12T20:59:00Z', 'NEW_YORK'],
    ['2026-11-12T21:59:00Z', 'NEW_YORK'],
    ['2026-11-12T22:00:00Z', 'ROLLOVER'],
    ['2026-11-12T22:59:00Z', 'ROLLOVER'],
    ['2026-11-12T23:00:00Z', 'ASIA'],
    ['2026-11-13T00:00:00Z', 'ASIA'],
    ['2026-07-15T20:59:00Z', 'NEW_YORK'],
    ['2026-07-15T21:00:00Z', 'ROLLOVER'],
    ['2026-07-15T21:59:00Z', 'ROLLOVER'],
    ['2026-07-15T22:00:00Z', 'ASIA'],
  ] as const)('%s has actual broker-day session %s', (time, expected) => {
    const stamp = new Date(time);
    expect(classifyForexSessionClock(stamp)).toBe(expected);
    expect(adaptiveMarketSession(stamp)).toBe(expected);
    expect(classifyPaperSpreadSession(stamp)).toBe(expected);
  });

  it.each([
    ['2026-11-12T20:59:00Z',false],
    ['2026-11-12T21:00:00Z',true],
    ['2026-11-12T21:15:00Z',true],
    ['2026-11-12T21:59:00Z',true],
    ['2026-11-12T22:00:00Z',false],
    ['2026-07-15T19:59:00Z',false],
    ['2026-07-15T20:00:00Z',true],
    ['2026-07-15T20:59:00Z',true],
    ['2026-07-15T21:00:00Z',false],
  ] as const)('pre-rollover M1 canary risk window %s is %s',
    (time,expected)=>expect(isForexPreRolloverHour(new Date(time))).toBe(expected));

  it('never assumes a 3-hour nightly rollover in November', () => {
    const before = classifyForexSessionClock(new Date('2026-11-12T21:30:00Z'));
    const actual = classifyForexSessionClock(new Date('2026-11-12T22:30:00Z'));
    const after = classifyForexSessionClock(new Date('2026-11-12T23:30:00Z'));
    expect([before,actual,after]).toEqual(['NEW_YORK','ROLLOVER','ASIA']);
  });

  it('keeps the REAL New York rollover fail-closed', () => {
    const market = {
      scanTime: new Date('2026-11-12T22:30:00Z'),
      legacyRegime: 'TREND_HEALTHY',
      strategyRoute: 'TREND_CONTINUATION',
      driftState: 'NORMAL',
      confidence: 0.72,
      emaSeparation: 0.4,
      mtfStrength: 0.4,
      extensionAtr: 0.6,
      shortHorizonMomentumAtr: 0.32,
      volatilityScore: 0.25,
      rsi14: 55,
      executionCostUsable: true,
      dataFreshness: 'FRESH' as const,
    };
    const rollover = classifyAdaptiveMarketState(market);
    expect(rollover.session).toBe('ROLLOVER');
    expect(rollover.state).toBe('ROLLOVER_RISK');
    expect(rollover.canUpsize).toBe(false);
    expect(rollover.reasons).toContain('ROLLOVER_SESSION');
    const before = classifyAdaptiveMarketState({
      ...market, scanTime: new Date('2026-11-12T21:30:00Z'),
    });
    expect(before.session).toBe('NEW_YORK');
    expect(before.state).toBe('TREND_HEALTHY');
    const after = classifyAdaptiveMarketState({
      ...market, scanTime: new Date('2026-11-12T23:30:00Z'),
    });
    expect(after.session).toBe('ASIA');
    expect(after.state).toBe('TREND_HEALTHY');
  });
});
