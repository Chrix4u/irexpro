import { strict as assert } from 'node:assert';
import {
  SIDE_SELECTION_PATTERN_TELEMETRY_ARTIFACT,
  buildSideSelectionPatternTelemetry,
} from './side-selection-pattern-telemetry';

function candles(count = 30) {
  const start = Date.parse('2026-11-02T10:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const open = 1.1 + index * 0.0002;
    const close = open + 0.00012;
    return {
      timestamp: new Date(start + index * 5 * 60_000),
      open: open.toFixed(5),
      high: (close + 0.00008).toFixed(5),
      low: (open - 0.00006).toFixed(5),
      close: close.toFixed(5),
    };
  });
}

describe('side-selection pattern telemetry', () => {
  it('captures pre-entry multi-bar structure and direction-aligned features without execution authority', () => {
    const rows = candles();
    const decisionBarTime = rows.at(-1)!.timestamp;
    const buy = buildSideSelectionPatternTelemetry({
      candles: rows,
      direction: 'BUY',
      atr: 0.001,
      decisionBarTime,
      mtfStrength: 0.42,
      h1Alignment: 0.31,
      h4Alignment: 0.27,
    });
    const sell = buildSideSelectionPatternTelemetry({
      candles: rows,
      direction: 'SELL',
      atr: 0.001,
      decisionBarTime,
      mtfStrength: 0,
      h1Alignment: 0,
      h4Alignment: 0,
    });

    assert.equal(buy.artifact, SIDE_SELECTION_PATTERN_TELEMETRY_ARTIFACT);
    assert.equal(buy.available, true);
    assert.equal(buy.executionAuthority, 'NONE');
    assert.equal(buy.modifiesExecution, false);
    assert.equal(buy.baseBarsUsed, 30);
    if (!buy.raw || !buy.aligned || !sell.raw || !sell.aligned) {
      assert.fail('available telemetry must include raw and aligned features');
    }
    assert.ok(buy.raw.momentum1Atr > 0);
    assert.ok(buy.raw.momentum3Atr > buy.raw.momentum1Atr);
    assert.ok(buy.raw.momentum6Atr > buy.raw.momentum3Atr);
    assert.ok(buy.raw.ema9SlopeAtr > 0);
    assert.ok(buy.raw.bodyPressure3 > 0);
    assert.ok(buy.raw.pathEfficiency6 > 0);
    assert.ok(buy.aligned.momentum3Atr > 0);
    assert.ok(sell.aligned.momentum3Atr < 0);
    assert.equal(buy.aligned.directionalRun, 6);
    assert.equal(sell.aligned.directionalRun, -6);
    assert.equal(buy.context.mtfStrength, 0.42);
    assert.equal(buy.context.h1Alignment, 0.31);
    assert.equal(buy.context.h4Alignment, 0.27);
  });

  it('ignores candles after the decision bar so future data cannot alter telemetry', () => {
    const rows = candles();
    const decisionBarTime = rows.at(-1)!.timestamp;
    const baseline = buildSideSelectionPatternTelemetry({
      candles: rows,
      direction: 'BUY',
      atr: 0.001,
      decisionBarTime,
      mtfStrength: 0.3,
      h1Alignment: 0.2,
      h4Alignment: 0.1,
    });
    const contaminated = buildSideSelectionPatternTelemetry({
      candles: [
        ...rows,
        {
          timestamp: new Date(decisionBarTime.getTime() + 5 * 60_000),
          open: '1.50000',
          high: '2.00000',
          low: '0.50000',
          close: '1.90000',
        },
      ],
      direction: 'BUY',
      atr: 0.001,
      decisionBarTime,
      mtfStrength: 0.3,
      h1Alignment: 0.2,
      h4Alignment: 0.1,
    });

    assert.deepEqual(contaminated, baseline);
  });

  it('fails closed as unavailable for invalid ATR or insufficient closed bars', () => {
    const rows = candles(10);
    const unavailable = buildSideSelectionPatternTelemetry({
      candles: rows,
      direction: 'BUY',
      atr: 0,
      decisionBarTime: rows.at(-1)!.timestamp,
      mtfStrength: 0,
      h1Alignment: 0,
      h4Alignment: 0,
    });

    assert.equal(unavailable.available, false);
    assert.equal(unavailable.reason, 'INVALID_ATR');
    assert.equal(unavailable.executionAuthority, 'NONE');
    assert.equal(unavailable.modifiesExecution, false);
  });
});
