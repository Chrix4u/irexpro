import { evaluateDemoBrokerCommissionEntryGate } from './demo-broker-commission-entry-gate';

const eligible = {
  enabled: true,
  selectedPrimary: true,
  preFeeNetExpectedR: 0.6,
  strategyRoute: 'TREND_CONTINUATION' as const,
  evidence: { sampleCount: 7, p90FeeR: 0.285 },
};

describe('same-DEMO-connection causal commission admission veto', () => {
  it('subtracts prior broker fee p90 in R and keeps sufficient primary expectancy eligible', () => {
    expect(evaluateDemoBrokerCommissionEntryGate(eligible)).toMatchObject({
      blocked: false,
      reason: 'AFTER_BROKER_FEES_ELIGIBLE',
      brokerFeeP90R: 0.285,
      afterFeeExpectedR: 0.315,
      minimumAfterFeeR: 0.08,
      grantsExecution: false,
      modifiesOpenPositions: false,
    });
  });
  it('blocks an otherwise positive spread-only expectancy below the fee-adjusted floor', () => {
    expect(
      evaluateDemoBrokerCommissionEntryGate({ ...eligible, preFeeNetExpectedR: 0.3 }),
    ).toMatchObject({
      blocked: true,
      reason: 'AFTER_BROKER_FEES_BELOW_FLOOR',
      afterFeeExpectedR: 0.015,
    });
  });
  it('uses a stronger floor for early transition and blocks borderline positive netR', () => {
    expect(
      evaluateDemoBrokerCommissionEntryGate({
        ...eligible,
        strategyRoute: 'EARLY_TRANSITION',
        preFeeNetExpectedR: 0.44,
      }),
    ).toMatchObject({ blocked: true, minimumAfterFeeR: 0.2 });
  });
  it('fails closed on too few same-account prior trades', () => {
    expect(
      evaluateDemoBrokerCommissionEntryGate({
        ...eligible,
        evidence: { sampleCount: 4, p90FeeR: 0.12 },
      }),
    ).toMatchObject({
      blocked: true,
      reason: 'INSUFFICIENT_SAME_ACCOUNT_PRIOR_FILLS',
      afterFeeExpectedR: null,
    });
  });
  it.each([null, NaN, -0.1, Infinity])(
    'never assumes a missing or invalid broker fee is zero (%s)',
    (v) => {
      expect(
        evaluateDemoBrokerCommissionEntryGate({
          ...eligible,
          evidence: { sampleCount: 8, p90FeeR: v },
        }),
      ).toMatchObject({ blocked: true, reason: 'INVALID_BROKER_FEE_EVIDENCE' });
    },
  );
  it('fails closed when broker fee lookup failed', () => {
    expect(
      evaluateDemoBrokerCommissionEntryGate({ ...eligible, lookupFailed: true }),
    ).toMatchObject({
      blocked: true,
      reason: 'FEE_LOOKUP_UNAVAILABLE',
    });
  });
  it('rejects invalid current expectancy without granting execution', () => {
    expect(
      evaluateDemoBrokerCommissionEntryGate({ ...eligible, preFeeNetExpectedR: null }),
    ).toMatchObject({
      blocked: true,
      reason: 'INVALID_PRE_FEE_EXPECTANCY',
      afterFeeExpectedR: null,
    });
  });
  it('does not veto legacy phases or independently authorize fallback lanes', () => {
    expect(evaluateDemoBrokerCommissionEntryGate({ ...eligible, enabled: false })).toMatchObject({
      blocked: false,
      reason: 'NOT_ENABLED',
      grantsExecution: false,
    });
    expect(
      evaluateDemoBrokerCommissionEntryGate({ ...eligible, selectedPrimary: false }),
    ).toMatchObject({
      blocked: false,
      reason: 'NOT_PRIMARY_PLAN_B',
      grantsExecution: false,
    });
  });
});
