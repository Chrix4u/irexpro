/**
 * A reversible, DEMO-only entry-authority probation. Observed small-sample
 * after-commission losses in fallback routes justify reducing additional
 * exposure while shadow evidence accrues; they do not establish a winner.
 * This is an additional veto, never an authority grant or LIVE rule.
 */
export const DEMO_PRIMARY_ONLY_PROBATION_ARTIFACT = 'demo-primary-only-route-probation-v2';
export const DEMO_QUALIFIED_CONTINUATION_CANARY_MIN_SAMPLES = 7;
export const DEMO_QUALIFIED_CONTINUATION_CANARY_MIN_WINS = 5;

export interface DemoPrimaryOnlyProbationDecision {
  artifact: typeof DEMO_PRIMARY_ONLY_PROBATION_ARTIFACT;
  enabled: boolean;
  blocked: boolean;
  chosenAuthorityPath: string;
  qualifiedContinuationCanary: boolean;
  reason: 'NOT_ENFORCED' | 'NO_EXECUTABLE_PATH' | 'PRIMARY_PLAN_B'
    | 'FALLBACK_ROUTE_IN_PROBATION' | 'QUALIFIED_CONTINUATION_CANARY';
  modifiesOpenPositions: false;
}

export function evaluateDemoPrimaryOnlyProbation(input: {
  enabled: boolean;
  primaryAuthorityPath: string | null;
  m5HandoffEligible: boolean;
  executableFallbackTier: string | null;
  extensionScoutExecutable: boolean;
  /** Only actual closed exact pair/side M1 trades, never shadow backfills. */
  qualifiedContinuationEvidence?: {
    eligible: boolean;
    reason: string;
    samples: number;
    wins: number;
    averageRealizedR: number | null;
    recentRealizedR: number | null;
  } | null;
  brokerAccountIsDemo?: boolean;
  afterCommissionEvidence?: {
    sampleCount: number;
    netWins: number;
    averageNetR: number | null;
    recentNetR: number | null;
    complete: boolean;
  } | null;
  genuineRollover?: boolean;
  /** Never seed a new M1 fallback into imminent broker rollover spread. */
  preRolloverRiskWindow?: boolean;
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
  const evidence = input.qualifiedContinuationEvidence;
  const afterFee = input.afterCommissionEvidence;
  // This is a narrowly scoped exception to the additional DEMO probation
  // VETO, not an authority grant. The scheduler separately requires native
  // spreads, event safety, route quality, permission, margin, stops, broker
  // state, and a real executable fallback. The broker MUST be DEMO.
  const qualifiedContinuationCanary =
    input.enabled === true &&
    input.brokerAccountIsDemo === true &&
    input.genuineRollover !== true &&
    input.preRolloverRiskWindow !== true &&
    afterFee?.complete === true &&
    afterFee.sampleCount >= DEMO_QUALIFIED_CONTINUATION_CANARY_MIN_SAMPLES &&
    afterFee.netWins >= DEMO_QUALIFIED_CONTINUATION_CANARY_MIN_WINS &&
    Number.isFinite(afterFee.averageNetR) &&
    (afterFee.averageNetR ?? 0) > 0 &&
    Number.isFinite(afterFee.recentNetR) &&
    (afterFee.recentNetR ?? 0) > 0 &&
    chosenAuthorityPath === 'QUALIFIED_CONTINUATION' &&
    evidence?.eligible === true &&
    evidence.reason === 'POSITIVE_EXPECTANCY' &&
    Number.isInteger(evidence.samples) &&
    evidence.samples >= DEMO_QUALIFIED_CONTINUATION_CANARY_MIN_SAMPLES &&
    Number.isInteger(evidence.wins) &&
    evidence.wins >= DEMO_QUALIFIED_CONTINUATION_CANARY_MIN_WINS &&
    Number.isFinite(evidence.averageRealizedR) &&
    (evidence.averageRealizedR ?? 0) > 0 &&
    Number.isFinite(evidence.recentRealizedR) &&
    (evidence.recentRealizedR ?? 0) > 0;
  const blocked =
    input.enabled && executionPathExists &&
    chosenAuthorityPath !== 'PRIMARY_PLAN_B' &&
    !qualifiedContinuationCanary;
  return {
    artifact: DEMO_PRIMARY_ONLY_PROBATION_ARTIFACT,
    enabled: input.enabled,
    blocked,
    chosenAuthorityPath,
    qualifiedContinuationCanary,
    reason: !input.enabled
      ? 'NOT_ENFORCED'
      : !executionPathExists
        ? 'NO_EXECUTABLE_PATH'
        : qualifiedContinuationCanary
          ? 'QUALIFIED_CONTINUATION_CANARY'
          : blocked
            ? 'FALLBACK_ROUTE_IN_PROBATION'
            : 'PRIMARY_PLAN_B',
    modifiesOpenPositions: false,
  };
}
