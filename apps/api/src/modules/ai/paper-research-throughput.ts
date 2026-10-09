export const PAPER_RESEARCH_THROUGHPUT_ARTIFACT =
  'paper-research-throughput-v4-pair-side-reliability';
export const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS = Object.freeze([
  'paper-research-throughput-v3-episode-guarded',
  PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
]);
export const PAPER_RESEARCH_THROUGHPUT_LOT_CAP = 0.01;
export const PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R = 0.08;
export const PAPER_RESEARCH_THROUGHPUT_MIN_CONFIDENCE = 0.64;
export const PAPER_RESEARCH_THROUGHPUT_MIN_DIRECTION_QUALITY = 0.55;
export const PAPER_RESEARCH_THROUGHPUT_MIN_TRADE_QUALITY = 0.48;
export const PAPER_RESEARCH_THROUGHPUT_MIN_EXIT_QUALITY = 0.48;

export const PAPER_RESEARCH_THROUGHPUT_EPISODE_COOLDOWN_MINUTES = 30;

export const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES = 5;
const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_WINS = 1;
const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_LOSSES = 1;
const PAPER_RESEARCH_THROUGHPUT_TARGET_R_MULTIPLE = 2.5 / 1.5;

export interface PaperResearchPairSideReliabilityInput {
  wins: number;
  losses: number;
}

export interface PaperResearchPairSideReliabilityDecision {
  eligible: boolean;
  samples: number;
  wins: number;
  losses: number;
  smoothedWinRate: number;
  smoothedExpectedR: number;
  reason:
    | 'INSUFFICIENT_EVIDENCE'
    | 'POSITIVE_PAIR_SIDE_EXPECTANCY'
    | 'NEGATIVE_PAIR_SIDE_EXPECTANCY'
    | 'INVALID_EVIDENCE';
}

export function evaluatePaperResearchPairSideReliability(
  input: PaperResearchPairSideReliabilityInput,
): PaperResearchPairSideReliabilityDecision {
  const wins = input.wins;
  const losses = input.losses;
  const valid = Number.isInteger(wins) && Number.isInteger(losses) && wins >= 0 && losses >= 0;
  if (!valid) {
    return {
      eligible: false,
      samples: 0,
      wins: 0,
      losses: 0,
      smoothedWinRate: 0,
      smoothedExpectedR: -1,
      reason: 'INVALID_EVIDENCE',
    };
  }

  const samples = wins + losses;
  const smoothedWinRate =
    (wins + PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_WINS) /
    (samples +
      PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_WINS +
      PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_LOSSES);
  const smoothedExpectedR =
    smoothedWinRate * PAPER_RESEARCH_THROUGHPUT_TARGET_R_MULTIPLE - (1 - smoothedWinRate);

  if (samples < PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES) {
    return {
      eligible: true,
      samples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      reason: 'INSUFFICIENT_EVIDENCE',
    };
  }

  const eligible = smoothedExpectedR > 0;
  return {
    eligible,
    samples,
    wins,
    losses,
    smoothedWinRate,
    smoothedExpectedR,
    reason: eligible ? 'POSITIVE_PAIR_SIDE_EXPECTANCY' : 'NEGATIVE_PAIR_SIDE_EXPECTANCY',
  };
}

export function paperResearchThroughputModelVersion(engineCode: string): string {
  return `external-provider/${engineCode}/${PAPER_RESEARCH_THROUGHPUT_ARTIFACT}`;
}

export type PaperExecutionRoute =
  | 'NORMAL_PAPER'
  | 'REJECTED_EDGE_CANARY'
  | 'PAPER_RESEARCH_THROUGHPUT'
  | 'NONE';

export function selectPaperExecutionRoute(input: {
  normalPaperExecution: boolean;
  rejectedEdgeCanaryEligible: boolean;
  paperResearchExecutionEligible: boolean;
}): PaperExecutionRoute {
  if (input.normalPaperExecution) return 'NORMAL_PAPER';
  if (input.rejectedEdgeCanaryEligible) return 'REJECTED_EDGE_CANARY';
  if (input.paperResearchExecutionEligible) return 'PAPER_RESEARCH_THROUGHPUT';
  return 'NONE';
}

export interface PaperResearchEpisodeGuardInput {
  currentEpisodeKey: string;
  previousEpisodeKey: string | null;
  previousTradeStatus: string | null;
  previousClosedAt: Date | null;
  evaluatedAt: Date;
}

export interface PaperResearchEpisodeGuardDecision {
  eligible: boolean;
  reason:
    | 'NEW_EPISODE'
    | 'ACTIVE_RESEARCH_SAMPLE'
    | 'EPISODE_CHANGED'
    | 'EPISODE_COOLDOWN'
    | 'EPISODE_COOLDOWN_ELAPSED'
    | 'TERMINAL_RESEARCH_SAMPLE'
    | 'EPISODE_STATE_INVALID';
}

export function evaluatePaperResearchEpisodeGuard(
  input: PaperResearchEpisodeGuardInput,
): PaperResearchEpisodeGuardDecision {
  const evaluatedAtMs = input.evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedAtMs)) {
    return { eligible: false, reason: 'EPISODE_STATE_INVALID' };
  }

  if (!input.previousTradeStatus && !input.previousEpisodeKey && !input.previousClosedAt) {
    return { eligible: true, reason: 'NEW_EPISODE' };
  }

  if (input.previousTradeStatus === 'REJECTED' || input.previousTradeStatus === 'CANCELLED') {
    return { eligible: true, reason: 'TERMINAL_RESEARCH_SAMPLE' };
  }

  if (input.previousTradeStatus !== 'CLOSED') {
    return { eligible: false, reason: 'ACTIVE_RESEARCH_SAMPLE' };
  }

  if (
    input.previousEpisodeKey &&
    input.currentEpisodeKey &&
    input.previousEpisodeKey !== input.currentEpisodeKey
  ) {
    return { eligible: true, reason: 'EPISODE_CHANGED' };
  }

  const closedAtMs = input.previousClosedAt?.getTime() ?? Number.NaN;
  if (!Number.isFinite(closedAtMs) || closedAtMs > evaluatedAtMs) {
    return { eligible: false, reason: 'EPISODE_STATE_INVALID' };
  }

  const elapsedMinutes = (evaluatedAtMs - closedAtMs) / 60_000;
  if (elapsedMinutes < PAPER_RESEARCH_THROUGHPUT_EPISODE_COOLDOWN_MINUTES) {
    return { eligible: false, reason: 'EPISODE_COOLDOWN' };
  }

  return { eligible: true, reason: 'EPISODE_COOLDOWN_ELAPSED' };
}

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
