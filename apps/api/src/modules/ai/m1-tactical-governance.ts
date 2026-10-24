import type { M1TacticalCandidate } from './m1-tactical-candidate';
import { M1_TACTICAL_POLICY_V1 } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';
import type { M1TacticalRoute, M1TacticalRouteDecision } from './m1-tactical-route';
import {
  evaluateEnsembleGovernance,
  type EnsembleEventRiskState,
  type EnsembleGovernanceDecision,
  type EnsembleSleeveEvidence,
  type ExecutionSpreadEvidence,
} from './ensemble-governance';
import {
  PLAN_B_ENSEMBLE_ARTIFACT,
  PLAN_B_ENSEMBLE_MODE,
  type PlanBEnsembleScore,
} from './plan-b-multimodel-shadow';

export type M1TacticalExecutionAuthority = 'PAPER_ONLY_RESEARCH' | 'NONE';

export interface M1TacticalReliabilityAdmission {
  eligible: boolean;
  reason: string;
}

export interface M1TacticalGovernanceInput {
  candidate: M1TacticalCandidate;
  routeDecision: M1TacticalRouteDecision;
  features: M1TacticalFeatureSnapshot;
  eventRisk: EnsembleEventRiskState;
  evaluatedAt: Date;
  executionSpreadEvidence?: ExecutionSpreadEvidence | null;
  paperSimulationSpreadPrice?: number;
  sleeveEvidence?: EnsembleSleeveEvidence | null;
  reliability?: M1TacticalReliabilityAdmission | null;
}

export interface M1TacticalGovernanceDecision {
  route: M1TacticalRoute;
  direction: 'BUY' | 'SELL' | null;
  paperEligible: boolean;
  executionAuthority: M1TacticalExecutionAuthority;
  promotionEligible: false;
  qualificationEvidence: false;
  netExpectedR: number;
  blockers: string[];
  genericGovernance: EnsembleGovernanceDecision;
}

function strategySemantics(route: M1TacticalRoute): {
  strategyRoute: PlanBEnsembleScore['strategyRoute'];
  regime: PlanBEnsembleScore['regime'];
  admitted: boolean;
} {
  switch (route) {
    case 'M1_CONFIRMED_REVERSAL':
      return { strategyRoute: 'CONFIRMED_REVERSAL', regime: 'REVERSAL_CONFIRMED', admitted: true };
    case 'M1_EARLY_TRANSITION':
      return { strategyRoute: 'EARLY_TRANSITION', regime: 'TRANSITION_EARLY', admitted: false };
    case 'M1_TREND_CONTINUATION':
      return { strategyRoute: 'TREND_CONTINUATION', regime: 'TREND_HEALTHY', admitted: true };
    default:
      return { strategyRoute: 'TREND_CONTINUATION', regime: 'TREND_WEAK', admitted: false };
  }
}

function ensembleScore(input: M1TacticalGovernanceInput): PlanBEnsembleScore {
  const semantics = strategySemantics(input.routeDecision.route);
  return {
    artifact: PLAN_B_ENSEMBLE_ARTIFACT,
    mode: PLAN_B_ENSEMBLE_MODE,
    modifiesExecution: false,
    regime: semantics.regime,
    regimeAllowed: input.routeDecision.eligible,
    strategyRoute: semantics.strategyRoute,
    directionQuality: input.candidate.directionQuality,
    expectedR: input.candidate.grossExpectedR,
    tradeQuality: input.candidate.directionQuality,
    exitQuality: input.candidate.directionQuality,
    pairSideQuality: input.candidate.directionQuality,
    pairSideRoute: 'GOVERNANCE',
    sessionQuality: 1,
    consensusPassed: 1,
    consensusRequired: 1,
    portfolioQuality: 1,
    portfolioRiskScore: 0,
    openPositionCount: 0,
    sameInstrumentCount: 0,
    sameInstrumentDirectionalLots: 0,
    metaProbability: input.candidate.confidence,
    ensembleScore: input.candidate.score,
    paperAdmitted: input.routeDecision.eligible,
    admitted: input.routeDecision.eligible && semantics.admitted,
    reasons: [input.routeDecision.reason],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function evaluateM1TacticalGovernance(
  input: M1TacticalGovernanceInput,
): M1TacticalGovernanceDecision {
  const genericGovernance = evaluateEnsembleGovernance({
    ensemble: ensembleScore(input),
    instrument: input.candidate.instrument,
    direction: input.candidate.direction,
    entryPrice: input.candidate.entry,
    stopLoss: input.candidate.stopLoss,
    takeProfit: input.candidate.takeProfit,
    confidence: input.candidate.confidence,
    extensionAtr: input.features.extensionAtr,
    volatilityScore: input.features.volatilityScore,
    emaSeparation: Math.max(0, input.candidate.alignedEmaSeparationAtr),
    mtfStrength: Math.max(0, input.candidate.alignedM15),
    rsi14: input.features.rsi14,
    shortHorizonMomentumAtr: input.features.momentum3Atr,
    eventRisk: input.eventRisk,
    sleeveEvidence: input.sleeveEvidence ?? null,
    evaluatedAt: input.evaluatedAt,
    executionSpreadEvidence: input.executionSpreadEvidence ?? null,
    paperSimulationSpreadPrice: input.paperSimulationSpreadPrice,
  });

  const blockers = [...genericGovernance.paperExecutionBlockers];
  if (
    !input.routeDecision.eligible ||
    input.routeDecision.route === 'ABSTAIN' ||
    input.routeDecision.direction !== input.candidate.direction
  ) {
    blockers.push('M1_ROUTE_NOT_ELIGIBLE');
  }
  if (
    input.routeDecision.policyVersion !== input.candidate.policyVersion ||
    input.candidate.policyVersion !== M1_TACTICAL_POLICY_V1.version
  ) {
    blockers.push('M1_POLICY_MISMATCH');
  }
  if (
    input.routeDecision.route !== 'M1_CONFIRMED_REVERSAL' &&
    input.routeDecision.reason !== 'LOCAL_IMPULSE_AGAINST_HTF' &&
    input.candidate.alignedHigherTimeframeAgreement <=
      -M1_TACTICAL_POLICY_V1.minContinuationHtfAgreement
  ) {
    blockers.push('M1_HIGHER_TIMEFRAME_CONFLICT');
  }
  if (input.reliability && !input.reliability.eligible) {
    blockers.push(`M1_RELIABILITY_${input.reliability.reason}`);
  }

  const finalBlockers = unique(blockers);
  const paperEligible = finalBlockers.length === 0;
  return {
    route: input.routeDecision.route,
    direction: paperEligible ? input.candidate.direction : null,
    paperEligible,
    executionAuthority: paperEligible ? 'PAPER_ONLY_RESEARCH' : 'NONE',
    promotionEligible: false,
    qualificationEvidence: false,
    netExpectedR: genericGovernance.netExpectedR,
    blockers: finalBlockers,
    genericGovernance,
  };
}
