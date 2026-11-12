/**
 * DEMO-only M1 promoted model entry scope, justified by the 2026-11-05
 * completed broker FULL_AUTO DEMO trade audit. Every pair had negative
 * AFTER-COST net P&L; these three are a controlled trial, not winners.
 * Historical V1 policy only: retained to allow faithful replay and rollback.
 * The operator-requested six-pair DEMO restoration is the separately
 * versioned V2 list below; neither list grants LIVE or PAPER authority.
 */
export const DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1: readonly string[] = Object.freeze([
  'AUDUSD',
  'GBPUSD',
  'EURUSD',
]);

/**
 * 2026-11-09 DEMO-only restoration of the original six major instruments.
 * The entry allowlist is not an execution shortcut: Plan B, M1 timing, OOD,
 * news, broker authorization, risk engine, margin and stops remain mandatory.
 * Historical after-fee sleeves are negative; review outcomes before promotion.
 */
export const DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2: readonly string[] = Object.freeze([
  'AUDUSD',
  'GBPUSD',
  'EURUSD',
  'USDCAD',
  'USDCHF',
  'USDJPY',
]);

/**
 * 2026-11-12 DEMO-focused two-pair pilot after the 10–12 November
 * broker-settled sleeve audit. The other four are DORMANT: not executed
 * and not evaluated by the M1 tactical scheduler. Historical evidence
 * remains available for later explicit operator reactivation.
 * Neither paper nor live authority is expanded.
 */
export const DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3: readonly string[] = Object.freeze([
  'EURUSD',
  'AUDUSD',
]);

/**
 * 2026-11-12 user-approved four-pair FULL_AUTO DEMO execution universe.
 * All four are eligible to reach ordinary independent model, after-fee,
 * spread, session/news, broker identity, margin, stop and risk checks.
 * GBPUSD and USDCHF remain DORMANT. V1/V2/V3 are retained for rollback.
 * Immutable exact instruments: no aliases, no LIVE authority.
 */
export const DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4: readonly string[] = Object.freeze([
  'EURUSD',
  'AUDUSD',
  'USDCAD',
  'USDJPY',
]);

/** The historic focused-three scope remains available for precise rollback. */
export function isFocusedDemoEntryInstrument(instrument: string): boolean {
  return DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1.includes(instrument);
}

/** Exact-symbol DEMO entry scope; suffix aliases never gain authority. */
export function isRestoredDemoEntryInstrument(instrument: string): boolean {
  return DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2.includes(instrument);
}
/**
 * Central strategy-orchestrator guard MUST mirror the ACTIVE V4 policy,
 * not historical V3. Otherwise scanned USDCAD/USDJPY would be denied
 * just before broker-risk validation even though the scheduler allowed
 * them. Exact symbols only, no LIVE promotion.
 */
export function isCurrentFocusedDemoEntryInstrument(instrument: string): boolean {
  return DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.includes(instrument);
}
