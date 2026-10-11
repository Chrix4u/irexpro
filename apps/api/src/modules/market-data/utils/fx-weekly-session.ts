const NEW_YORK_MARKET_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const NEW_YORK_WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** FX weekly session: Sunday 17:00 New York through Friday 17:00 New York. */
export function isFxWeeklySessionOpen(now: Date): boolean {
  const parts = Object.fromEntries(
    NEW_YORK_MARKET_CLOCK.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const day = NEW_YORK_WEEKDAY_INDEX[parts.weekday ?? ''];
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!Number.isInteger(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) return false;

  const minutesSinceMidnight = hour * 60 + minute;
  const weeklyBoundaryMinutes = 17 * 60;
  if (day === 0) return minutesSinceMidnight >= weeklyBoundaryMinutes;
  if (day >= 1 && day <= 4) return true;
  if (day === 5) return minutesSinceMidnight < weeklyBoundaryMinutes;
  return false;
}
