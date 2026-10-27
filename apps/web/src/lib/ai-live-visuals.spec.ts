import {
  LIVE_SCAN_STAGES,
  deriveLiveScanFrame,
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
});
