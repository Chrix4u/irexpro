const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const DURATION_UNITS = [
  { seconds: YEAR, singular: 'year', plural: 'years' },
  { seconds: MONTH, singular: 'month', plural: 'months' },
  { seconds: WEEK, singular: 'week', plural: 'weeks' },
  { seconds: DAY, singular: 'day', plural: 'days' },
  { seconds: HOUR, singular: 'hour', plural: 'hours' },
  { seconds: MINUTE, singular: 'minute', plural: 'minutes' },
  { seconds: SECOND, singular: 'second', plural: 'seconds' },
] as const;

export function formatAgeSeconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';

  let remaining = Math.max(0, Math.floor(value));
  const parts: string[] = [];

  for (const unit of DURATION_UNITS) {
    const amount = Math.floor(remaining / unit.seconds);
    if (amount > 0) {
      parts.push(`${amount} ${amount === 1 ? unit.singular : unit.plural}`);
      remaining %= unit.seconds;
    }
  }

  if (parts.length === 0) {
    return '0 seconds ago';
  }

  return `${parts.join(' ')} ago`;
}
