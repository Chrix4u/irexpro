import {
  compareAdverseExitCounterfactual,
  type AdverseExitCounterfactualInput,
  type ExitCandle,
} from './profit-exit-alternatives';

const closedAt = new Date('2026-11-05T04:35:28.000Z');
const candle = (minute: number, high: number, low: number): ExitCandle => {
  const time = new Date(closedAt.getTime());
  time.setUTCMinutes(35 + minute, 0, 0);
  return {
    bucket_time: time,
    high,
    low,
    sample_count: 10,
    positive_quote_sample_count: 8,
    last_quote_sample_at: new Date(time.getTime() + 35_000),
    source: 'ctrader-broker-native',
  };
};
const base: AdverseExitCounterfactualInput = {
  direction: 'BUY',
  closeAt: closedAt,
  entryPrice: 1.1,
  exitPrice: 1.0998,
  stopPrice: 1.0994,
  takeProfitPrice: 1.1006,
  grossPnl: -4,
  commission: -1.2,
  swap: 0,
  candles: [],
};

describe('60m adverse-thesis-close continuation (research only)', () => {
  it('detects a first TP after an AI loss close, but only as a quote midpoint proxy', () => {
    const report = compareAdverseExitCounterfactual({
      ...base,
      candles: [candle(1, 1.1003, 1.0999), candle(2, 1.10065, 1.1001)],
    });
    expect(report).toMatchObject({
      mode: 'SHADOW_ONLY',
      modifiesExecution: false,
      forecastAtEntry: false,
      brokerFillCertified: false,
      originalNetPnl: -5.2,
      originalSlTpHold: { outcome: 'TP_FIRST', netPnlProxy: 10.8, deltaVsOriginal: 16 },
    });
  });

  it('detects an original stop first and does not label a later TP as a recovery', () => {
    const report = compareAdverseExitCounterfactual({
      ...base,
      candles: [candle(1, 1.1001, 1.0993), candle(2, 1.1007, 1.0999)],
    });
    expect(report.originalSlTpHold).toMatchObject({
      outcome: 'STOP_FIRST',
      netPnlProxy: -13.2,
      deltaVsOriginal: -8,
    });
  });

  it('reports same-minute both barriers as ambiguous rather than choosing an order', () => {
    const report = compareAdverseExitCounterfactual({
      ...base,
      candles: [candle(1, 1.1007, 1.0992)],
    });
    expect(report.originalSlTpHold).toMatchObject({ outcome: 'AMBIGUOUS', netPnlProxy: null });
  });

  it('rejects holes, backfilled/non-live observations, and out-of-bucket samples', () => {
    const missing = compareAdverseExitCounterfactual({
      ...base,
      candles: [candle(2, 1.1007, 1.1)],
    });
    expect(missing.originalSlTpHold.outcome).toBe('DATA_GAP');
    const synthetic = compareAdverseExitCounterfactual({
      ...base,
      candles: [{ ...candle(1, 1.1007, 1.1), positive_quote_sample_count: 0 }],
    });
    expect(synthetic.originalSlTpHold).toMatchObject({ outcome: 'DATA_GAP', netPnlProxy: null });
    const late = compareAdverseExitCounterfactual({
      ...base,
      candles: [
        { ...candle(1, 1.1007, 1.1), last_quote_sample_at: new Date('2026-11-05T04:40:00Z') },
      ],
    });
    expect(late.originalSlTpHold.outcome).toBe('DATA_GAP');
  });

  it('supports sell geometry but rejects a fill inconsistent with a losing move', () => {
    const result = compareAdverseExitCounterfactual({
      ...base,
      direction: 'SELL',
      entryPrice: 0.65,
      exitPrice: 0.6502,
      stopPrice: 0.6508,
      takeProfitPrice: 0.6494,
      candles: [candle(1, 0.6503, 0.6493)],
    });
    expect(result.originalSlTpHold.outcome).toBe('TP_FIRST');
    const invalid = compareAdverseExitCounterfactual({ ...base, exitPrice: 1.1002 });
    expect(invalid.originalSlTpHold).toMatchObject({ outcome: 'INELIGIBLE', netPnlProxy: null });
  });

  it('keeps trades unresolved when all later quote candles are clean but no barrier occurs', () => {
    const candles = Array.from({ length: 59 }, (_, i) => candle(i + 1, 1.1001, 1.0997));
    const result = compareAdverseExitCounterfactual({ ...base, candles });
    expect(result.originalSlTpHold).toMatchObject({
      outcome: 'UNRESOLVED',
      observedBars: 59,
      netPnlProxy: null,
    });
  });
});
