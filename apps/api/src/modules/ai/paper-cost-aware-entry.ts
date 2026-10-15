export const PAPER_COST_AWARE_ENTRY_ARTIFACT = 'paper-cost-aware-entry-v1';
export const PAPER_COST_AWARE_MIN_COHORT_SAMPLES = 12;
export const PAPER_COST_AWARE_DEFER_FLIP_RATE = 0.45;
export const PAPER_COST_AWARE_SHADOW_FLIP_RATE = 0.7;
export const PAPER_COST_AWARE_HIGH_CURRENT_COST_RATIO = 0.6;
export const PAPER_COST_AWARE_MARGINAL_NET_EXPECTED_R = 0.12;
export const PAPER_COST_AWARE_STRONG_NET_EXPECTED_R = 0.2;
export const PAPER_COST_AWARE_STRONG_MAX_COST_RATIO = 0.4;

export type PaperCostAwareExecutionRoute =
  | 'NORMAL_PAPER'
  | 'PAPER_RESEARCH_THROUGHPUT'
  | 'PAIRED_REVERSAL_RESEARCH'
  | 'REJECTED_EDGE_CANARY';

export interface PaperCostAwareCohortEvidence {
  grossPositiveSamples: number;
  costFlippedSamples: number;
  netPositiveSamples: number;
}

export interface PaperCostAwareEntryInput {
  executionRoute: PaperCostAwareExecutionRoute;
  grossExpectedR: number;
  netExpectedR: number;
  estimatedExecutionCostR: number;
  evidence: PaperCostAwareCohortEvidence;
}

export interface PaperCostAwareEntryDecision {
  artifact: typeof PAPER_COST_AWARE_ENTRY_ARTIFACT;
  action: 'ENTER_NOW' | 'DEFER' | 'SHADOW_ONLY';
  reason:
    | 'DIAGNOSTIC_ONLY_NON_RESEARCH_ROUTE'
    | 'INVALID_CURRENT_ECONOMICS'
    | 'SPARSE_COHORT_EVIDENCE'
    | 'PAIR_SIDE_COST_DRAG'
    | 'PAIR_SIDE_COST_DRAG_SEVERE'
    | 'CURRENT_COST_BURDEN_HIGH'
    | 'STRONG_CURRENT_EDGE_OVERRIDE'
    | 'COST_EFFICIENT_ENTRY';
  modifiesExecution: boolean;
  qualificationEvidence: false;
  costFlipRate: number | null;
  currentCostRatio: number | null;
}

function safeRate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

export function evaluatePaperCostAwareEntry(
  input: PaperCostAwareEntryInput,
): PaperCostAwareEntryDecision {
  const modifiesExecution = input.executionRoute === 'PAPER_RESEARCH_THROUGHPUT';
  const costFlipRate = safeRate(
    input.evidence.costFlippedSamples,
    input.evidence.grossPositiveSamples,
  );
  const currentCostRatio = safeRate(input.estimatedExecutionCostR, input.grossExpectedR);

  const decision = (
    action: PaperCostAwareEntryDecision['action'],
    reason: PaperCostAwareEntryDecision['reason'],
  ): PaperCostAwareEntryDecision => ({
    artifact: PAPER_COST_AWARE_ENTRY_ARTIFACT,
    action,
    reason,
    modifiesExecution,
    qualificationEvidence: false,
    costFlipRate,
    currentCostRatio,
  });

  if (!modifiesExecution) {
    return decision('ENTER_NOW', 'DIAGNOSTIC_ONLY_NON_RESEARCH_ROUTE');
  }

  if (
    !Number.isFinite(input.grossExpectedR) ||
    input.grossExpectedR <= 0 ||
    !Number.isFinite(input.netExpectedR) ||
    !Number.isFinite(input.estimatedExecutionCostR) ||
    input.estimatedExecutionCostR < 0
  ) {
    return decision('SHADOW_ONLY', 'INVALID_CURRENT_ECONOMICS');
  }

  const cohortMature = input.evidence.grossPositiveSamples >= PAPER_COST_AWARE_MIN_COHORT_SAMPLES;

  if (cohortMature && costFlipRate !== null && costFlipRate >= PAPER_COST_AWARE_SHADOW_FLIP_RATE) {
    return decision('SHADOW_ONLY', 'PAIR_SIDE_COST_DRAG_SEVERE');
  }

  if (
    currentCostRatio !== null &&
    currentCostRatio >= PAPER_COST_AWARE_HIGH_CURRENT_COST_RATIO &&
    input.netExpectedR <= PAPER_COST_AWARE_MARGINAL_NET_EXPECTED_R
  ) {
    return decision('DEFER', 'CURRENT_COST_BURDEN_HIGH');
  }

  if (!cohortMature) {
    return decision('ENTER_NOW', 'SPARSE_COHORT_EVIDENCE');
  }

  if (costFlipRate !== null && costFlipRate >= PAPER_COST_AWARE_DEFER_FLIP_RATE) {
    if (
      input.netExpectedR >= PAPER_COST_AWARE_STRONG_NET_EXPECTED_R &&
      currentCostRatio !== null &&
      currentCostRatio <= PAPER_COST_AWARE_STRONG_MAX_COST_RATIO
    ) {
      return decision('ENTER_NOW', 'STRONG_CURRENT_EDGE_OVERRIDE');
    }
    return decision('DEFER', 'PAIR_SIDE_COST_DRAG');
  }

  return decision('ENTER_NOW', 'COST_EFFICIENT_ENTRY');
}
