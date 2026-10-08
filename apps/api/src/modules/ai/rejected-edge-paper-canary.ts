export const REJECTED_EDGE_CANARY_ARTIFACT = 'rejected-edge-paper-canary-v1';
export const REJECTED_EDGE_CANARY_MIN_GLOBAL_SAMPLES = 15;
export const REJECTED_EDGE_CANARY_MIN_GLOBAL_POSITIVE_FRACTION = 0.7;
export const REJECTED_EDGE_CANARY_MIN_GLOBAL_AVG_R = 0.5;
export const REJECTED_EDGE_CANARY_MIN_PAIR_SIDE_SAMPLES = 2;
export const REJECTED_EDGE_CANARY_MIN_PAIR_SIDE_POSITIVE_FRACTION = 0.5;
export const REJECTED_EDGE_CANARY_MIN_PAIR_SIDE_AVG_R = 0.2;
export const REJECTED_EDGE_CANARY_MIN_NET_EXPECTED_R = 0.12;
export const REJECTED_EDGE_CANARY_MIN_CONFIDENCE = 0.6;
export const REJECTED_EDGE_CANARY_MIN_PORTFOLIO_QUALITY = 0.35;

export interface RejectedEdgeOutcomeEvidence {
  samples: number;
  positive: number;
  avgR: number;
  minR: number;
  maxR: number;
}

export interface RejectedEdgeCanaryEvidence {
  global30m: RejectedEdgeOutcomeEvidence;
  pairSide30m: RejectedEdgeOutcomeEvidence;
}

export interface RejectedEdgeCanaryCandidate {
  confidence: number;
  netExpectedR: number;
  executionSpreadEvidenceValid: boolean;
  eventRisk: string;
  portfolioQuality: number;
  strategyRoute: string;
  paperExecutionBlockers: string[];
}

export interface RejectedEdgeCanaryDecision {
  eligible: boolean;
  route: 'REJECTED_EDGE_CANARY';
  artifact: typeof REJECTED_EDGE_CANARY_ARTIFACT;
  reason: string;
}

export type RejectedEdgeCanaryEvaluationState =
  | 'NORMAL_PAPER_EXECUTION'
  | 'EVIDENCE_SERVICE_UNAVAILABLE'
  | 'NET_EXPECTED_R_INVALID'
  | 'NET_EXPECTED_R_BELOW_FLOOR'
  | 'EVALUATED';

export function rejectedEdgeCanaryEvaluationState(input: {
  normalPaperExecution: boolean;
  evidenceServiceAvailable: boolean;
  netExpectedR: number;
}): RejectedEdgeCanaryEvaluationState {
  if (input.normalPaperExecution) return 'NORMAL_PAPER_EXECUTION';
  if (!input.evidenceServiceAvailable) return 'EVIDENCE_SERVICE_UNAVAILABLE';
  if (!Number.isFinite(input.netExpectedR)) return 'NET_EXPECTED_R_INVALID';
  if (input.netExpectedR < REJECTED_EDGE_CANARY_MIN_NET_EXPECTED_R) {
    return 'NET_EXPECTED_R_BELOW_FLOOR';
  }
  return 'EVALUATED';
}

const ALLOWED_RESEARCH_BLOCKERS = new Set([
  'ENSEMBLE_NOT_PAPER_ADMITTED',
  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
  'DRIFT_OUT_OF_DISTRIBUTION',
  'DRIFT_STRESSED',
]);

function evidencePasses(
  evidence: RejectedEdgeOutcomeEvidence,
  minSamples: number,
  minPositiveFraction: number,
  minAvgR: number,
): boolean {
  return (
    Number.isFinite(evidence.samples) &&
    evidence.samples >= minSamples &&
    Number.isFinite(evidence.positive) &&
    evidence.positive / evidence.samples >= minPositiveFraction &&
    Number.isFinite(evidence.avgR) &&
    evidence.avgR >= minAvgR
  );
}

export function evaluateRejectedEdgePaperCanary(input: {
  candidate: RejectedEdgeCanaryCandidate;
  evidence: RejectedEdgeCanaryEvidence;
}): RejectedEdgeCanaryDecision {
  const reject = (reason: string): RejectedEdgeCanaryDecision => ({
    eligible: false,
    route: 'REJECTED_EDGE_CANARY',
    artifact: REJECTED_EDGE_CANARY_ARTIFACT,
    reason,
  });

  const { candidate, evidence } = input;
  if (candidate.strategyRoute !== 'TREND_CONTINUATION') return reject('ROUTE_NOT_VALIDATED');
  if (!candidate.executionSpreadEvidenceValid) return reject('SPREAD_EVIDENCE_INVALID');
  if (candidate.eventRisk !== 'CLEAR') return reject('EVENT_RISK_NOT_CLEAR');
  if (candidate.portfolioQuality < REJECTED_EDGE_CANARY_MIN_PORTFOLIO_QUALITY) {
    return reject('PORTFOLIO_QUALITY');
  }
  if (candidate.confidence < REJECTED_EDGE_CANARY_MIN_CONFIDENCE) return reject('CONFIDENCE');
  if (candidate.netExpectedR < REJECTED_EDGE_CANARY_MIN_NET_EXPECTED_R) {
    return reject('NET_EXPECTED_R');
  }
  if (
    candidate.paperExecutionBlockers.length === 0 ||
    candidate.paperExecutionBlockers.some((blocker) => !ALLOWED_RESEARCH_BLOCKERS.has(blocker))
  ) {
    return reject('UNSAFE_BLOCKER');
  }
  if (
    !evidencePasses(
      evidence.global30m,
      REJECTED_EDGE_CANARY_MIN_GLOBAL_SAMPLES,
      REJECTED_EDGE_CANARY_MIN_GLOBAL_POSITIVE_FRACTION,
      REJECTED_EDGE_CANARY_MIN_GLOBAL_AVG_R,
    )
  ) {
    return reject('GLOBAL_EVIDENCE');
  }
  if (
    !evidencePasses(
      evidence.pairSide30m,
      REJECTED_EDGE_CANARY_MIN_PAIR_SIDE_SAMPLES,
      REJECTED_EDGE_CANARY_MIN_PAIR_SIDE_POSITIVE_FRACTION,
      REJECTED_EDGE_CANARY_MIN_PAIR_SIDE_AVG_R,
    )
  ) {
    return reject('PAIR_SIDE_EVIDENCE');
  }

  return {
    eligible: true,
    route: 'REJECTED_EDGE_CANARY',
    artifact: REJECTED_EDGE_CANARY_ARTIFACT,
    reason: 'EVIDENCE_QUALIFIED',
  };
}
