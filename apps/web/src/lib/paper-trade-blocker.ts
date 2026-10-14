export interface MacroEventBlockEvidence {
  state: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  blockWindowMinutesAfter: number;
  blockingEvents: Array<{
    date: string;
    event: string | null;
  }>;
}

function utcTime(value: Date): string {
  return `${value.getUTCHours().toString().padStart(2, '0')}:${value
    .getUTCMinutes()
    .toString()
    .padStart(2, '0')} UTC`;
}

/** User-facing explanation for a deliberate macro-event execution pause. */
export function describeMacroEventBlock(
  assessment: MacroEventBlockEvidence | null | undefined,
): string | null {
  if (assessment?.state !== 'HIGH_IMPACT_BLOCK') return null;

  const event = assessment.blockingEvents[0];
  if (!event) return 'High-impact macro event safety window';

  const eventAt = new Date(event.date);
  if (!Number.isFinite(eventAt.getTime())) return 'High-impact macro event safety window';

  const afterMinutes = Number.isFinite(assessment.blockWindowMinutesAfter)
    ? Math.max(0, assessment.blockWindowMinutesAfter)
    : 0;
  const protectedUntil = new Date(eventAt.getTime() + afterMinutes * 60_000);
  const eventName = event.event?.trim() || 'High-impact macro event';

  return `${eventName} · event ${utcTime(eventAt)} · protected until ${utcTime(protectedUntil)}`;
}
