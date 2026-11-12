import {
  DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4,
} from './demo-focused-instruments';

/**
 * Bounded, serial-scheduler priority for the RESTORED six-pair DEMO entry
 * policy. USDJPY is the operator's primary research focus; evaluating it
 * last generated ~66s mean / ~92s p90 persistence delays (2026-11-11 UTC
 * 00:42 read-only Pepperstone decision audit).
 *
 * The five remaining equally eligible pairs rotate across completed-minute
 * slots instead of keeping the same pair perpetually last. The rotation is
 * deterministic, immutable, and affects ONLY evaluation order: no extra
 * dispatch workers, no model threshold changes or new execution authority.
 *
 * All focused-three, PAPER, SHADOW, and incomplete/unrecognised DEMO lists
 * retain their historical order exactly.
 */
export function orderM1DemoSixPairScan(input: {
  phase: string;
  policyInstruments: readonly string[];
  demoEntryInstruments?: readonly string[];
  decisionTime: Date;
}): string[] {
  const focused = input.demoEntryInstruments;
  const existing = focused
    ? [
        ...focused.filter((instrument) => input.policyInstruments.includes(instrument)),
        ...input.policyInstruments.filter((instrument) => !focused.includes(instrument)),
      ]
    : [...input.policyInstruments];

  // V3 operator focus is deliberately a SCAN restriction, not merely
  // prioritisation. Skipped pairs cannot load broker bars, score, or reach
  // broker order routing through this M1 scheduler. Older policies keep
  // their historical scanning semantics for reproducible replay.
  const focusedTwo =
    input.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' &&
    focused?.length === DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3.length &&
    DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3.every(
      (instrument) => focused.includes(instrument) && input.policyInstruments.includes(instrument),
    );
  if (focusedTwo) return [...DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3];

  // Four-pair DEMO focus must be a SCAN boundary as well as an entry
  // allowlist. Rotating the lead by completed minute avoids always
  // starving USDCAD/USDJPY behind the first two in a slow serial loop.
  // Malformed, duplicate or non-DEMO focus never gains this shortcut.
  const focusedFour =
    input.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' &&
    focused?.length === DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.length &&
    input.decisionTime instanceof Date &&
    Number.isFinite(input.decisionTime.getTime()) &&
    DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.every(
      (instrument) => focused.includes(instrument) && input.policyInstruments.includes(instrument),
    );
  if (focusedFour) {
    const minute = Math.floor(input.decisionTime.getTime() / 60_000);
    const offset = ((minute % DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.length) +
      DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.length) % DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.length;
    return [
      ...DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.slice(offset),
      ...DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4.slice(0, offset),
    ];
  }

  const isExactlyRestoredSix =
    input.phase === 'DEMO_EARLY_TRANSITION_PROFESSIONAL' &&
    focused?.length === DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2.length &&
    existing.length === DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2.length &&
    new Set(existing).size === DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2.length &&
    DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2.every(
      (instrument) => focused.includes(instrument) && existing.includes(instrument),
    ) &&
    input.decisionTime instanceof Date &&
    Number.isFinite(input.decisionTime.getTime());

  if (!isExactlyRestoredSix) return existing;

  const remaining = existing.filter((instrument) => instrument !== 'USDJPY');
  const minute = Math.floor(input.decisionTime.getTime() / 60_000);
  const offset = ((minute % remaining.length) + remaining.length) % remaining.length;
  return ['USDJPY', ...remaining.slice(offset), ...remaining.slice(0, offset)];
}
