import {
  evaluateOwnerDemoWeakReversalCap as evaluate,
  OWNER_DEMO_STANDARD_EXPOSURE_CEILING_LOTS as STANDARD,
} from './owner-demo-weak-reversal-exposure-ceiling';

const base = {
  enabled: true,
  exactOwnerVerified: true,
  ongoingSevenLotEligible: true,
  continuousDemoAlternate: true,
  route: 'CONFIRMED_REVERSAL',
  requestedLotCap: 7,
  independentQualityRiskFraction: 0.4875,
  feeShadowReason: 'AFTER_BROKER_FEES_BELOW_FLOOR',
  feeShadowPriorSamples: 40,
  modelLossStreakActive: false,
  modelLossStreakReason: 'CLEAR',
};

describe('exact owner DEMO weak seven-lot reversal exposure ceiling', () => {
  it('reduces a 7-lot owner demo SELL with verified fee deficit and weak quality to standard 4-lot maximum', () => {
    const result = evaluate(base);
    expect(result).toMatchObject({
      applied: true, originalRequestedLots: 7, requestedLotCap: 4,
      feeWarningAccepted: true, lossWarningAccepted: false,
      reason: 'WEAK_CONFIRMATION_PLUS_INDEPENDENT_COST_OR_LOSS_WARNING',
      blocksTrade: false, changesDirection: false, altersBrokerStops: false,
      increasesLot: false, liveAccountEligible: false,
    });
    expect(STANDARD).toBe(4);
  });

  it('reduces a 4.9-lot weak BUY with complete negative recent strategy history even if fee passes', () => {
    const result = evaluate({...base, requestedLotCap: 4.9,
      independentQualityRiskFraction: 0.2975,
      feeShadowReason: 'AFTER_BROKER_FEES_ELIGIBLE',
      modelLossStreakActive: true, modelLossStreakReason: 'RECENT_NEGATIVE_PAYOFF'});
    expect(result.applied).toBe(true);
    expect(result.requestedLotCap).toBe(4);
    expect(result.lossWarningAccepted).toBe(true);
    expect(result.feeWarningAccepted).toBe(false);
  });

  it('does not block any entry and preserves capable 7-lot reversal for positive signal evidence', () => {
    for (const change of [
      {independentQualityRiskFraction: .51},
      {independentQualityRiskFraction: 1},
      {feeShadowReason: 'AFTER_BROKER_FEES_ELIGIBLE'},
      {feeShadowReason: 'NOT_PRIMARY_PLAN_B'},
      {feeShadowPriorSamples: 0},
      {feeShadowPriorSamples: 11},
      {feeShadowPriorSamples: null},
      {independentQualityRiskFraction: null},
      {independentQualityRiskFraction: Number.NaN},
    ]) {
      const result = evaluate({...base, ...change});
      expect(result.applied).toBe(false);
      expect(result.requestedLotCap).toBe(7);
      expect(result.blocksTrade).toBe(false);
    }
  });

  it('requires a verified exact owner, demo seven-lot entitlement and continuous alternate', () => {
    for (const change of [
      {enabled: false},
      {exactOwnerVerified: false},
      {ongoingSevenLotEligible: false},
      {continuousDemoAlternate: false},
      {route: 'EARLY_TRANSITION'},
      {route: 'TREND_CONTINUATION'},
      {route: null},
    ]) {
      const result = evaluate({...base,...change});
      expect(result.applied).toBe(false);
      expect(result.requestedLotCap).toBe(7);
      expect(result.liveAccountEligible).toBe(false);
    }
  });

  it('never increases or forces a minimum lot, and leaves preexisting risk caps alone', () => {
    for (const original of [.01, .2, .75, 1, 2, 3, 4]) {
      const result = evaluate({...base,requestedLotCap: original});
      expect(result.applied).toBe(false);
      expect(result.requestedLotCap).toBe(original);
      expect(result.increasesLot).toBe(false);
    }
    expect(evaluate({...base,requestedLotCap:4.01}).requestedLotCap).toBe(4);
  });

  it('does not accept missing or mismatched historical loss-streak evidence as confirmation', () => {
    for (const patch of [
      {modelLossStreakReason:'RECENT_NEGATIVE_PAYOFF', modelLossStreakActive:false},
      {modelLossStreakReason:'EVIDENCE_UNAVAILABLE',modelLossStreakActive:true},
      {modelLossStreakReason:'CLEAR',modelLossStreakActive:true},
    ]) {
      const result=evaluate({...base,feeShadowReason:'AFTER_BROKER_FEES_ELIGIBLE',...patch});
      expect(result.applied).toBe(false);
    }
  });

  it('supports a recent-loss-only moderate exposure cap even without fee deficit', () => {
    const result=evaluate({...base,feeShadowReason:'AFTER_BROKER_FEES_ELIGIBLE',
      modelLossStreakActive:true,modelLossStreakReason:'RECENT_NEGATIVE_PAYOFF',
      independentQualityRiskFraction:.5});
    expect(result.requestedLotCap).toBe(4);
    expect(result.blocksTrade).toBe(false);
  });

  it('fails without increasing or mistaking invalid numeric lot caps for a signal', () => {
    for (const cap of [Number.NaN, Infinity, -1, 0]) {
      const result=evaluate({...base,requestedLotCap:cap});
      expect(result.applied).toBe(false);
      expect(result.requestedLotCap).toBe(cap);
    }
  });
});
