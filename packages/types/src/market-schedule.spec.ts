import {
  getFxMarketSchedule,
  isFxWeeklySessionOpen,
  nextFxEligibleScanAt,
} from './market-schedule';

describe('FX weekly market schedule', () => {
  it('uses the New York 17:00 weekly boundary during EDT', () => {
    expect(isFxWeeklySessionOpen(new Date('2026-10-04T20:59:59.000Z'))).toBe(false);
    expect(isFxWeeklySessionOpen(new Date('2026-10-04T21:00:00.000Z'))).toBe(true);
    expect(isFxWeeklySessionOpen(new Date('2026-10-09T20:59:59.000Z'))).toBe(true);
    expect(isFxWeeklySessionOpen(new Date('2026-10-09T21:00:00.000Z'))).toBe(false);
  });

  it('follows EST after the New York DST transition', () => {
    expect(isFxWeeklySessionOpen(new Date('2026-12-06T21:59:59.000Z'))).toBe(false);
    expect(isFxWeeklySessionOpen(new Date('2026-12-06T22:00:00.000Z'))).toBe(true);
    expect(isFxWeeklySessionOpen(new Date('2026-12-11T21:59:59.000Z'))).toBe(true);
    expect(isFxWeeklySessionOpen(new Date('2026-12-11T22:00:00.000Z'))).toBe(false);
  });

  it('returns the exact next five-minute eligible scan from a weekend', () => {
    expect(nextFxEligibleScanAt(new Date('2026-10-24T17:00:00.000Z'), 5).toISOString()).toBe(
      '2026-10-25T21:00:00.000Z',
    );
    expect(getFxMarketSchedule(new Date('2026-10-24T17:00:00.000Z'), 5)).toEqual({
      paused: true,
      reason: 'WEEKEND',
      nextEligibleScanAt: '2026-10-25T21:00:00.000Z',
    });
  });

  it('returns OPEN and the next cadence slot during the session', () => {
    expect(getFxMarketSchedule(new Date('2026-10-26T10:02:00.000Z'), 5)).toEqual({
      paused: false,
      reason: null,
      nextEligibleScanAt: '2026-10-26T10:05:00.000Z',
    });
  });
});
