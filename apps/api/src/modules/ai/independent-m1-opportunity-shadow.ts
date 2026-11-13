/**
 * Independent M1 continuation hypothesis, sampled BEFORE any future candles.
 *
 * Plan B is deliberately not an input that can veto this hypothesis. The
 * model's research grade, actual broker fills, opportunity quality and later
 * outcomes can therefore be evaluated independently of the ensemble.
 *
 * The result is strictly observational: never routes an order, changes
 * existing positions, adjusts broker risk, or promotes any model.
 */
export const INDEPENDENT_M1_OPPORTUNITY_ARTIFACT =
  'independent-m1-after-cost-opportunity-shadow-v1' as const;
export const INDEPENDENT_M1_EXIT_HORIZONS_MINUTES = [3, 5, 6, 7, 10] as const;

export interface IndependentM1OpportunityInput {
  instrument: string;
  direction: 'BUY' | 'SELL';
  route: string;
  evaluatedAt: Date;
  candidateEntry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  directionQuality: number;
  routeEligible: boolean;
  m1PaperEligible: boolean;
  m1NetExpectedR: number;
  spreadEvidenceValid: boolean;
  eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  reliability: {
    eligible: boolean;
    reason: string;
    samples: number;
    wins: number;
    losses: number;
    recentRealizedR: number | null;
  } | null;
  planB: {
    paperAdmitted: boolean;
    netExpectedR: number | null;
    regime: string;
  } | null;
}

export function evaluateIndependentM1OpportunityShadow(
  input: IndependentM1OpportunityInput,
) {
  const reasons: string[] = [];
  if (input.route !== 'M1_TREND_CONTINUATION') reasons.push('OTHER_M1_ROUTE');
  if (!input.routeEligible) reasons.push('M1_TIMING_NOT_ELIGIBLE');
  if (!input.m1PaperEligible) reasons.push('M1_GOVERNANCE_NOT_ADMITTED');
  if (input.eventRisk !== 'CLEAR') reasons.push('EVENT_RISK_NOT_CLEAR');
  if (!input.spreadEvidenceValid) reasons.push('BROKER_SPREAD_NOT_VERIFIED');
  if (!input.reliability?.eligible) reasons.push('ACTUAL_PAIR_SIDE_RELIABILITY_NOT_ELIGIBLE');
  if (!Number.isFinite(input.m1NetExpectedR))
    reasons.push('M1_EXPECTED_RETURN_NOT_FINITE');
  if (!Number.isFinite(input.candidateEntry) || input.candidateEntry <= 0 ||
      !Number.isFinite(input.stopLoss) || !Number.isFinite(input.takeProfit))
    reasons.push('CANDIDATE_PRICE_GEOMETRY_INVALID');
  const positiveExitGeometry = input.direction === 'SELL'
    ? input.stopLoss > input.candidateEntry && input.takeProfit < input.candidateEntry
    : input.stopLoss < input.candidateEntry && input.takeProfit > input.candidateEntry;
  if (!positiveExitGeometry) reasons.push('CANDIDATE_STOP_TARGET_INCONSISTENT');

  const eligibleForStudy = reasons.length === 0;
  const planBDisagrees = eligibleForStudy &&
    input.planB !== null && input.planB.paperAdmitted !== true;
  return {
    artifact: INDEPENDENT_M1_OPPORTUNITY_ARTIFACT,
    mode: 'SHADOW_ONLY' as const,
    executionAuthority: 'NONE' as const,
    modifiesExecution: false as const,
    modifiesOpenPositions: false as const,
    changesStopLoss: false as const,
    eligibleForStudy,
    reasons,
    direction: input.direction,
    instrument: input.instrument,
    route: input.route,
    evaluatedAt: input.evaluatedAt.toISOString(),
    snapshotEntry: input.candidateEntry,
    snapshotStopLoss: input.stopLoss,
    snapshotTakeProfit: input.takeProfit,
    confidence: input.confidence,
    directionQuality: input.directionQuality,
    m1NetExpectedR: input.m1NetExpectedR,
    reliabilitySamples: input.reliability?.samples ?? 0,
    reliabilityReason: input.reliability?.reason ?? null,
    realisedRecentR: input.reliability?.recentRealizedR ?? null,
    planBDisagrees,
    planBPaperAdmitted: input.planB?.paperAdmitted ?? null,
    planBNetExpectedR: input.planB?.netExpectedR ?? null,
    planBRegime: input.planB?.regime ?? null,
    exitHorizonMinutes: [...INDEPENDENT_M1_EXIT_HORIZONS_MINUTES],
    hypotheticalProfitCapturePips: [1.5, 2.0, 3.0],
    hypotheticalStopLoss: 'EXISTING_CANDIDATE_STOP',
    outcomeScored: false as const,
    outcomeRequiredBeforePromotion: true as const,
  };
}
