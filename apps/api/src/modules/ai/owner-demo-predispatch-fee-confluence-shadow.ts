/**
 * Causal owner USD DEMO research-only pre-dispatch warning.
 *
 * Called BEFORE recordDecision(), which itself is durably saved BEFORE any
 * submitPaperDecision() call. No broker access or execution authority.
 * The observation is not predictive proof until future broker settlements
 * have been measured, including profitable warnings (false positives).
 */
export const OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_ARTIFACT =
  'owner-demo-predispatch-fee-dual-abstain-research-v1' as const;

export type OwnerDemoPreDispatchConfluenceInput = {
  featureEnabled: boolean;
  exactOwner: boolean;
  exactPepperstoneDemoBrokerVerified: boolean;
  professionalDemoPhase: boolean;
  candidateAdmittedForDispatch: boolean;
  decisionTime: Date;
  strategyRoute: string | null;
  m1Route: string;
  trainedExpertState: string | null;
  feeShadowReason: string | null;
  feeShadowSampleCount: number | null;
  feeShadowAfterFeeExpectedR: number | null;
  feeShadowRequiredFloorR: number | null;
  alignedH1: number | null;
  alignedM5: number | null;
  negativePayoff: boolean;
  recentPayoffClosedTrades: number | null;
  recentClosedTrades: number | null;
};

const finite = (x: number | null): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null;

export function evaluateOwnerDemoPreDispatchConfluence(input: OwnerDemoPreDispatchConfluenceInput) {
  const scope =
    input.featureEnabled &&
    input.exactOwner &&
    input.exactPepperstoneDemoBrokerVerified &&
    input.professionalDemoPhase &&
    Number.isFinite(input.decisionTime.getTime());
  const route = input.strategyRoute;
  const feeN = input.feeShadowSampleCount;
  const feeExpected = finite(input.feeShadowAfterFeeExpectedR);
  const requiredFloor = finite(input.feeShadowRequiredFloorR);
  const credibleFeeShortfall =
    input.feeShadowReason === 'AFTER_BROKER_FEES_BELOW_FLOOR' &&
    Number.isInteger(feeN) &&
    feeN! >= 12 &&
    feeExpected !== null &&
    requiredFloor !== null &&
    requiredFloor > 0 &&
    feeExpected < requiredFloor;
  const bothAbstained = input.m1Route === 'ABSTAIN' && input.trainedExpertState === 'ABSTAIN';
  const h1 = finite(input.alignedH1);
  const m5 = finite(input.alignedM5);
  const independentTimeframeConflict = (h1 !== null && h1 <= -0.35) || (m5 !== null && m5 <= -0.2);
  const independentRecentLoss =
    input.negativePayoff &&
    Number.isInteger(input.recentPayoffClosedTrades) &&
    input.recentPayoffClosedTrades! >= 5 &&
    Number.isInteger(input.recentClosedTrades) &&
    input.recentClosedTrades! >= 5;

  const eligibleForResearch =
    scope && input.candidateAdmittedForDispatch && route === 'CONFIRMED_REVERSAL';
  const warning = eligibleForResearch && credibleFeeShortfall && bothAbstained;
  const label = !scope
    ? 'NOT_OWNER_VERIFIED_USD_DEMO_RESEARCH'
    : !input.candidateAdmittedForDispatch
      ? 'NOT_SELECTED_FOR_DISPATCH'
      : route !== 'CONFIRMED_REVERSAL'
        ? 'OTHER_EXECUTABLE_ROUTE_CONTROL'
        : warning
          ? independentTimeframeConflict || independentRecentLoss
            ? 'FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT'
            : 'FEE_DEFICIT_DOUBLE_ABSTAIN_CAUTION'
          : 'NO_CONFLUENT_ENTRY_WARNING';
  return {
    artifact: OWNER_DEMO_PREDISPATCH_FEE_CONFLUENCE_ARTIFACT,
    researchOnly: true as const,
    evaluationPhase: 'BEFORE_DURABLE_DECISION_AND_BEFORE_ORDER_DISPATCH' as const,
    decisionEvaluatedAt: Number.isFinite(input.decisionTime.getTime())
      ? input.decisionTime.toISOString()
      : null,
    ownerDemoScopeVerified: scope,
    selectedForDispatch: input.candidateAdmittedForDispatch,
    strategyRoute: route,
    label,
    researchEligible: eligibleForResearch,
    wouldDiscourageEntryIfEverValidated: warning,
    brokerFeeShortfallVerified: eligibleForResearch && credibleFeeShortfall,
    m1TimingAbstained: eligibleForResearch && input.m1Route === 'ABSTAIN',
    trainedExpertAbstained: eligibleForResearch && input.trainedExpertState === 'ABSTAIN',
    feePriorClosedTrades: scope ? feeN : null,
    feeShadowExpectedR: scope ? feeExpected : null,
    feeRequiredFloorR: scope ? requiredFloor : null,
    opposingHigherTimeframeEvidence: eligibleForResearch && independentTimeframeConflict,
    causalNegativePayoffHistory: eligibleForResearch && independentRecentLoss,
    noNewExecutionGate: true as const,
    noOrderBlock: true as const,
    noLotSizingChange: true as const,
    noBrokerOrders: true as const,
    noStopChange: true as const,
    noExitAuthority: true as const,
    noLivePromotion: true as const,
    noCalibratedSuccessProbability: true as const,
    noCounterfactualSavedMoney: true as const,
  };
}
