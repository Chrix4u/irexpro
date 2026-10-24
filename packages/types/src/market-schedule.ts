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

export type FxMarketSchedule = {
  paused: boolean;
  reason: 'WEEKEND' | 'ROLLOVER_LOW_LIQUIDITY' | null;
  nextEligibleScanAt: string;
};

/** FX weekly session: Sunday 17:00 New York through Friday 17:00 New York. */
export function isFxWeeklySessionOpen(now: Date): boolean {
  if (!Number.isFinite(now.getTime())) return false;
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

export function nextFxEligibleScanAt(now: Date, cadenceMinutes = 5): Date {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(cadenceMinutes) || cadenceMinutes <= 0) {
    throw new Error('A valid time and positive integer cadence are required');
  }
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  const remainder = candidate.getUTCMinutes() % cadenceMinutes;
  candidate.setUTCMinutes(
    candidate.getUTCMinutes() + (remainder === 0 ? cadenceMinutes : cadenceMinutes - remainder),
  );
  const maxSteps = Math.ceil((7 * 24 * 60) / cadenceMinutes) + 12;
  for (let index = 0; index < maxSteps; index += 1) {
    if (isFxWeeklySessionOpen(candidate)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + cadenceMinutes);
  }
  return candidate;
}

export function getFxMarketSchedule(now: Date, cadenceMinutes = 5): FxMarketSchedule {
  const paused = !isFxWeeklySessionOpen(now);
  return {
    paused,
    reason: paused ? 'WEEKEND' : null,
    nextEligibleScanAt: nextFxEligibleScanAt(now, cadenceMinutes).toISOString(),
  };
}
