/**
 * DEMO-only, as-of decision admission stop for a uniquely uncalibrated case.
 * Never reads future candles, trade outcomes or account positions.
 * Does not change active positions or LIVE execution authorization.
 * This is NOT a profitability predictor or a blanket M1 specialist veto.
 */
export interface DemoDoubleAbstainAdmissionInput {
  verifiedPepperstoneDemo: boolean;
  professionalDemoPhase: boolean;
  professionalM1Fallback: boolean;
  m1Route: string | null;
  independentExpertState: string | null;
  matchedExpectancySamples: number | null;
  driftOutOfDistribution: boolean;
  independentGovernanceEligible: boolean;
}

export const DEMO_DOUBLE_ABSTAIN_UNCALIBRATED_OOD =
  'M1_DEMO_DOUBLE_ABSTAIN_UNCALIBRATED_OOD' as const;

export function evaluateDemoDoubleAbstainAdmission(
  input: DemoDoubleAbstainAdmissionInput,
): { allowed: boolean; reason: typeof DEMO_DOUBLE_ABSTAIN_UNCALIBRATED_OOD | null } {
  const exactUncalibratedAbstention =
    input.verifiedPepperstoneDemo === true &&
    input.professionalDemoPhase === true &&
    input.professionalM1Fallback === false &&
    input.m1Route === 'ABSTAIN' &&
    input.independentExpertState === 'ABSTAIN' &&
    Number.isFinite(input.matchedExpectancySamples) &&
    input.matchedExpectancySamples === 0 &&
    input.driftOutOfDistribution === true &&
    input.independentGovernanceEligible === false;

  return exactUncalibratedAbstention
    ? { allowed: false, reason: DEMO_DOUBLE_ABSTAIN_UNCALIBRATED_OOD }
    : { allowed: true, reason: null };
}
