import {
  evaluateConfirmedReversalCrossSleeveCanary,
  CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP,
  type ConfirmedReversalCrossSleeveCanaryInput,
} from './confirmed-reversal-cross-sleeve-canary';

const qualified: ConfirmedReversalCrossSleeveCanaryInput = {
  m1Route: 'M1_EARLY_TRANSITION',
  reliabilityGate: { lossStreakVeto: false, degradedEarlyTransitionVeto: true },
  strategyRoute: 'CONFIRMED_REVERSAL',
  primaryPlanBExecutable: true,
  portfolioSnapshotAvailable: true,
  brokerVerifiedPepperstoneDemo: true,
  paperExecutionEligible: true,
  executionCostUsable: true,
  eventRisk: 'CLEAR',
  driftState: 'NORMAL',
  netExpectedR: 0.12,
  candidateDirection: 'SELL',
  expertDirection: 'SELL',
  expertAllBrokerNative: true,
  expertFreshnessSeconds: 30,
  expertConfidence: 0.75,
  expertLongVotes: 0,
  expertShortVotes: 3,
};

describe('confirmed-reversal cross-sleeve DEMO recovery', () => {
  it('qualifies only a fully admitted reversal whose M1 early-transition sleeve is degraded', () => {
    expect(evaluateConfirmedReversalCrossSleeveCanary(qualified)).toBe(true);
    expect(CONFIRMED_REVERSAL_CROSS_SLEEVE_CANARY_LOT_CAP).toBe(0.2);
  });

  it.each([
    { m1Route: 'M1_TREND_CONTINUATION' as const },
    { reliabilityGate: { lossStreakVeto: true, degradedEarlyTransitionVeto: true } },
    { reliabilityGate: { lossStreakVeto: false, degradedEarlyTransitionVeto: false } },
    { reliabilityGate: null },
    { strategyRoute: 'EARLY_TRANSITION' },
    { strategyRoute: 'TREND_CONTINUATION' },
    { primaryPlanBExecutable: false },
    { portfolioSnapshotAvailable: false },
    { brokerVerifiedPepperstoneDemo: false },
    { paperExecutionEligible: false },
    { executionCostUsable: false },
    { eventRisk: 'UNVERIFIED' },
    { eventRisk: 'HIGH_IMPACT_BLOCK' },
    { driftState: 'OUT_OF_DISTRIBUTION' },
    { driftState: 'STRESSED' },
    { netExpectedR: 0 },
    { netExpectedR: -0.2 },
    { netExpectedR: Number.NaN },
    { expertDirection: 'BUY' as const },
    { expertAllBrokerNative: false },
    { expertFreshnessSeconds: null },
    { expertFreshnessSeconds: 121 },
    { expertFreshnessSeconds: -1 },
    { expertConfidence: 0.69 },
    { expertConfidence: null },
    { expertLongVotes: 1, expertShortVotes: 2 },
    { expertLongVotes: 3, expertShortVotes: 0 },
    { expertShortVotes: 2 },
    { expertShortVotes: null },
  ])('fails closed when a qualified requirement changes: %j', (delta) => {
    expect(evaluateConfirmedReversalCrossSleeveCanary({ ...qualified, ...delta })).toBe(false);
  });
});
