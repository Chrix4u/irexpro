import type { HighConvictionOverlay } from './high-conviction-overlay';

export const PRODUCTION_QUALIFICATION_SHADOW_ARTIFACT =
  'production-qualification-decision-audit-v1' as const;

export type ProductionQualificationCheck =
  | 'PLAN_B_NOT_ADMITTED'
  | 'PLAN_B_GOVERNANCE_FAILED'
  | 'PLAN_B_MARKET_DATA_UNVERIFIED'
  | 'M1_ROUTE_NOT_ELIGIBLE'
  | 'M1_GOVERNANCE_FAILED'
  | 'M1_MARKET_DATA_UNVERIFIED'
  | 'M1_DRIFT_NOT_NORMAL'
  | 'EXPERT_NOT_CONFIRMED'
  | 'EXPERT_NOT_BROKER_NATIVE'
  | 'EXPERT_DIRECTION_MISMATCH';

/**
 * Independent research counterfactual: no new order authority or veto.
 * The same input contract can be evaluated in PAPER, DEMO and prospective
 * LIVE studies. It is NOT a substitute for broker margin, loss, event,
 * session, stop-loss or position-management controls.
 */
export interface ProductionQualificationShadowInput {
  candidateDirection: 'BUY' | 'SELL';
  planBAdmitted: boolean;
  planBGovernanceEligible: boolean;
  planBSpreadEvidenceValid: boolean;
  m1RouteEligible: boolean;
  m1GovernanceEligible: boolean;
  m1SpreadEvidenceValid: boolean;
  m1DriftState: string;
  trainedExpert: Pick<HighConvictionOverlay, 'state' | 'direction' | 'allBrokerNative' | 'reason'>;
  planBForecastCostWouldReject: boolean | null;
  m1ForecastCostWouldReject: boolean | null;
  commissionForecastWouldReject: boolean | null;
}

export function evaluateProductionQualificationShadow(input: ProductionQualificationShadowInput) {
  const strategyChecks: ProductionQualificationCheck[] = [];
  if (!input.planBAdmitted) strategyChecks.push('PLAN_B_NOT_ADMITTED');
  if (!input.planBGovernanceEligible) strategyChecks.push('PLAN_B_GOVERNANCE_FAILED');
  if (!input.planBSpreadEvidenceValid) strategyChecks.push('PLAN_B_MARKET_DATA_UNVERIFIED');
  if (!input.m1RouteEligible) strategyChecks.push('M1_ROUTE_NOT_ELIGIBLE');
  if (!input.m1GovernanceEligible) strategyChecks.push('M1_GOVERNANCE_FAILED');
  if (!input.m1SpreadEvidenceValid) strategyChecks.push('M1_MARKET_DATA_UNVERIFIED');
  if (input.m1DriftState !== 'NORMAL') strategyChecks.push('M1_DRIFT_NOT_NORMAL');

  const expertChecks: ProductionQualificationCheck[] = [];
  if (input.trainedExpert.state !== 'CONFIRM') expertChecks.push('EXPERT_NOT_CONFIRMED');
  if (!input.trainedExpert.allBrokerNative) expertChecks.push('EXPERT_NOT_BROKER_NATIVE');
  if (input.trainedExpert.direction !== input.candidateDirection) {
    expertChecks.push('EXPERT_DIRECTION_MISMATCH');
  }

  return {
    artifact: PRODUCTION_QUALIFICATION_SHADOW_ARTIFACT,
    mode: 'SHADOW_ONLY' as const,
    modifiesExecution: false as const,
    grantsExecution: false as const,
    independentStrategyEligible: strategyChecks.length === 0,
    trainedExpertConfirmed: expertChecks.length === 0,
    strictAgreementCounterfactual: strategyChecks.length === 0 && expertChecks.length === 0,
    strategyChecks,
    expertChecks,
    expertState: input.trainedExpert.state,
    expertReason: input.trainedExpert.reason,
    forecastCostShadow: {
      planBWouldReject: input.planBForecastCostWouldReject,
      m1WouldReject: input.m1ForecastCostWouldReject,
      commissionWouldReject: input.commissionForecastWouldReject,
    },
  };
}
