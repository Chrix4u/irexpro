import {
  evaluateMultimodelDemoAuthority,
  multimodelDemoExecutionVolumeCap,
  multimodelDemoSignalConfidence,
  m1CandidateToPlanBInput,
} from './multimodel-demo-authority';
import type { M1TacticalCandidate } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';

const ensemble = (paperAdmitted = true) => ({
  paperAdmitted,
  ensembleScore: 0.72,
  strategyRoute: 'TREND_CONTINUATION' as const,
});

const governance = (paperExecutionEligible = true, overrides: Record<string, unknown> = {}) => ({
  paperExecutionEligible,
  paperExecutionBlockers: paperExecutionEligible ? [] : ['DRIFT_OUT_OF_DISTRIBUTION'],
  netExpectedR: paperExecutionEligible ? 0.22 : -0.1,
  paperNetExpectedRPassed: paperExecutionEligible,
  paperExecutionCostUsable: true,
  eventRisk: 'CLEAR' as const,
  sleeveState: 'COLLECTING' as const,
  driftState: paperExecutionEligible ? ('NORMAL' as const) : ('OUT_OF_DISTRIBUTION' as const),
  ...overrides,
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
  it('authorizes qualified DEMO trend continuation when the M1 timing route confirms continuation', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(true),
      governance: governance(true),
      trainedExpert: overlay('CONFIRM'),
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result).toEqual(
      expect.objectContaining({
        executable: true,
        primaryEngineCode: 'irexpro-multimodel-ensemble-v1',
        trainedExpertConfirmed: true,
        m1TimingRoute: 'M1_TREND_CONTINUATION',
        blockers: [],
      }),
    );
  });

  it.each(['ABSTAIN', 'STALE', 'UNAVAILABLE'] as const)(
    'keeps trained expert state %s observational when the promoted PAPER champion qualifies',
    (state) => {
      const result = evaluateMultimodelDemoAuthority({
        ensemble: ensemble(true),
        governance: governance(true),
        trainedExpert: overlay(state),
        candidateDirection: 'BUY',
        m1TimingRoute: 'M1_TREND_CONTINUATION',
      });

      expect(result.executable).toBe(true);
      expect(result.blockers).toEqual([]);
      expect(result.trainedExpertConfirmed).toBe(false);
    },
  );

  it('keeps an admitted primary Plan-B entry executable but caps it at 0.20 lot when three broker-native experts unanimously oppose it', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(true),
      governance: governance(true),
      trainedExpert: {
        ...overlay('ABSTAIN'),
        direction: 'SELL',
        longVotes: 0,
        shortVotes: 3,
        ensembleConfidence: 0.709,
      },
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(true);
    expect(result.authorityPath).toBe('PRIMARY_PLAN_B');
    expect(result.blockers).toEqual([]);
    expect(result.trainedExpertOpposed).toBe(true);
    expect(result.expertConflictVolumeCap).toBe(0.2);
    expect(multimodelDemoExecutionVolumeCap(4, result)).toBe(0.2);
  });

  it('blocks when Plan-B does not admit the candidate and high-conviction rescue is unavailable', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(false),
      governance: governance(true),
      trainedExpert: { ...overlay('CONFIRM'), longVotes: 2, shortVotes: 1 },
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain('MULTIMODEL_PLAN_B_NOT_ADMITTED');
  });

  it('keeps predicted P&L and historical costs observational when three fresh models agree on a qualified DEMO setup', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: {
        ...ensemble(false),
        regimeAllowed: true,
        reasons: ['META_EXPECTED_VALUE', 'EXPECTED_R'],
        directionQuality: 0.76,
        tradeQuality: 0.64,
        exitQuality: 0.61,
        sessionQuality: 0.9,
        portfolioQuality: 0.87,
      },
      governance: governance(false, {
        paperExecutionBlockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
          'PAPER_NET_EXPECTED_R',
        ],
        netExpectedR: -0.11,
        driftState: 'NORMAL',
        executionSpreadEvidenceValid: true,
      }),
      trainedExpert: { ...overlay('ABSTAIN'), admitted: false },
      candidateDirection: 'BUY',
      candidateConfidence: 0.71,
      m1TimingRoute: 'M1_TREND_CONTINUATION',
      forecastEconomicsShadowOnlyDemo: true,
    });
    expect(result).toMatchObject({
      executable: true,
      authorityPath: 'FORECAST_SHADOW_CONSENSUS',
      rescueVolumeCap: 0.2,
      blockers: [],
      forecastEconomicsShadow: {
        activated: true,
        historicalForecastsRemainObservable: true,
        originalPlanBReasons: ['META_EXPECTED_VALUE', 'EXPECTED_R'],
      },
    });
    expect(multimodelDemoExecutionVolumeCap(4, result)).toBe(0.2);
  });

  it('keeps an otherwise identical predicted-forecast veto when the DEMO shadow option is not selected', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: {
        ...ensemble(false),
        regimeAllowed: true,
        reasons: ['EXPECTED_R'],
        directionQuality: 0.75,
        tradeQuality: 0.65,
        exitQuality: 0.6,
        sessionQuality: 0.9,
        portfolioQuality: 0.8,
      },
      governance: governance(false, {
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'PAPER_NET_EXPECTED_R'],
        driftState: 'NORMAL',
        executionSpreadEvidenceValid: true,
      }),
      trainedExpert: overlay('CONFIRM'),
      candidateDirection: 'BUY',
      candidateConfidence: 0.7,
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });
    expect(result.authorityPath).toBe('BLOCKED');
  });

  it.each([
    {
      reason: 'model drift',
      governanceBlockers: [
        'ENSEMBLE_NOT_PAPER_ADMITTED',
        'PAPER_NET_EXPECTED_R',
        'DRIFT_OUT_OF_DISTRIBUTION',
      ],
      governanceState: { driftState: 'OUT_OF_DISTRIBUTION' },
      planBReasons: ['EXPECTED_R'],
      expert: {},
      timing: 'M1_TREND_CONTINUATION' as const,
    },
    {
      reason: 'high-impact economic news',
      governanceBlockers: [
        'ENSEMBLE_NOT_PAPER_ADMITTED',
        'PAPER_NET_EXPECTED_R',
        'EVENT_RISK_HIGH_IMPACT_BLOCK',
      ],
      governanceState: { eventRisk: 'HIGH_IMPACT_BLOCK' },
      planBReasons: ['EXPECTED_R'],
      expert: {},
      timing: 'M1_TREND_CONTINUATION' as const,
    },
    {
      reason: 'missing broker spread evidence',
      governanceBlockers: [
        'ENSEMBLE_NOT_PAPER_ADMITTED',
        'PAPER_NET_EXPECTED_R',
        'EXECUTION_SPREAD_UNAVAILABLE',
      ],
      governanceState: { executionSpreadEvidenceValid: false },
      planBReasons: ['EXPECTED_R'],
      expert: {},
      timing: 'M1_TREND_CONTINUATION' as const,
    },
    {
      reason: 'extended trend regime',
      governanceBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'PAPER_NET_EXPECTED_R'],
      governanceState: {},
      planBReasons: ['REGIME_TREND_EXTENDED', 'EXPECTED_R'],
      expert: {},
      timing: 'M1_TREND_CONTINUATION' as const,
    },
    {
      reason: 'disagreeing trained experts',
      governanceBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'PAPER_NET_EXPECTED_R'],
      governanceState: {},
      planBReasons: ['EXPECTED_R'],
      expert: { longVotes: 2, shortVotes: 1 },
      timing: 'M1_TREND_CONTINUATION' as const,
    },
    {
      reason: 'unconfirmed M1 entry timing',
      governanceBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'PAPER_NET_EXPECTED_R'],
      governanceState: {},
      planBReasons: ['EXPECTED_R'],
      expert: {},
      timing: 'ABSTAIN' as const,
    },
  ])(
    'keeps %s as an immutable veto instead of treating it as a forecast',
    ({ governanceBlockers, governanceState, planBReasons, expert, timing }) => {
      const result = evaluateMultimodelDemoAuthority({
        ensemble: {
          ...ensemble(false),
          regimeAllowed: !planBReasons.includes('REGIME_TREND_EXTENDED'),
          reasons: planBReasons,
          directionQuality: 0.7,
          tradeQuality: 0.63,
          exitQuality: 0.6,
          sessionQuality: 0.9,
          portfolioQuality: 0.82,
        },
        governance: governance(false, {
          paperExecutionBlockers: governanceBlockers,
          driftState: 'NORMAL',
          executionSpreadEvidenceValid: true,
          ...governanceState,
        }),
        trainedExpert: { ...overlay('CONFIRM'), ...expert },
        candidateDirection: 'BUY',
        candidateConfidence: 0.73,
        m1TimingRoute: timing,
        forecastEconomicsShadowOnlyDemo: true,
      });
      expect(result.executable).toBe(false);
      expect(result.authorityPath).toBe('BLOCKED');
      expect(result.forecastEconomicsShadow.activated).toBe(false);
    },
  );

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

  it('records a trained-model direction mismatch without overriding the promoted PAPER champion', () => {
    const trainedExpert = { ...overlay('CONFIRM'), direction: 'SELL' as const };
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(true),
      governance: governance(true),
      trainedExpert,
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(true);
    expect(result.trainedExpertConfirmed).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it('blocks a primary EARLY_TRANSITION setup when the M1 timing specialist abstains', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: { ...ensemble(true), strategyRoute: 'EARLY_TRANSITION' as const },
      governance: governance(true),
      trainedExpert: overlay('CONFIRM'),
      candidateDirection: 'SELL',
      m1TimingRoute: 'ABSTAIN',
    });

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.blockers).toContain('MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED');
  });

  it('keeps a primary EARLY_TRANSITION setup executable when M1 timing confirms the transition', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: { ...ensemble(true), strategyRoute: 'EARLY_TRANSITION' as const },
      governance: governance(true),
      trainedExpert: overlay('CONFIRM'),
      candidateDirection: 'SELL',
      m1TimingRoute: 'M1_EARLY_TRANSITION',
    });

    expect(result.executable).toBe(true);
    expect(result.authorityPath).toBe('PRIMARY_PLAN_B');
    expect(result.blockers).toEqual([]);
  });

  it('rescues only an EARLY_TRANSITION DEMO setup when trained experts unanimously match direction and only admission/drift block it', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: { ...ensemble(false), strategyRoute: 'EARLY_TRANSITION' as const },
      governance: governance(false, {
        paperExecutionBlockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
          'DRIFT_OUT_OF_DISTRIBUTION',
        ],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
        driftState: 'OUT_OF_DISTRIBUTION',
      }),
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.714 },
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_EARLY_TRANSITION',
    });

    expect(result).toEqual(
      expect.objectContaining({
        executable: true,
        authorityPath: 'HIGH_CONVICTION_RESCUE',
        rescueVolumeCap: 0.2,
        blockers: [],
      }),
    );
  });

  it('uses trained-expert confidence for high-conviction rescue while primary Plan-B keeps its ensemble score', () => {
    const rescueInput = {
      ensemble: {
        ...ensemble(false),
        ensembleScore: 0.579,
        strategyRoute: 'EARLY_TRANSITION' as const,
      },
      governance: governance(false, {
        paperExecutionBlockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
          'DRIFT_OUT_OF_DISTRIBUTION',
        ],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
      }),
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.738 },
      candidateDirection: 'BUY' as const,
      m1TimingRoute: 'M1_EARLY_TRANSITION' as const,
    };
    const rescued = evaluateMultimodelDemoAuthority(rescueInput);
    expect(rescued.authorityPath).toBe('HIGH_CONVICTION_RESCUE');
    expect(multimodelDemoSignalConfidence(rescueInput, rescued)).toBeCloseTo(0.738, 10);

    const primaryInput = {
      ensemble: { ...ensemble(true), ensembleScore: 0.641 },
      governance: governance(true),
      trainedExpert: { ...overlay('CONFIRM'), ensembleConfidence: 0.82 },
      candidateDirection: 'BUY' as const,
      m1TimingRoute: 'M1_TREND_CONTINUATION' as const,
    };
    const primary = evaluateMultimodelDemoAuthority(primaryInput);
    expect(primary.authorityPath).toBe('PRIMARY_PLAN_B');
    expect(multimodelDemoSignalConfidence(primaryInput, primary)).toBeCloseTo(0.641, 10);
  });

  it('does not rescue TREND_CONTINUATION even with unanimous broker-native trained experts', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(false),
      governance: governance(false, {
        paperExecutionBlockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
          'DRIFT_OUT_OF_DISTRIBUTION',
        ],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
      }),
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.78 },
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
    expect(result.rescueVolumeCap).toBeNull();
  });

  it('does not rescue when the M1 timing specialist abstains', () => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(false),
      governance: governance(false, {
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION'],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
      }),
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.78 },
      candidateDirection: 'BUY',
      m1TimingRoute: 'ABSTAIN',
    });

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
  });

  it.each([
    {
      name: '2/3 votes',
      trainedExpert: {
        ...overlay('ABSTAIN'),
        longVotes: 2,
        shortVotes: 1,
        ensembleConfidence: 0.78,
      },
      governance: governance(false, {
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION'],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
      }),
    },
    {
      name: 'opposite unanimous direction',
      trainedExpert: {
        ...overlay('ABSTAIN'),
        direction: 'SELL' as const,
        longVotes: 0,
        shortVotes: 3,
        ensembleConfidence: 0.78,
      },
      governance: governance(false, {
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION'],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
      }),
    },
    {
      name: 'confidence below rescue floor',
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.699 },
      governance: governance(false, {
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION'],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
      }),
    },
    {
      name: 'weak expected R',
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.78 },
      governance: governance(false, {
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION'],
        netExpectedR: 0.19,
        paperNetExpectedRPassed: true,
      }),
    },
    {
      name: 'high event risk',
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.78 },
      governance: governance(false, {
        paperExecutionBlockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'DRIFT_OUT_OF_DISTRIBUTION',
          'EVENT_RISK_HIGH_IMPACT_BLOCK',
        ],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
        eventRisk: 'HIGH_IMPACT_BLOCK',
      }),
    },
    {
      name: 'unusable execution cost',
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.78 },
      governance: governance(false, {
        paperExecutionBlockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'DRIFT_OUT_OF_DISTRIBUTION',
          'EXECUTION_SPREAD_UNAVAILABLE',
        ],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
        paperExecutionCostUsable: false,
      }),
    },
    {
      name: 'blocked sleeve',
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.78 },
      governance: governance(false, {
        paperExecutionBlockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'DRIFT_OUT_OF_DISTRIBUTION',
          'SLEEVE_BLOCKED',
        ],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
        sleeveState: 'BLOCKED',
      }),
    },
  ])('does not rescue $name', ({ trainedExpert, governance: blockedGovernance }) => {
    const result = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(false),
      governance: blockedGovernance,
      trainedExpert,
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(result.executable).toBe(false);
    expect(result.authorityPath).toBe('BLOCKED');
  });
});

describe('multimodelDemoExecutionVolumeCap', () => {
  it('caps a high-conviction rescue at 0.20 lot while leaving the primary path at the rollout cap', () => {
    const rescued = evaluateMultimodelDemoAuthority({
      ensemble: { ...ensemble(false), strategyRoute: 'EARLY_TRANSITION' as const },
      governance: governance(false, {
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION'],
        netExpectedR: 0.52,
        paperNetExpectedRPassed: true,
      }),
      trainedExpert: { ...overlay('ABSTAIN'), ensembleConfidence: 0.78 },
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_EARLY_TRANSITION',
    });
    const primary = evaluateMultimodelDemoAuthority({
      ensemble: ensemble(true),
      governance: governance(true),
      trainedExpert: overlay('CONFIRM'),
      candidateDirection: 'BUY',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });

    expect(multimodelDemoExecutionVolumeCap(4, rescued)).toBe(0.2);
    expect(multimodelDemoExecutionVolumeCap(4, primary)).toBe(4);
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
