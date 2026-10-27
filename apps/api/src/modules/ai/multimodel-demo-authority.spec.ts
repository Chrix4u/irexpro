import {
  evaluateMultimodelDemoAuthority,
  m1CandidateToPlanBInput,
} from './multimodel-demo-authority';
import type { M1TacticalCandidate } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';

const ensemble = (paperAdmitted = true) => ({
  paperAdmitted,
  ensembleScore: 0.72,
  strategyRoute: 'TREND_CONTINUATION' as const,
});

const governance = (paperExecutionEligible = true) => ({
  paperExecutionEligible,
  paperExecutionBlockers: paperExecutionEligible ? [] : ['DRIFT_OUT_OF_DISTRIBUTION'],
  netExpectedR: paperExecutionEligible ? 0.22 : -0.1,
});

const overlay = (
  state: 'CONFIRM' | 'CONFLICT' | 'ABSTAIN' | 'STALE' | 'UNAVAILABLE' = 'CONFIRM',
) => ({
  state,
  reason: state === 'UNAVAILABLE' ? 'BROKER_MARKET_DATA_UNAVAILABLE' : null,
  decisionTime: '2026-10-27T20:30:00.000Z',
  freshnessSeconds: 0,
  allBrokerNative: state !== 'STALE',
  direction: state === 'CONFLICT' ? ('SELL' as const) : ('BUY' as const),
  admitted: state === 'CONFIRM' || state === 'CONFLICT',
  ensembleConfidence: 0.74,
  meanOpportunityProbability: 0.63,
  longVotes: state === 'CONFLICT' ? 0 : 3,
  shortVotes: state === 'CONFLICT' ? 3 : 0,
  regime: 'calm',
  modifiesExecution: false as const,
});

describe('evaluateMultimodelDemoAuthority', () => {
  it.each(['M1_TREND_CONTINUATION', 'M1_CONFIRMED_REVERSAL', 'M1_EARLY_TRANSITION'] as const)(
    'authorizes qualified DEMO consensus when the M1 timing route is %s',
    (timingRoute) => {
      const result = evaluateMultimodelDemoAuthority({
        ensemble: ensemble(true),
        governance: governance(true),
        trainedExpert: overlay('CONFIRM'),
        candidateDirection: 'BUY',
        m1TimingRoute: timingRoute,
      });

      expect(result).toEqual(
        expect.objectContaining({
          executable: true,
          primaryEngineCode: 'irexpro-multimodel-ensemble-v1',
          trainedExpertConfirmed: true,
          m1TimingRoute: timingRoute,
          blockers: [],
        }),
      );
    },
  );

  it.each([
    ['CONFLICT', 'MULTIMODEL_TRAINED_EXPERT_CONFLICT'],
    ['ABSTAIN', 'MULTIMODEL_TRAINED_EXPERT_ABSTAIN'],
    ['STALE', 'MULTIMODEL_TRAINED_EXPERT_STALE'],
    ['UNAVAILABLE', 'MULTIMODEL_TRAINED_EXPERT_UNAVAILABLE'],
  ] as const)('fails closed when trained expert state is %s', (state, blocker) => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(true),
      governance: governance(true),
      trainedExpert: overlay(state),
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(false);
    expect(result.blockers).toContain(blocker);
  });

  it('blocks when Plan-B does not admit the candidate', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(false),
      governance: governance(true),
      trainedExpert: overlay('CONFIRM'),
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(false);
    expect(result.blockers).toContain('MULTIMODEL_PLAN_B_NOT_ADMITTED');
  });

  it('blocks when generic governance rejects the candidate', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(true),
      governance: governance(false),
      trainedExpert: overlay('CONFIRM'),
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(false);
    expect(result.blockers).toContain('MULTIMODEL_GOVERNANCE_BLOCKED');
    expect(result.blockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
  });

  it('blocks a trained-model direction mismatch even if its state is malformed as CONFIRM', () => {
    const trainedExpert = { ...overlay('CONFIRM'), direction: 'SELL' as const };
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(true),
      governance: governance(true),
      trainedExpert,
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_CONFIRMED_REVERSAL',
    });

    expect(result.executable).toBe(false);
    expect(result.blockers).toContain('MULTIMODEL_TRAINED_EXPERT_DIRECTION_MISMATCH');
  });
});

describe('m1CandidateToPlanBInput', () => {
  it('converts broker-native M1 timing features into the existing Plan-B feature semantics', () => {
    const candidate = {
      instrument: 'USDJPY',
      direction: 'SELL',
      confidence: 0.71,
      alignedEmaSeparationAtr: 0.8,
      alignedM15: 0.45,
    } as M1TacticalCandidate;
    const features = {
      extensionAtr: 0.7,
      volatilityScore: 0.24,
      rsi14: 43,
      momentum1Atr: -0.31,
    } as M1TacticalFeatureSnapshot;
    const scanTime = new Date('2026-10-27T20:30:00.000Z');

    expect(m1CandidateToPlanBInput(candidate, features, scanTime)).toEqual({
      instrument: 'USDJPY',
      direction: 'SELL',
      confidence: 0.71,
      extensionAtr: 0.7,
      volatilityScore: 0.24,
      emaSeparation: 0.4,
      mtfStrength: 0.45,
      rsi14: 43,
      shortHorizonMomentumAtr: -0.31,
      scanTime,
    });
  });
});
