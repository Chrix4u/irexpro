import { evaluateEnsembleGovernance } from './ensemble-governance';
import { PlanBEnsembleScore } from './plan-b-multimodel-shadow';

const ensemble: PlanBEnsembleScore = {
  artifact: 'plan-b-multimodel-shadow-v2',
  mode: 'PROSPECTIVE_SHADOW_ONLY',
  modifiesExecution: false,
  regime: 'TREND_HEALTHY',
  regimeAllowed: true,
  directionQuality: 0.8,
  expectedR: 0.32,
  tradeQuality: 0.7,
  exitQuality: 0.7,
  pairSideQuality: 0.75,
  pairSideRoute: 'CORE',
  sessionQuality: 0.9,
  consensusPassed: 8,
  consensusRequired: 7,
  portfolioQuality: 0.9,
  portfolioRiskScore: 0.1,
  openPositionCount: 0,
  sameInstrumentCount: 0,
  metaProbability: 0.6,
  ensembleScore: 0.7,
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
    expect(result.paperPromotionEligible).toBe(false);
    expect(result.sleeveState).toBe('COLLECTING');
    expect(result.eventRisk).toBe('UNVERIFIED');
    expect(result.blockers).toEqual(
      expect.arrayContaining(['SLEEVE_COLLECTING', 'EVENT_RISK_UNVERIFIED']),
    );
  });

  it('deducts conservative execution friction from expected R', () => {
    const result = evaluateEnsembleGovernance(base);
    expect(result.estimatedExecutionCostR).toBeCloseTo(0.0625, 6);
    expect(result.netExpectedR).toBeCloseTo(0.2575, 6);
    expect(result.netExpectedRPassed).toBe(true);
  });

  it('fails cost governance when the stop geometry is too tight', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      stopLoss: 1.0996,
    });
    expect(result.netExpectedRPassed).toBe(false);
    expect(result.blockers).toContain('NET_EXPECTED_R');
  });

  it('fails closed when the current feature vector is outside the frozen envelope', () => {
    const result = evaluateEnsembleGovernance({
      ...base,
      confidence: 0.9,
    });
    expect(result.driftState).toBe('OUT_OF_DISTRIBUTION');
    expect(result.driftPassed).toBe(false);
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
    expect(blocked.paperPromotionEligible).toBe(false);
  });
});
