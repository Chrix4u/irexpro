import { evaluateEnsembleGovernance } from './ensemble-governance';
import { PlanBEnsembleScore } from './plan-b-multimodel-shadow';

const ensemble: PlanBEnsembleScore = {
  artifact: 'plan-b-multimodel-shadow-v4',
  mode: 'PROSPECTIVE_SHADOW_ONLY',
  modifiesExecution: false,
  regime: 'TREND_HEALTHY',
  regimeAllowed: true,
  strategyRoute: 'TREND_CONTINUATION',
  directionQuality: 0.8,
  expectedR: 0.32,
  tradeQuality: 0.7,
  exitQuality: 0.7,
  pairSideQuality: 0.5,
  pairSideRoute: 'GOVERNANCE',
  sessionQuality: 0.9,
  consensusPassed: 7,
  consensusRequired: 6,
  portfolioQuality: 0.9,
  portfolioRiskScore: 0.1,
  openPositionCount: 0,
  sameInstrumentCount: 0,
  sameInstrumentDirectionalLots: 0,
  metaProbability: 0.6,
  ensembleScore: 0.7,
  paperAdmitted: true,
  admitted: true,
  reasons: ['ADMIT'],
};

const evaluatedAt = new Date('2026-10-07T12:00:00.000Z');
const base = {
  ensemble,
  evaluatedAt,
  executionSpreadEvidence: {
    source: 'BROKER_OBSERVED_P90' as const,
    spreadPrice: 0.0001,
    sampleCount: 40,
    percentile: 0.9,
    windowMinutes: 30,
    latestSampleAt: '2026-10-07T11:59:00.000Z',
  },
  instrument: 'EURUSD',
  entryPrice: 1.1,
  stopLoss: 1.098,
  takeProfit: 1.1033,
  confidence: 0.69,
  extensionAtr: 0.8,
  volatilityScore: 0.25,
  emaSeparation: 0.3,
  mtfStrength: 0.4,
  rsi14: 56,
};

describe('evaluateEnsembleGovernance', () => {
  it('keeps shadow admission separate from PAPER promotion governance', () => {
    const result = evaluateEnsembleGovernance(base);
    expect(ensemble.admitted).toBe(true);
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperPromotionEligible).toBe(false);
    expect(result.sleeveState).toBe('COLLECTING');
    expect(result.eventRisk).toBe('UNVERIFIED');
    expect(result.blockers).toEqual(
      expect.arrayContaining(['SLEEVE_COLLECTING', 'EVENT_RISK_UNVERIFIED']),
    );
  });

  it('allows safe PAPER execution while sleeve evidence is still collecting', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      eventRisk: 'CLEAR',
    });
    expect(result.sleeveState).toBe('COLLECTING');
    expect(result.paperExecutionEligible).toBe(true);
    expect(result.paperExecutionBlockers).toEqual([]);
    expect(result.paperPromotionEligible).toBe(false);
    expect(result.blockers).toContain('SLEEVE_COLLECTING');
  });

  it('requires the same net expected-R floor for PAPER execution and promotion', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      ensemble: { ...ensemble, expectedR: 0.1 },
      eventRisk: 'CLEAR',
    });
    expect(result.netExpectedR).toBeCloseTo(0.0375, 6);
    expect(result.paperNetExpectedRPassed).toBe(false);
    expect(result.netExpectedRPassed).toBe(false);
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperPromotionEligible).toBe(false);
    expect(result.paperExecutionBlockers).toContain('PAPER_NET_EXPECTED_R');
    expect(result.blockers).toContain('NET_EXPECTED_R');
  });

  it('keeps a strong extended/stressed setup shadow-only because it is not promotable', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      ensemble: {
        ...ensemble,
        regime: 'TREND_EXTENDED',
        regimeAllowed: false,
        expectedR: 0.33593365,
        paperAdmitted: true,
        admitted: false,
        reasons: ['REGIME_TREND_EXTENDED'],
      },
      instrument: 'AUDUSD',
      entryPrice: 0.69599,
      stopLoss: 0.69548,
      takeProfit: 0.69684,
      confidence: 0.74892924,
      extensionAtr: 1.4139681489950369,
      volatilityScore: 0.2671723076211882,
      emaSeparation: 0.755431308825067,
      mtfStrength: 1,
      rsi14: 66.02630845628374,
      eventRisk: 'CLEAR',
    });
    expect(result.driftState).toBe('STRESSED');
    expect(result.paperDriftPassed).toBe(false);
    expect(result.driftPassed).toBe(false);
    expect(result.netExpectedR).toBeGreaterThan(0.08);
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperExecutionBlockers).toEqual(
      expect.arrayContaining(['ENSEMBLE_NOT_PROMOTABLE_ADMISSION', 'DRIFT_STRESSED']),
    );
    expect(result.paperPromotionEligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining(['ENSEMBLE_NOT_ADMITTED', 'DRIFT_STRESSED', 'SLEEVE_COLLECTING']),
    );
  });

  it('deducts conservative execution friction from expected R', () => {
    const result = evaluateEnsembleGovernance(base);
    expect(result.estimatedExecutionCostR).toBeCloseTo(0.0625, 6);
    expect(result.netExpectedR).toBeCloseTo(0.2575, 6);
    expect(result.paperNetExpectedRPassed).toBe(true);
    expect(result.netExpectedRPassed).toBe(true);
  });

  it('uses fresh broker-observed P90 spread instead of the static diagnostic spread', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      ensemble: { ...ensemble, expectedR: 0.12 },
      eventRisk: 'CLEAR',
      executionSpreadEvidence: {
        ...base.executionSpreadEvidence,
        spreadPrice: 0.00001,
      },
    });
    expect(result.executionCostSource).toBe('BROKER_OBSERVED_P90');
    expect(result.estimatedExecutionCostR).toBeCloseTo(0.00625, 6);
    expect(result.netExpectedR).toBeCloseTo(0.11375, 6);
    expect(result.paperNetExpectedRPassed).toBe(true);
    expect(result.paperExecutionEligible).toBe(true);
  });

  it('uses a dedicated fail-closed reversal envelope instead of the continuation drift envelope', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      ensemble: {
        ...ensemble,
        regime: 'REVERSAL_CONFIRMED',
        strategyRoute: 'CONFIRMED_REVERSAL',
        expectedR: 0.55,
      },
      instrument: 'USDCAD',
      entryPrice: 1.426,
      stopLoss: 1.4245,
      takeProfit: 1.4285,
      confidence: 0.642,
      extensionAtr: 1.047,
      volatilityScore: 0.098,
      emaSeparation: 0.153,
      mtfStrength: 0,
      rsi14: 43.5,
      shortHorizonMomentumAtr: 0.789,
      eventRisk: 'CLEAR',
      executionSpreadEvidence: {
        ...base.executionSpreadEvidence,
        spreadPrice: 0.00003,
      },
    });
    expect(result.driftState).toBe('NORMAL');
    expect(result.paperDriftPassed).toBe(true);
    expect(result.netExpectedR).toBeGreaterThan(0.08);
    expect(result.paperExecutionEligible).toBe(true);
  });

  it('fails a reversal closed when its short-horizon impulse is outside the reversal envelope', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      ensemble: {
        ...ensemble,
        regime: 'REVERSAL_CONFIRMED',
        strategyRoute: 'CONFIRMED_REVERSAL',
        expectedR: 0.55,
      },
      confidence: 0.66,
      extensionAtr: 0.8,
      volatilityScore: 0.2,
      emaSeparation: 0.12,
      mtfStrength: 0,
      rsi14: 44,
      shortHorizonMomentumAtr: 2.2,
      eventRisk: 'CLEAR',
    });
    expect(result.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperExecutionBlockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
  });

  it('allows a PAPER-only early transition with strong net edge and route-specific drift', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      ensemble: {
        ...ensemble,
        regime: 'TRANSITION_EARLY',
        strategyRoute: 'EARLY_TRANSITION',
        expectedR: 0.47546005,
        paperAdmitted: true,
        admitted: false,
        reasons: ['PAPER_ADMIT_EARLY_TRANSITION'],
      },
      instrument: 'USDCAD',
      entryPrice: 1.4,
      stopLoss: 1.3985,
      takeProfit: 1.4025,
      confidence: 0.64115498,
      extensionAtr: 0.5036534883754534,
      volatilityScore: 0.08680744442421073,
      emaSeparation: 0.18806938253200653,
      mtfStrength: 0.0825608930811788,
      rsi14: 44.88867106850082,
      shortHorizonMomentumAtr: -0.10774705391807261,
      eventRisk: 'CLEAR',
      executionSpreadEvidence: { ...base.executionSpreadEvidence, spreadPrice: 0.00003 },
    });
    expect(result.driftState).toBe('NORMAL');
    expect(result.netExpectedR).toBeGreaterThanOrEqual(0.2);
    expect(result.paperExecutionEligible).toBe(true);
    expect(result.paperExecutionBlockers).toEqual([]);
    expect(result.paperPromotionEligible).toBe(false);
    expect(result.blockers).toContain('ENSEMBLE_NOT_ADMITTED');
  });

  it('keeps early-transition PAPER execution blocked below its stronger 0.20R net floor', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      ensemble: {
        ...ensemble,
        regime: 'TRANSITION_EARLY',
        strategyRoute: 'EARLY_TRANSITION',
        expectedR: 0.22,
        paperAdmitted: true,
        admitted: false,
        reasons: ['PAPER_ADMIT_EARLY_TRANSITION'],
      },
      instrument: 'USDCAD',
      entryPrice: 1.4,
      stopLoss: 1.3985,
      takeProfit: 1.4025,
      confidence: 0.65,
      extensionAtr: 0.5,
      volatilityScore: 0.1,
      emaSeparation: 0.18,
      mtfStrength: 0.08,
      rsi14: 44,
      shortHorizonMomentumAtr: 0.2,
      eventRisk: 'CLEAR',
      executionSpreadEvidence: { ...base.executionSpreadEvidence, spreadPrice: 0.00003 },
    });
    expect(result.netExpectedR).toBeLessThan(0.2);
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperExecutionBlockers).toContain('PAPER_NET_EXPECTED_R');
  });

  it('fails PAPER execution closed when broker spread evidence is unavailable', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      eventRisk: 'CLEAR',
      executionSpreadEvidence: null,
    });
    expect(result.executionCostSource).toBe('STATIC_DIAGNOSTIC_FALLBACK');
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperExecutionBlockers).toContain('EXECUTION_SPREAD_UNAVAILABLE');
    expect(result.blockers).toContain('EXECUTION_SPREAD_UNAVAILABLE');
  });

  it('fails PAPER execution closed when broker spread evidence is stale', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      eventRisk: 'CLEAR',
      executionSpreadEvidence: {
        ...base.executionSpreadEvidence,
        latestSampleAt: '2026-10-07T11:50:00.000Z',
      },
    });
    expect(result.executionCostSource).toBe('STATIC_DIAGNOSTIC_FALLBACK');
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperExecutionBlockers).toContain('EXECUTION_SPREAD_UNAVAILABLE');
  });

  it('fails cost governance when the stop geometry is too tight', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      stopLoss: 1.09965,
    });
    expect(result.paperNetExpectedRPassed).toBe(false);
    expect(result.netExpectedRPassed).toBe(false);
    expect(result.paperExecutionBlockers).toContain('PAPER_NET_EXPECTED_R');
    expect(result.blockers).toContain('NET_EXPECTED_R');
  });

  it('fails closed when the current feature vector is outside the frozen envelope', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      confidence: 0.9,
    });
    expect(result.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(result.paperDriftPassed).toBe(false);
    expect(result.driftPassed).toBe(false);
    expect(result.paperExecutionEligible).toBe(false);
    expect(result.paperExecutionBlockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
    expect(result.blockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
  });

  it('permits PAPER promotion only with qualified sleeve evidence and clear event risk', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      eventRisk: 'CLEAR',
      sleeveEvidence: {
        closedTrades: 140,
        profitFactor: 1.28,
        sharpe: 1.3,
        maxDrawdown: 0.08,
        positiveWindowFraction: 0.7,
      },
    });
    expect(result.sleeveState).toBe('CORE');
    expect(result.paperExecutionEligible).toBe(true);
    expect(result.paperPromotionEligible).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('places deteriorating qualified sleeves into probation or blocked state', () => {
    const probation = evaluateEnsembleGovernance({
      ...base,
      eventRisk: 'CLEAR',
      sleeveEvidence: {
        closedTrades: 120,
        profitFactor: 1.1,
        sharpe: 1.2,
        maxDrawdown: 0.08,
        positiveWindowFraction: 0.65,
      },
    });
    expect(probation.sleeveState).toBe('PROBATION');
    expect(probation.paperExecutionEligible).toBe(true);
    expect(probation.paperPromotionEligible).toBe(false);

    const blocked = evaluateEnsembleGovernance({
      ...base,
      eventRisk: 'CLEAR',
      sleeveEvidence: {
        closedTrades: 120,
        profitFactor: 0.9,
        sharpe: 0.5,
        maxDrawdown: 0.13,
        positiveWindowFraction: 0.4,
      },
    });
    expect(blocked.sleeveState).toBe('BLOCKED');
    expect(blocked.paperExecutionEligible).toBe(false);
    expect(blocked.paperExecutionBlockers).toContain('SLEEVE_BLOCKED');
    expect(blocked.paperPromotionEligible).toBe(false);
  });
});
