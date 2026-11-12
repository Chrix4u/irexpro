/**
 * Shared forex session clock.
 *
 * The close/rollover liquidity hour follows 17:00 America/New_York,
 * not a constant 21:00 UTC throughout both winter and summer. 17:00 NY
 * is 21:00 UTC under EDT and 22:00 UTC under EST.
 *
 * The session tags are research/risk context, not proof a broker is open
 * or permission to execute. Broker market availability and actual spread
 * safety are checked separately.
 */
const NY_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hourCycle: 'h23',
});

export type ForexSessionClockLabel =
  | 'ASIA' | 'LONDON' | 'NEW_YORK' | 'ROLLOVER';

export function classifyForexSessionClock(
  evaluatedAt: Date,
): ForexSessionClockLabel {
  if (!Number.isFinite(evaluatedAt.getTime())) {
    throw new Error('Forex session timestamp must be valid');
  }
  const hourUtc = evaluatedAt.getUTCHours();
  const nyHour = Number(NY_HOUR.format(evaluatedAt));
  // Exactly one hour at the NY broker day transition, including DST.
  if (nyHour === 17) return 'ROLLOVER';
  // New York evening after rollover overlaps early Asia, UTC morning is
  // traditionally Asia. A fixed hourUtc>=21 used to mark three hours as
  // rollover even when NY 17:00 had already passed.
  if (nyHour >= 18 || hourUtc < 7) return 'ASIA';
  if (hourUtc < 13) return 'LONDON';
  return 'NEW_YORK';
}
