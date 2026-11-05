/**
 * A reversible, DEMO-only entry-authority probation. Observed small-sample
 * after-commission losses in fallback routes justify reducing additional
 * exposure while shadow evidence accrues; they do not establish a winner.
 * This is an additional veto, never an authority grant or LIVE rule.
 */
export const DEMO_PRIMARY_ONLY_PROBATION_ARTIFACT = 'demo-primary-only-route-probation-v1';

export interface DemoPrimaryOnlyProbationDecision {
  artifact: typeof DEMO_PRIMARY_ONLY_PROBATION_ARTIFACT;
  enabled: boolean;
  blocked: boolean;
  chosenAuthorityPath: string;
  reason: 'NOT_ENFORCED' | 'PRIMARY_PLAN_B' | 'FALLBACK_ROUTE_IN_PROBATION';
  modifiesOpenPositions: false;
}

export function evaluateDemoPrimaryOnlyProbation(input: {
  enabled: boolean;
  primaryAuthorityPath: string | null;
  m5HandoffEligible: boolean;
  executableFallbackTier: string | null;
  extensionScoutExecutable: boolean;
}): DemoPrimaryOnlyProbationDecision {
  // This exactly matches the order-routing precedence in submitPaperDecision.
  // A fallback that has no primary permission stays observational only.
  const chosenAuthorityPath = input.m5HandoffEligible
    ? 'M5_EARLY_TRANSITION_HANDOFF'
    : input.executableFallbackTier
      ? input.executableFallbackTier
      : input.extensionScoutExecutable
        ? 'EXTENSION_EXHAUSTION_DEMO_SCOUT'
        : (input.primaryAuthorityPath ?? 'UNKNOWN');
  const blocked = input.enabled && chosenAuthorityPath !== 'PRIMARY_PLAN_B';
  return {
    artifact: DEMO_PRIMARY_ONLY_PROBATION_ARTIFACT,
    enabled: input.enabled,
    blocked,
    chosenAuthorityPath,
    reason: !input.enabled
      ? 'NOT_ENFORCED'
      : blocked
        ? 'FALLBACK_ROUTE_IN_PROBATION'
        : 'PRIMARY_PLAN_B',
    modifiesOpenPositions: false,
  };
}
