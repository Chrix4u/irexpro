import { evaluateEnsembleGovernance } from './ensemble-governance';
import { PlanBEnsembleScore } from './plan-b-multimodel-shadow';

const ensemble: PlanBEnsembleScore = {
  artifact: 'plan-b-multimodel-shadow-v4',
  mode: 'PROSPECTIVE_SHADOW_ONLY',
  modifiesExecution: false,
  regime: 'TREND_HEALTHY',
  regimeAllowed: true,
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

const base = {
  ensemble,
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
