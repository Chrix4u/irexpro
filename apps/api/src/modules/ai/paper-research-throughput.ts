export const PAPER_RESEARCH_THROUGHPUT_ARTIFACT = 'paper-research-throughput-v1';
export const PAPER_RESEARCH_THROUGHPUT_LOT_CAP = 0.01;
export const PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R = 0.08;

const ALLOWED_RESEARCH_BLOCKERS = new Set([
  'ENSEMBLE_NOT_PAPER_ADMITTED',
  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
  'DRIFT_OUT_OF_DISTRIBUTION',
  'DRIFT_STRESSED',
]);

export interface PaperResearchThroughputInput {
  normalPaperExecution: boolean;
  confidence: number;
  netExpectedR: number;
  executionSpreadEvidenceValid: boolean;
  eventRisk: string;
  strategyRoute: string;
  paperExecutionBlockers: string[];
}

export interface PaperResearchThroughputDecision {
  eligible: boolean;
  artifact: typeof PAPER_RESEARCH_THROUGHPUT_ARTIFACT;
  route: 'PAPER_RESEARCH_THROUGHPUT';
  reason: string;
  qualificationEvidence: false;
  executionAuthority: 'PAPER_ONLY';
}

export function evaluatePaperResearchThroughput(
  input: PaperResearchThroughputInput,
): PaperResearchThroughputDecision {
  let reason = 'RESEARCH_EVIDENCE_CANDIDATE';

  if (input.normalPaperExecution) {
    reason = 'NORMAL_PAPER_EXECUTION';
  } else if (input.strategyRoute !== 'TREND_CONTINUATION') {
    reason = 'ROUTE_NOT_VALIDATED';
  } else if (!input.executionSpreadEvidenceValid) {
    reason = 'SPREAD_EVIDENCE_INVALID';
  } else if (input.eventRisk !== 'CLEAR') {
    reason = 'EVENT_RISK_NOT_CLEAR';
  } else if (!Number.isFinite(input.netExpectedR)) {
    reason = 'NET_EXPECTED_R_INVALID';
  } else if (input.netExpectedR < PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R) {
    reason = 'NET_EXPECTED_R_TOO_LOW';
  } else if (
    input.paperExecutionBlockers.length === 0 ||
    input.paperExecutionBlockers.some((blocker) => !ALLOWED_RESEARCH_BLOCKERS.has(blocker))
  ) {
    reason = 'UNSAFE_BLOCKER';
  }

  return {
    eligible: reason === 'RESEARCH_EVIDENCE_CANDIDATE',
    artifact: PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
    route: 'PAPER_RESEARCH_THROUGHPUT',
    reason,
    qualificationEvidence: false,
    executionAuthority: 'PAPER_ONLY',
  };
}
