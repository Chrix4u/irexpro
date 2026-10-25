export const PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT =
  'paper-research-requalification-shadow-v1';
export const PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES = 8;
export const PAPER_RESEARCH_REQUALIFICATION_MIN_PROFIT_FACTOR = 1.15;
export const PAPER_RESEARCH_REQUALIFICATION_MIN_SHARPE = 1.0;
export const PAPER_RESEARCH_REQUALIFICATION_MAX_DRAWDOWN = 0.12;

export type PaperResearchRequalificationShadowReason =
  | 'SHADOW_RECOVERY_CANDIDATE'
  | 'RESEARCH_ROUTE_NOT_ELIGIBLE'
  | 'PAIR_SIDE_RELIABILITY_BLOCK'
  | 'EPISODE_GUARD_BLOCK'
  | 'BROAD_CALIBRATION_BRAKE'
  | 'COST_AWARE_BLOCK';

export type PaperResearchRequalificationCostAction = 'ENTER_NOW' | 'DEFER' | 'SHADOW_ONLY';

export interface PaperResearchRequalificationShadowInput {
  throughputEligible: boolean;
  pairSideEligible: boolean;
  episodeEligible: boolean;
  calibrationBlocked: boolean;
  portfolioBlocked: boolean;
  costAwareAction: PaperResearchRequalificationCostAction;
  costAwareReason: string;
  pairSideSamples: number;
  pairSideRealisedAverageR: number | null;
}

export interface PaperResearchRequalificationShadowDecision {
  artifact: typeof PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT;
  candidate: boolean;
  reason: PaperResearchRequalificationShadowReason;
  executionAuthority: 'NONE';
  modifiesExecution: false;
  qualificationEvidence: false;
  productionEligible: false;
  portfolioBrakeBlocked: boolean;
  pairSideSamples: number;
  pairSideRealisedAverageR: number | null;
  costAwareAction: PaperResearchRequalificationCostAction;
  costAwareReason: string;
}

export function evaluatePaperResearchRequalificationShadow(
  input: PaperResearchRequalificationShadowInput,
): PaperResearchRequalificationShadowDecision {
  let reason: PaperResearchRequalificationShadowReason = 'SHADOW_RECOVERY_CANDIDATE';
  if (!input.throughputEligible) reason = 'RESEARCH_ROUTE_NOT_ELIGIBLE';
  else if (!input.pairSideEligible) reason = 'PAIR_SIDE_RELIABILITY_BLOCK';
  else if (!input.episodeEligible) reason = 'EPISODE_GUARD_BLOCK';
  else if (input.calibrationBlocked) reason = 'BROAD_CALIBRATION_BRAKE';
  else if (input.costAwareAction !== 'ENTER_NOW') reason = 'COST_AWARE_BLOCK';

  return {
    artifact: PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT,
    candidate: reason === 'SHADOW_RECOVERY_CANDIDATE',
    reason,
    executionAuthority: 'NONE',
    modifiesExecution: false,
    qualificationEvidence: false,
    productionEligible: false,
    portfolioBrakeBlocked: input.portfolioBlocked,
    pairSideSamples: Math.max(0, Math.trunc(input.pairSideSamples)),
    pairSideRealisedAverageR:
      input.pairSideRealisedAverageR !== null &&
      Number.isFinite(input.pairSideRealisedAverageR)
        ? input.pairSideRealisedAverageR
        : null,
    costAwareAction: input.costAwareAction,
    costAwareReason: input.costAwareReason,
  };
}

export type PaperResearchRequalificationEvidenceState = 'COLLECTING' | 'RECOVERY_SIGNAL' | 'WEAK';

export interface PaperResearchRequalificationEvidenceInput {
  episodes: number;
  wins: number;
  losses: number;
  netR: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
}

export interface PaperResearchRequalificationEvidenceDecision {
  artifact: typeof PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT;
  state: PaperResearchRequalificationEvidenceState;
  reason:
    | 'INSUFFICIENT_FRESH_EPISODES'
    | 'FRESH_EDGE_RECOVERY_SIGNAL'
    | 'FRESH_EDGE_NOT_RECOVERED';
  executionAuthority: 'NONE';
  modifiesExecution: false;
  qualificationEvidence: false;
  productionEligible: false;
  episodes: number;
  wins: number;
  losses: number;
  netR: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
}

export function evaluatePaperResearchRequalificationEvidence(
  input: PaperResearchRequalificationEvidenceInput,
): PaperResearchRequalificationEvidenceDecision {
  const episodes = Math.max(0, Math.trunc(input.episodes));
  const wins = Math.max(0, Math.trunc(input.wins));
  const losses = Math.max(0, Math.trunc(input.losses));
  const netR = Number.isFinite(input.netR) ? input.netR : 0;
  const profitFactor =
    input.profitFactor !== null && Number.isFinite(input.profitFactor)
      ? input.profitFactor
      : null;
  const sharpe = input.sharpe !== null && Number.isFinite(input.sharpe) ? input.sharpe : null;
  const maxDrawdown =
    input.maxDrawdown !== null && Number.isFinite(input.maxDrawdown) ? input.maxDrawdown : null;
  const base = {
    artifact: PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT as typeof PAPER_RESEARCH_REQUALIFICATION_SHADOW_ARTIFACT,
    executionAuthority: 'NONE' as const,
    modifiesExecution: false as const,
    qualificationEvidence: false as const,
    productionEligible: false as const,
    episodes,
    wins,
    losses,
    netR,
    profitFactor,
    sharpe,
    maxDrawdown,
  };

  if (episodes < PAPER_RESEARCH_REQUALIFICATION_MIN_EPISODES) {
    return { ...base, state: 'COLLECTING', reason: 'INSUFFICIENT_FRESH_EPISODES' };
  }

  const profitFactorPassed =
    losses === 0
      ? wins > 0 && netR > 0
      : profitFactor !== null &&
        profitFactor >= PAPER_RESEARCH_REQUALIFICATION_MIN_PROFIT_FACTOR;
  const recovered =
    profitFactorPassed &&
    sharpe !== null &&
    sharpe >= PAPER_RESEARCH_REQUALIFICATION_MIN_SHARPE &&
    maxDrawdown !== null &&
    maxDrawdown <= PAPER_RESEARCH_REQUALIFICATION_MAX_DRAWDOWN &&
    netR > 0;

  return recovered
    ? { ...base, state: 'RECOVERY_SIGNAL', reason: 'FRESH_EDGE_RECOVERY_SIGNAL' }
    : { ...base, state: 'WEAK', reason: 'FRESH_EDGE_NOT_RECOVERED' };
}
