import { evaluatePepperstoneDemoHighConvictionCeiling as evaluate } from './pepperstone-demo-high-conviction-lot-ceiling';
const strong = {
  enabled: true,
  ownerVerifiedPepperstoneUsdDemo: true,
  continuousAlternate: true,
  baseVolumeCap: 4,
  route: 'EARLY_TRANSITION',
  direction: 'BUY' as const,
  planBAdmitted: true,
  governanceEligible: true,
  planBScore: 0.84,
  planBDirectionQuality: 0.76,
  netExpectedR: 0.65,
  spreadEvidenceValid: true,
  eventRisk: 'CLEAR',
  driftState: 'IN_DISTRIBUTION',
  expertState: 'CONFIRM',
  expertDirection: 'BUY',
  expertAdmitted: true,
  expertNative: true,
  expertProbability: 0.81,
  expertFreshnessSeconds: 24,
  m1Route: 'M1_EARLY_TRANSITION',
  m1Confidence: 0.72,
  m1DirectionQuality: 0.66,
  m5Direction: 'WITH',
  h1Direction: 'NEUTRAL',
  qualityRiskFraction: 1,
  patternHypothesis: 'INSUFFICIENT_MATCHED_HISTORY',
  stopDistance: 0.0004,
  m1Atr14: 0.00009,
  brokerSpreadPrice: 0.00002,
  targetDistance: 0.0007,
  guardedPullback: false,
};
describe('owner Pepperstone DEMO 6-lot ceiling with independent prediction and real stops', () => {
  it('permits a 6-lot ceiling, NOT a 6-lot order, for exceptionally confirmed evidence', () => {
    const d = evaluate(strong);
    expect(d).toMatchObject({
      eligible: true,
      maxLotCeiling: 6,
      reason: 'ELIGIBLE',
      changesStopLoss: false,
      changesRiskAtStopLimit: false,
    });
  });
  it('never increases ceilings for other owners, brokers, LIVE or nonadvisory', () => {
    for (const v of [
      { enabled: false },
      { ownerVerifiedPepperstoneUsdDemo: false },
      { continuousAlternate: false },
      { route: 'TREND_CONTINUATION' },
      { baseVolumeCap: 0.2 },
      { baseVolumeCap: 5 },
    ]) {
      expect(evaluate({ ...strong, ...v }).eligible).toBe(false);
      expect(evaluate({ ...strong, ...v }).maxLotCeiling).toBe(v.baseVolumeCap ?? 4);
    }
  });
  it('never equates majority expert votes or ABSTAIN with confirmed prediction', () => {
    for (const v of [
      { expertState: 'ABSTAIN' },
      { expertDirection: 'SELL' },
      { expertProbability: 0.395 },
      { expertNative: false },
      { expertAdmitted: false },
      { expertFreshnessSeconds: 130 },
    ]) {
      expect(evaluate({ ...strong, ...v }).reason).toBe('INDEPENDENT_EXPERT_UNCONFIRMED');
    }
  });
  it('requires strong Plan-B after-cost evidence and true M1 directional agreement', () => {
    for (const v of [
      { planBScore: 0.68 },
      { planBDirectionQuality: 0.5 },
      { netExpectedR: 0.07 },
      { planBAdmitted: false },
      { governanceEligible: false },
    ]) {
      expect(evaluate({ ...strong, ...v }).reason).toBe('PLAN_B_QUALITY_UNPROVEN');
    }
    for (const v of [
      { m1Route: 'ABSTAIN' },
      { m5Direction: 'AGAINST' },
      { h1Direction: 'AGAINST' },
      { m1Confidence: 0.64 },
    ]) {
      expect(evaluate({ ...strong, ...v }).reason).toBe('M1_OR_DIRECTION_NOT_CONFIRMED');
    }
  });
  it('refuses to enable a bigger size by using a stop tight to ATR or spread', () => {
    for (const v of [
      { stopDistance: 0.00012 },
      { brokerSpreadPrice: 0.00016 },
      { m1Atr14: 0.0004 },
      { targetDistance: 0.00045 },
      { stopDistance: 0 },
    ]) {
      expect(evaluate({ ...strong, ...v }).reason).toBe('SHORT_STOP_OR_INADEQUATE_TARGET');
    }
  });
  it('retains 4 lots if the quality multiplier is below one or memory detects false reversal', () => {
    for (const v of [
      { qualityRiskFraction: 0.5 },
      { patternHypothesis: 'POSSIBLE_FALSE_REVERSAL' },
      { eventRisk: 'DANGEROUS' },
      { driftState: 'OUT_OF_DISTRIBUTION' },
      { guardedPullback: true },
      { spreadEvidenceValid: false },
    ]) {
      expect(evaluate({ ...strong, ...v }).eligible).toBe(false);
    }
  });
});
