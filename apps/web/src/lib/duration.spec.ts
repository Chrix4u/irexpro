import { formatAgeSeconds } from './duration';

describe('formatAgeSeconds', () => {
  it('returns an em dash for missing or invalid values', () => {
    expect(formatAgeSeconds(null)).toBe('—');
    expect(formatAgeSeconds(undefined)).toBe('—');
    expect(formatAgeSeconds(Number.NaN)).toBe('—');
  });

  it('formats short durations with natural singular and plural units', () => {
    expect(formatAgeSeconds(0)).toBe('0 seconds ago');
    expect(formatAgeSeconds(1)).toBe('1 second ago');
    expect(formatAgeSeconds(65)).toBe('1 minute 5 seconds ago');
    expect(formatAgeSeconds(3661)).toBe('1 hour 1 minute 1 second ago');
  });

  it('formats long market-data ages hierarchically', () => {
    const seconds = (1_429_669 * 60) + 17;

    expect(formatAgeSeconds(seconds)).toBe(
      '2 years 8 months 3 weeks 1 day 19 hours 49 minutes 17 seconds ago',
    );
  });

  it('omits zero-valued units and clamps negative ages to zero', () => {
    expect(formatAgeSeconds((365 + 7) * 24 * 60 * 60)).toBe(
      '1 year 1 week ago',
    );
    expect(formatAgeSeconds(-12)).toBe('0 seconds ago');
  });
});
