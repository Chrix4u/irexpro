import {
  evaluateProductionQualificationShadow,
  ProductionQualificationShadowInput,
} from './production-qualification-shadow';

const qualified: ProductionQualificationShadowInput = {
  candidateDirection: 'SELL',
  planBAdmitted: true,
  planBGovernanceEligible: true,
  planBSpreadEvidenceValid: true,
  m1RouteEligible: true,
  m1GovernanceEligible: true,
  m1SpreadEvidenceValid: true,
  m1DriftState: 'NORMAL',
  trainedExpert: {
    state: 'CONFIRM',
    direction: 'SELL',
    allBrokerNative: true,
    reason: null,
  },
  planBForecastCostWouldReject: true,
  m1ForecastCostWouldReject: true,
  commissionForecastWouldReject: true,
};

describe('shared production qualification decision-time research', () => {
  it('records qualified model agreement without allowing forecast-cost vetoes to change it', () => {
    const audit = evaluateProductionQualificationShadow(qualified);
    expect(audit).toMatchObject({
      mode: 'SHADOW_ONLY',
      grantsExecution: false,
      modifiesExecution: false,
      independentStrategyEligible: true,
      trainedExpertConfirmed: true,
      strictAgreementCounterfactual: true,
      forecastCostShadow: {
        planBWouldReject: true,
        m1WouldReject: true,
        commissionWouldReject: true,
      },
    });
    expect(audit.strategyChecks).toEqual([]);
    expect(audit.expertChecks).toEqual([]);
  });

  it('explains 17:28 GBPUSD SELL: independently eligible but expert abstained', () => {
    const audit = evaluateProductionQualificationShadow({
      ...qualified,
      m1ForecastCostWouldReject: false,
      trainedExpert: {
        state: 'ABSTAIN',
        direction: 'SELL',
        allBrokerNative: true,
        reason: null,
      },
    });
    expect(audit.independentStrategyEligible).toBe(true);
    expect(audit.trainedExpertConfirmed).toBe(false);
    expect(audit.strictAgreementCounterfactual).toBe(false);
    expect(audit.expertChecks).toEqual(['EXPERT_NOT_CONFIRMED']);
    expect(audit.strategyChecks).toEqual([]);
  });

  it('explains 18:10 GBPUSD SELL: M1 drift stressed and expert unavailable', () => {
    const audit = evaluateProductionQualificationShadow({
      ...qualified,
      m1GovernanceEligible: false,
      m1DriftState: 'STRESSED',
      trainedExpert: {
        state: 'UNAVAILABLE',
        direction: null,
        allBrokerNative: false,
        reason: 'BROKER_MARKET_DATA_UNAVAILABLE',
      },
    });
    expect(audit.independentStrategyEligible).toBe(false);
    expect(audit.trainedExpertConfirmed).toBe(false);
    expect(audit.strictAgreementCounterfactual).toBe(false);
    expect(audit.strategyChecks).toEqual(['M1_GOVERNANCE_FAILED', 'M1_DRIFT_NOT_NORMAL']);
    expect(audit.expertChecks).toEqual([
      'EXPERT_NOT_CONFIRMED',
      'EXPERT_NOT_BROKER_NATIVE',
      'EXPERT_DIRECTION_MISMATCH',
    ]);
  });

  it('distinguishes missing broker spread evidence from predicted commission', () => {
    const audit = evaluateProductionQualificationShadow({
      ...qualified,
      m1SpreadEvidenceValid: false,
      commissionForecastWouldReject: false,
    });
    expect(audit.strategyChecks).toContain('M1_MARKET_DATA_UNVERIFIED');
    expect(audit.independentStrategyEligible).toBe(false);
    expect(audit.grantsExecution).toBe(false);
  });
});
