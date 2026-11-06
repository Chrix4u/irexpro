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
  reason:
    | 'NOT_ENFORCED'
    | 'NO_EXECUTABLE_PATH'
    | 'PRIMARY_PLAN_B'
    | 'QUALIFIED_CONTINUATION_MICRO_TRIAL'
    | 'FALLBACK_ROUTE_IN_PROBATION';
  /** Maximum executable volume for an independently verified DEMO micro trial. */
  trialLotCap: number | null;
  modifiesOpenPositions: false;
}

export function evaluateDemoPrimaryOnlyProbation(input: {
  enabled: boolean;
  primaryAuthorityPath: string | null;
  m5HandoffEligible: boolean;
  executableFallbackTier: string | null;
  extensionScoutExecutable: boolean;
  /** Verified cTrader DEMO account with positive local reliability and fresh agreement. */
  qualifiedContinuationMicroTrialEligible?: boolean;
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
  // A failed Plan-B admission is not an otherwise executable fallback.
  // Otherwise this diagnostic marks every declined primary setup as a
  // 'probation veto' even when removing probation would NOT create a trade.
  // This does not grant authority: every real alternate executable path
  // (M5 handoff, fallback, scout or rescued primary) remains vetoed.
  const executionPathExists =
    chosenAuthorityPath !== 'BLOCKED' && chosenAuthorityPath !== 'UNKNOWN';
  // The unanimity-based, forecast-shadow route remains the primary Plan-B
  // model with only predictive economic admission in research mode.
  // It is not a lower-quality fallback; all broker, drift and risk vetoes remain.
  const primaryRoute =
    chosenAuthorityPath === 'PRIMARY_PLAN_B' || chosenAuthorityPath === 'FORECAST_SHADOW_CONSENSUS';
  const qualifiedMicroTrial =
    input.enabled &&
    input.qualifiedContinuationMicroTrialEligible === true &&
    chosenAuthorityPath === 'QUALIFIED_CONTINUATION';
  const blocked = input.enabled && executionPathExists && !primaryRoute && !qualifiedMicroTrial;
  return {
    artifact: DEMO_PRIMARY_ONLY_PROBATION_ARTIFACT,
    enabled: input.enabled,
    blocked,
    chosenAuthorityPath,
    trialLotCap: qualifiedMicroTrial ? 0.05 : null,
    reason: !input.enabled
      ? 'NOT_ENFORCED'
      : !executionPathExists
        ? 'NO_EXECUTABLE_PATH'
        : blocked
          ? 'FALLBACK_ROUTE_IN_PROBATION'
          : qualifiedMicroTrial
            ? 'QUALIFIED_CONTINUATION_MICRO_TRIAL'
            : 'PRIMARY_PLAN_B',
    modifiesOpenPositions: false,
  };
}
