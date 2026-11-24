import { evaluateOwnerDemoPreDispatchConfluence as evaluate } from './owner-demo-predispatch-fee-confluence-shadow';
const input = {
  featureEnabled: true,
  exactOwner: true,
  exactPepperstoneDemoBrokerVerified: true,
  professionalDemoPhase: true,
  candidateAdmittedForDispatch: true,
  decisionTime: new Date('2026-11-20T18:55:00Z'),
  strategyRoute: 'CONFIRMED_REVERSAL',
  m1Route: 'ABSTAIN',
  trainedExpertState: 'ABSTAIN',
  feeShadowReason: 'AFTER_BROKER_FEES_BELOW_FLOOR',
  feeShadowSampleCount: 40,
  feeShadowAfterFeeExpectedR: 0.052116,
  feeShadowRequiredFloorR: 0.08,
  alignedH1: -0.55,
  alignedM5: -1,
  negativePayoff: true,
  recentPayoffClosedTrades: 8,
  recentClosedTrades: 8,
};
describe('owner verified Pepperstone DEMO pre-dispatch fee confirmation research', () => {
  it('persistable severe warning explicitly has zero entry/exit authority', () => {
    const x = evaluate(input);
    expect(x).toMatchObject({
      artifact: 'owner-demo-predispatch-fee-dual-abstain-research-v1',
      evaluationPhase: 'BEFORE_DURABLE_DECISION_AND_BEFORE_ORDER_DISPATCH',
      ownerDemoScopeVerified: true,
      selectedForDispatch: true,
      label: 'FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT',
      wouldDiscourageEntryIfEverValidated: true,
      brokerFeeShortfallVerified: true,
      m1TimingAbstained: true,
      trainedExpertAbstained: true,
      opposingHigherTimeframeEvidence: true,
      causalNegativePayoffHistory: true,
      noNewExecutionGate: true,
      noOrderBlock: true,
      noLotSizingChange: true,
      noBrokerOrders: true,
      noStopChange: true,
      noExitAuthority: true,
      noLivePromotion: true,
      noCalibratedSuccessProbability: true,
      noCounterfactualSavedMoney: true,
    });
    expect(x.decisionEvaluatedAt).toBe('2026-11-20T18:55:00.000Z');
  });
  it('separates fee+dual abstain cautions from added independently verified conflict', () => {
    const x = evaluate({
      ...input,
      alignedH1: 0.5,
      alignedM5: 0.3,
      negativePayoff: false,
      recentPayoffClosedTrades: 0,
      recentClosedTrades: 0,
    });
    expect(x.label).toBe('FEE_DEFICIT_DOUBLE_ABSTAIN_CAUTION');
    expect(x.wouldDiscourageEntryIfEverValidated).toBe(true);
    expect(x.opposingHigherTimeframeEvidence).toBe(false);
    expect(x.causalNegativePayoffHistory).toBe(false);
  });
  it('preserves genuinely better-supported reversal entry as not flagged', () => {
    for (const patch of [
      { m1Route: 'M1_CONFIRMED_REVERSAL' },
      { trainedExpertState: 'CONFIRM' },
      { feeShadowReason: 'AFTER_BROKER_FEES_ELIGIBLE' },
      { feeShadowAfterFeeExpectedR: 0.12 },
      { feeShadowSampleCount: 11 },
      { feeShadowSampleCount: null },
      { feeShadowRequiredFloorR: null },
      { feeShadowAfterFeeExpectedR: NaN },
    ]) {
      const x = evaluate({ ...input, ...patch });
      expect(x.label).toBe('NO_CONFLUENT_ENTRY_WARNING');
      expect(x.wouldDiscourageEntryIfEverValidated).toBe(false);
      expect(x.noOrderBlock).toBe(true);
    }
  });
  it('never flags any other route even with same historical poor economics', () => {
    for (const route of ['EARLY_TRANSITION', 'TREND_CONTINUATION', null]) {
      const x = evaluate({ ...input, strategyRoute: route });
      expect(x.label).toBe('OTHER_EXECUTABLE_ROUTE_CONTROL');
      expect(x.researchEligible).toBe(false);
      expect(x.wouldDiscourageEntryIfEverValidated).toBe(false);
    }
  });
  it('never judges a candidate that did not pass the established admission gates', () => {
    const x = evaluate({ ...input, candidateAdmittedForDispatch: false });
    expect(x.label).toBe('NOT_SELECTED_FOR_DISPATCH');
    expect(x.wouldDiscourageEntryIfEverValidated).toBe(false);
    expect(x.noNewExecutionGate).toBe(true);
  });
  it('cannot leak into other owners, accounts, LIVE or unverified connections', () => {
    for (const patch of [
      { featureEnabled: false },
      { exactOwner: false },
      { exactPepperstoneDemoBrokerVerified: false },
      { professionalDemoPhase: false },
    ]) {
      const x = evaluate({ ...input, ...patch });
      expect(x.ownerDemoScopeVerified).toBe(false);
      expect(x.label).toBe('NOT_OWNER_VERIFIED_USD_DEMO_RESEARCH');
      expect(x.wouldDiscourageEntryIfEverValidated).toBe(false);
      expect(x.noLivePromotion).toBe(true);
    }
  });
  it('recent loss evidence requires causal completed sample counts', () => {
    for (const patch of [
      { negativePayoff: false },
      { recentPayoffClosedTrades: 4 },
      { recentClosedTrades: 4 },
      { recentPayoffClosedTrades: null },
      { recentClosedTrades: null },
    ]) {
      const x = evaluate({ ...input, ...patch, alignedH1: 0.5, alignedM5: 0.5 });
      expect(x.causalNegativePayoffHistory).toBe(false);
      expect(x.label).toBe('FEE_DEFICIT_DOUBLE_ABSTAIN_CAUTION');
    }
  });
  it('an invalid decision clock refuses owner research scope and cannot block trades', () => {
    const x = evaluate({ ...input, decisionTime: new Date('invalid') });
    expect(x.label).toBe('NOT_OWNER_VERIFIED_USD_DEMO_RESEARCH');
    expect(x.decisionEvaluatedAt).toBeNull();
    expect(x.noOrderBlock).toBe(true);
  });
});
