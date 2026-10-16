import type { AdaptiveEdgeMaturity } from './adaptive-edge-matrix.service';
import type { AdaptiveMarketSession, AdaptiveMarketState } from './adaptive-market-state';
import type { AdaptivePortfolioCapacity } from './adaptive-currency-exposure';
import type { PaperExecutionRoute } from './paper-research-throughput';

export const ADAPTIVE_RISK_MULTIPLIER_ARTIFACT = 'adaptive-risk-multiplier-v1';
export type AdaptiveRiskMultiplier = 0.5 | 0.75 | 1 | 1.1 | 1.25;

export interface AdaptiveRiskMultiplierInput {
  executionRoute: PaperExecutionRoute;
  opportunityScore: number;
  netExpectedR: number;
  executionCostUsable: boolean;
  hardBlockers: string[];
  marketState: {
    state: AdaptiveMarketState;
    canUpsize: boolean;
    session: AdaptiveMarketSession;
  };
  edge: {
    available: boolean;
    maturity: AdaptiveEdgeMaturity;
    smoothedExpectedR: number;
    profitFactor: number | null;
    maxDrawdown: number | null;
    recentDegradation: boolean;
    canUpsize: boolean;
  };
  exposure: {
    capacity: AdaptivePortfolioCapacity;
    canUpsize: boolean;
    riskEvidenceComplete: boolean;
  };
}

export interface AdaptiveRiskMultiplierDecision {
  artifact: typeof ADAPTIVE_RISK_MULTIPLIER_ARTIFACT;
  multiplier: AdaptiveRiskMultiplier;
  canUpsize: boolean;
  executionEligible: boolean;
  hardBlockers: string[];
  reasons: string[];
}

const RESEARCH_ROUTES = new Set<PaperExecutionRoute>([
  'PAPER_RESEARCH_THROUGHPUT',
  'PAIRED_REVERSAL_RESEARCH',
  'REJECTED_EDGE_CANARY',
]);

const NO_UPSIZE_STATES = new Set<AdaptiveMarketState>([
  'UNKNOWN',
  'DISLOCATED',
  'ROLLOVER_RISK',
  'HIGH_VOLATILITY',
  'TREND_EXTENDED',
  'TREND_WEAK',
  'RANGE',
  'TRANSITION',
]);

export function selectAdaptiveRiskMultiplier(
  input: AdaptiveRiskMultiplierInput,
): AdaptiveRiskMultiplierDecision {
  const hardBlocked = input.hardBlockers.length > 0;
  const research = RESEARCH_ROUTES.has(input.executionRoute);
  const degraded = input.edge.maturity === 'DEGRADED' || input.edge.recentDegradation;
  const unsafeState =
    NO_UPSIZE_STATES.has(input.marketState.state) || input.marketState.session === 'ROLLOVER';
  const blockedExposure = input.exposure.capacity === 'BLOCKED';
  const reducedExposure = input.exposure.capacity === 'REDUCED';
  const evidenceUnavailable = !input.edge.available || !input.exposure.riskEvidenceComplete;

  let multiplier: AdaptiveRiskMultiplier = 1;
  const reasons: string[] = [];

  if (hardBlocked || degraded || blockedExposure || input.marketState.state === 'DISLOCATED') {
    multiplier = 0.5;
  } else if (
    reducedExposure ||
    evidenceUnavailable ||
    input.edge.maturity === 'SPARSE' ||
    unsafeState ||
    !input.executionCostUsable
  ) {
    multiplier = 0.75;
  }

  const researchMinimumRiskBandApplied =
    research && !hardBlocked && !degraded && !blockedExposure && multiplier === 0.5;
  if (researchMinimumRiskBandApplied) multiplier = 0.75;

  const maturePositiveUpsize =
    !hardBlocked &&
    !research &&
    input.executionRoute === 'NORMAL_PAPER' &&
    input.executionCostUsable &&
    !unsafeState &&
    input.marketState.canUpsize &&
    input.edge.available &&
    input.edge.maturity === 'MATURE' &&
    !input.edge.recentDegradation &&
    input.edge.canUpsize &&
    input.edge.smoothedExpectedR > 0 &&
    input.edge.profitFactor !== null &&
    input.edge.profitFactor >= 1.15 &&
    input.edge.maxDrawdown !== null &&
    input.edge.maxDrawdown <= 0.12 &&
    input.exposure.capacity === 'CLEAR' &&
    input.exposure.canUpsize &&
    input.exposure.riskEvidenceComplete &&
    Number.isFinite(input.netExpectedR) &&
    input.netExpectedR > 0;

  if (maturePositiveUpsize) {
    multiplier = input.opportunityScore >= 0.85 && input.netExpectedR >= 0.2 ? 1.25 : 1.1;
  }

  if (research && multiplier > 1) multiplier = 1;
  if (hardBlocked) reasons.push('HARD_GOVERNANCE_BLOCKED');
  if (research) reasons.push('RESEARCH_UPSIZE_DISABLED');
  if (researchMinimumRiskBandApplied) reasons.push('RESEARCH_MINIMUM_RISK_BAND');
  if (degraded) reasons.push('EDGE_DEGRADED');
  if (blockedExposure) reasons.push('PORTFOLIO_CAPACITY_BLOCKED');
  else if (reducedExposure) reasons.push('PORTFOLIO_CAPACITY_REDUCED');
  if (evidenceUnavailable) reasons.push('ADAPTIVE_EVIDENCE_INCOMPLETE');
  if (unsafeState) reasons.push(`MARKET_STATE_${input.marketState.state}`);
  if (!input.executionCostUsable) reasons.push('EXECUTION_COST_UNUSABLE');
  if (maturePositiveUpsize)
    reasons.push(multiplier === 1.25 ? 'EXCEPTIONAL_MATURE_EDGE' : 'MATURE_POSITIVE_EDGE');
  if (!reasons.length) reasons.push('STANDARD_RISK');

  return {
    artifact: ADAPTIVE_RISK_MULTIPLIER_ARTIFACT,
    multiplier,
    canUpsize: multiplier > 1,
    executionEligible: !hardBlocked,
    hardBlockers: [...input.hardBlockers],
    reasons,
  };
}
