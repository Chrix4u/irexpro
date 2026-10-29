import {
  LIVE_SCAN_STAGES,
  deriveLiveScanFrame,
  mergeLiveQuoteIntoCandles,
  selectChartWindow,
  shiftChartWindow,
  zoomChartWindow,
} from './ai-live-visuals';

describe('ai live visuals', () => {
  it('cycles through visible scan stages while automation is running', () => {
    const first = deriveLiveScanFrame({ tick: 0, automationOn: true });
    const second = deriveLiveScanFrame({ tick: 1, automationOn: true });
    const wrapped = deriveLiveScanFrame({ tick: LIVE_SCAN_STAGES.length, automationOn: true });

    expect(first.stage.id).toBe('MARKET_FEED');
    expect(second.stage.id).toBe('FEATURES');
    expect(wrapped.stage.id).toBe('MARKET_FEED');
    expect(first.sweepPercent).toBeGreaterThanOrEqual(0);
    expect(first.sweepPercent).toBeLessThanOrEqual(100);
  });

  it('parks scan activity when automation is stopped', () => {
    const frame = deriveLiveScanFrame({ tick: 9, automationOn: false });
    expect(frame.stage.id).toBe('IDLE');
    expect(frame.sweepPercent).toBe(0);
  });

  it('zooms chart windows within useful bounds', () => {
    expect(zoomChartWindow(50, 'IN', 90)).toBe(40);
    expect(zoomChartWindow(20, 'IN', 90)).toBe(20);
    expect(zoomChartWindow(80, 'OUT', 90)).toBe(90);
    expect(zoomChartWindow(90, 'OUT', 90)).toBe(90);
  });

  it('pans backward and forward without leaving available candle history', () => {
    expect(shiftChartWindow(0, 'BACK', 40, 90)).toBe(10);
    expect(shiftChartWindow(50, 'BACK', 40, 90)).toBe(50);
    expect(shiftChartWindow(10, 'FORWARD', 40, 90)).toBe(0);
  });

  it('selects the requested visible candle window from the latest edge', () => {
    const rows = Array.from({ length: 10 }, (_, index) => index);
    expect(selectChartWindow(rows, 4, 0)).toEqual([6, 7, 8, 9]);
    expect(selectChartWindow(rows, 4, 2)).toEqual([4, 5, 6, 7]);
  });

  it('updates the forming M5 candle from the latest broker quote', () => {
    const candles = [
      {
        timestamp: '2026-10-29T01:30:00.000Z',
        open: '1.16000',
        high: '1.16040',
        low: '1.15980',
        close: '1.16020',
        volume: '8',
      },
    ];
    const next = mergeLiveQuoteIntoCandles(candles, {
      bid: '1.16060',
      ask: '1.16080',
      timestamp: '2026-10-29T01:33:12.000Z',
    }, 'M5');

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      timestamp: '2026-10-29T01:30:00.000Z',
      open: '1.16000',
      high: '1.16070',
      low: '1.15980',
      close: '1.16070',
    });
  });

  it('rolls the live chart into a new M5 bucket without mutating the completed candle', () => {
    const candles = [
      {
        timestamp: '2026-10-29T01:30:00.000Z',
        open: '1.16000',
        high: '1.16080',
        low: '1.15980',
        close: '1.16050',
        volume: '12',
      },
    ];
    const next = mergeLiveQuoteIntoCandles(candles, {
      bid: '1.16090',
      ask: '1.16110',
      timestamp: '2026-10-29T01:35:01.000Z',
    }, 'M5');

    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(candles[0]);
    expect(next[1]).toMatchObject({
      timestamp: '2026-10-29T01:35:00.000Z',
      open: '1.16100',
      high: '1.16100',
      low: '1.16100',
      close: '1.16100',
      volume: '0',
    });
  });

  it('ignores out-of-order quotes so a stale tick cannot rewrite the chart', () => {
    const candles = [
      {
        timestamp: '2026-10-29T01:35:00.000Z',
        open: '1.16100',
        high: '1.16120',
        low: '1.16090',
        close: '1.16110',
        volume: '2',
      },
    ];
    const next = mergeLiveQuoteIntoCandles(candles, {
      bid: '1.15900',
      ask: '1.15920',
      timestamp: '2026-10-29T01:34:59.000Z',
    }, 'M5');

    expect(next).toEqual(candles);
  });
});
