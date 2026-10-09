export const PAPER_RESEARCH_THROUGHPUT_ARTIFACT = 'paper-research-throughput-v2-quality-gated';
export const PAPER_RESEARCH_THROUGHPUT_LOT_CAP = 0.01;
export const PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R = 0.08;
export const PAPER_RESEARCH_THROUGHPUT_MIN_CONFIDENCE = 0.64;
export const PAPER_RESEARCH_THROUGHPUT_MIN_DIRECTION_QUALITY = 0.55;
export const PAPER_RESEARCH_THROUGHPUT_MIN_TRADE_QUALITY = 0.48;
export const PAPER_RESEARCH_THROUGHPUT_MIN_EXIT_QUALITY = 0.48;

const ALLOWED_RESEARCH_BLOCKERS = new Set([
  'ENSEMBLE_NOT_PAPER_ADMITTED',
  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
]);

export interface PaperResearchThroughputInput {
  normalPaperExecution: boolean;
  confidence: number;
  netExpectedR: number;
  executionSpreadEvidenceValid: boolean;
  eventRisk: string;
  strategyRoute: string;
  driftState: string;
  directionQuality: number;
  tradeQuality: number;
  exitQuality: number;
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
  } else if (
    !Number.isFinite(input.confidence) ||
    input.confidence < PAPER_RESEARCH_THROUGHPUT_MIN_CONFIDENCE
  ) {
    reason = 'CONFIDENCE_TOO_LOW';
  } else if (input.driftState !== 'NORMAL') {
    reason = 'DRIFT_NOT_NORMAL';
  } else if (
    !Number.isFinite(input.directionQuality) ||
    input.directionQuality < PAPER_RESEARCH_THROUGHPUT_MIN_DIRECTION_QUALITY
  ) {
    reason = 'DIRECTION_QUALITY_TOO_LOW';
  } else if (
    !Number.isFinite(input.tradeQuality) ||
    input.tradeQuality < PAPER_RESEARCH_THROUGHPUT_MIN_TRADE_QUALITY
  ) {
    reason = 'TRADE_QUALITY_TOO_LOW';
  } else if (
    !Number.isFinite(input.exitQuality) ||
    input.exitQuality < PAPER_RESEARCH_THROUGHPUT_MIN_EXIT_QUALITY
  ) {
    reason = 'EXIT_QUALITY_TOO_LOW';
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
