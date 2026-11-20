import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  observePlanBReversalM1ContinuationMismatch as observe,
  PLANB_REVERSAL_M1_CONTINUATION_SHADOW_ARTIFACT,
  type PlanBReversalM1ContinuationShadowInput,
} from './planb-reversal-m1-continuation-shadow';

const base = (
  patch: Partial<PlanBReversalM1ContinuationShadowInput> = {},
): PlanBReversalM1ContinuationShadowInput => ({
  instrument: 'AUDUSD',
  direction: 'SELL',
  planBStrategyRoute: 'CONFIRMED_REVERSAL',
  planBPaperAdmitted: true,
  planBGovernanceEligible: true,
  planBNetExpectedR: 0.25,
  driftState: 'NORMAL',
  eventRisk: 'CLEAR',
  executionSpreadEvidenceValid: true,
  m1Route: 'M1_TREND_CONTINUATION',
  m1Direction: 'SELL',
  m1Reason: 'TREND_STRUCTURE_ALIGNED',
  m1ScoreEdge: 0.5,
  directionQuality: 0.75,
  alignedHigherTimeframeAgreement: 0.6,
  alignedM5Momentum1Atr: 0.25,
  alignedM5Momentum3Atr: 0.35,
  alignedM5BodyPressure3: 0.25,
  alignedM5LatestBodyPressure: 0.65,
  failedBreakoutWithDirection: false,
  trainedExpertOpposed: false,
  ...patch,
});

describe('prospective Plan B reversal versus M1 continuation research', () => {
  it('records one well-aligned completed M5 hypothesis with ZERO broker trade authority', () => {
    const x = observe(base());
    expect(x).toMatchObject({
      artifact: PLANB_REVERSAL_M1_CONTINUATION_SHADOW_ARTIFACT,
      mismatchObserved: true,
      eligibleForProspectiveStudy: true,
      reason: 'M1_CONFIRMED_M5_CONFIRMED_SHADOW_ONLY',
      shadowOnly: true,
      modifiesExecution: false,
      brokerOrderAuthority: 'NONE',
      automaticPromotionEligible: false,
    });
  });

  it.each(['TREND_CONTINUATION', 'EARLY_TRANSITION', null])(
    'never reclassifies unrelated Plan B route %s as a reversal',
    (planBStrategyRoute) => {
      expect(observe(base({ planBStrategyRoute }))).toMatchObject({
        mismatchObserved: false,
        eligibleForProspectiveStudy: false,
        reason: 'NOT_A_REVERSAL_CONTINUATION_MISMATCH',
      });
    },
  );

  it('requires matching explicit M1 direction and no strong opposing trained expert', () => {
    expect(observe(base({ m1Direction: 'BUY' })).reason).toBe('M1_DIRECTION_UNVERIFIED');
    expect(observe(base({ trainedExpertOpposed: true })).reason).toBe('M1_DIRECTION_UNVERIFIED');
    expect(observe(base({ m1Route: 'ABSTAIN' })).mismatchObserved).toBe(false);
  });

  it('does not infer eligibility when Plan B / governance has denied the signal', () => {
    expect(observe(base({ planBPaperAdmitted: false })).reason).toBe('PLAN_B_NOT_FULLY_ADMITTED');
    expect(observe(base({ planBGovernanceEligible: false })).reason).toBe('PLAN_B_NOT_FULLY_ADMITTED');
  });

  it.each([
    { eventRisk: 'HIGH_IMPACT' },
    { driftState: 'OUT_OF_DISTRIBUTION' },
    { executionSpreadEvidenceValid: false },
    { planBNetExpectedR: 0.02 },
    { planBNetExpectedR: null },
  ])('keeps broker risk / after-cost validity independently mandatory: %j', (patch) => {
    expect(observe(base(patch)).reason).toBe('BROKER_COST_OR_EVENT_OR_DRIFT_UNSAFE');
  });

  it.each([
    { m1Reason: 'NO_VALID_ROUTE' },
    { m1ScoreEdge: 0.1 },
    { directionQuality: 0.58 },
    { alignedHigherTimeframeAgreement: -0.4 },
    { failedBreakoutWithDirection: true },
  ])('does not label weak direction/HTF as a prospective continuation: %j', (patch) => {
    expect(observe(base(patch)).reason).toBe('M1_DIRECTION_OR_HTF_WEAK');
  });

  it.each([
    { alignedM5Momentum1Atr: -0.72 },
    { alignedM5Momentum3Atr: -0.04 },
    { alignedM5BodyPressure3: -0.02 },
    { alignedM5LatestBodyPressure: null },
    { alignedM5LatestBodyPressure: 0.12 },
  ])('requires completed M5 to actually confirm continuation: %j', (patch) => {
    expect(observe(base(patch)).reason).toBe('COMPLETED_M5_NOT_CONFIRMING');
  });

  it('accepts instrument scope only as telemetry, never authorizes even a new pair', () => {
    for (const instrument of ['AUDUSD', 'EURUSD', 'USDCAD', 'USDJPY']) {
      const result = observe(base({ instrument }));
      expect(result.instrument).toBe(instrument);
      expect(result.brokerOrderAuthority).toBe('NONE');
      expect(result.modifiesExecution).toBe(false);
      expect(result.automaticPromotionEligible).toBe(false);
    }
  });

  it('is integrated solely into persisted governance; not entry, sizing, or order dispatch', () => {
    const file = readFileSync(join(__dirname, 'm1-tactical-scheduler.service.ts'), 'utf8');
    expect(file).toContain('const planBReversalM1ContinuationShadow = multimodelDemo');
    expect(file).toContain('        planBReversalM1ContinuationShadow,');
    const executionDerivation = file.split('const canExecute =')[1].split('const effectiveGovernanceBlockers')[0];
    expect(executionDerivation).not.toContain('planBReversalM1ContinuationShadow');
    const preliminary = file.split('const preliminaryCanExecute =')[1].split('const canExecute =')[0];
    expect(preliminary).not.toContain('planBReversalM1ContinuationShadow.eligibleForProspectiveStudy');
  });
});
