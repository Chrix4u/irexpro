/**
 * DEMO-only M1 promoted model entry scope, justified by the 2026-11-05
 * completed broker FULL_AUTO DEMO trade audit. Every pair had negative
 * AFTER-COST net P&L; these three are a controlled trial, not winners.
 * The other three stay under research until independent evidence improves.
 *
 * Use this same immutable list at both scheduler and the central signal
 * orchestrator boundary so a delayed/replayed signal cannot bypass it.
 */
export const DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1: readonly string[] = Object.freeze([
  'AUDUSD',
  'GBPUSD',
  'EURUSD',
]);

/** An exact symbol match is required; suffix aliases never acquire authority. */
export function isFocusedDemoEntryInstrument(instrument: string): boolean {
  return DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1.includes(instrument);
}
