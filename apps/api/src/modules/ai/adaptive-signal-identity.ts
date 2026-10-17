import type { AiSignalCandidate } from './interfaces/ai-signal-candidate.interface';

export const INTERNAL_ADAPTIVE_STRATEGY_CODE = 'external-irexpro-multimodel-ensemble-v1';

/**
 * Placeholder identity normalizer used by the regression-first TDD commit.
 * Production wiring is added only after the regression proves the old
 * bar-level signal id can collide with a materially revised payload.
 */
export function materializeAdaptiveSignalIdentity(candidate: AiSignalCandidate): AiSignalCandidate {
  return candidate;
}
