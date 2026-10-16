import {
  analyzeAdaptiveCurrencyExposure,
  decomposeCurrencyRisk,
  type AdaptiveCurrencyRiskPosition,
} from './adaptive-currency-exposure';

describe('adaptive currency exposure', () => {
  it.each([
    ['EURUSD', 'BUY', { EUR: 100, USD: -100 }],
    ['GBPUSD', 'SELL', { GBP: -100, USD: 100 }],
    ['USDJPY', 'BUY', { USD: 100, JPY: -100 }],
    ['AUDUSD', 'SELL', { AUD: -100, USD: 100 }],
    ['USDCAD', 'BUY', { USD: 100, CAD: -100 }],
    ['USDCHF', 'SELL', { USD: -100, CHF: 100 }],
  ] as const)('maps %s %s risk to base/quote currency signs', (instrument, direction, expected) => {
    expect(decomposeCurrencyRisk(instrument, direction, 100)).toEqual(expected);
  });

  it('detects shared USD-short concentration across different instruments', () => {
    const positions: AdaptiveCurrencyRiskPosition[] = [
      { instrument: 'EURUSD', direction: 'BUY', riskAtStop: 100 },
    ];
    const result = analyzeAdaptiveCurrencyExposure({
      positions,
      candidate: { instrument: 'GBPUSD', direction: 'BUY', riskAtStop: 100 },
    });
    expect(result.currencyRiskMap.USD).toBe(-100);
    expect(result.candidateCurrencyRisk.USD).toBe(-100);
    expect(result.correlatedExposureScore).toBeGreaterThan(0);
    expect(result.capacity).toBe('REDUCED');
  });

  it('treats split tickets as the same economic exposure', () => {
    const one = analyzeAdaptiveCurrencyExposure({
      positions: [{ instrument: 'EURUSD', direction: 'BUY', riskAtStop: 100 }],
      candidate: { instrument: 'GBPUSD', direction: 'BUY', riskAtStop: 100 },
    });
    const split = analyzeAdaptiveCurrencyExposure({
      positions: [
        { instrument: 'EURUSD', direction: 'BUY', riskAtStop: 40 },
        { instrument: 'EURUSD', direction: 'BUY', riskAtStop: 60 },
      ],
      candidate: { instrument: 'GBPUSD', direction: 'BUY', riskAtStop: 100 },
    });
    expect(split.currencyRiskMap).toEqual(one.currencyRiskMap);
    expect(split.correlatedExposureScore).toBe(one.correlatedExposureScore);
    expect(split.capacity).toBe(one.capacity);
  });

  it('recognizes genuine opposing currency risk as an offset', () => {
    const result = analyzeAdaptiveCurrencyExposure({
      positions: [{ instrument: 'EURUSD', direction: 'BUY', riskAtStop: 100 }],
      candidate: { instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 100 },
    });
    expect(result.currencyRiskMap.USD).toBe(-100);
    expect(result.candidateCurrencyRisk.USD).toBe(100);
    expect(result.correlatedExposureScore).toBe(0);
    expect(result.capacity).toBe('CLEAR');
  });

  it('fails closed for upsize when any open-position risk-at-stop is unavailable', () => {
    const result = analyzeAdaptiveCurrencyExposure({
      positions: [
        { instrument: 'EURUSD', direction: 'BUY', riskAtStop: null },
        { instrument: 'USDCHF', direction: 'SELL', riskAtStop: 100 },
      ],
      candidate: { instrument: 'GBPUSD', direction: 'BUY', riskAtStop: 100 },
    });
    expect(result.riskEvidenceComplete).toBe(false);
    expect(result.capacity).not.toBe('CLEAR');
    expect(result.canUpsize).toBe(false);
  });

  it('blocks a candidate when aligned shared-currency risk is already extreme', () => {
    const result = analyzeAdaptiveCurrencyExposure({
      positions: [
        { instrument: 'EURUSD', direction: 'BUY', riskAtStop: 100 },
        { instrument: 'USDCHF', direction: 'SELL', riskAtStop: 100 },
      ],
      candidate: { instrument: 'GBPUSD', direction: 'BUY', riskAtStop: 100 },
    });
    expect(result.currencyRiskMap.USD).toBe(-200);
    expect(result.capacity).toBe('BLOCKED');
    expect(result.canUpsize).toBe(false);
  });
});
