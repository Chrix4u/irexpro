import {
  REJECTED_EDGE_CANARY_MAX_ALIGNED_MOMENTUM_ATR,
  REJECTED_EDGE_CANARY_MIN_ALIGNED_MOMENTUM_ATR,
} from './rejected-edge-paper-canary';

export const PAPER_RESEARCH_THROUGHPUT_ARTIFACT =
  'paper-research-throughput-v11-momentum-confirmed-exploration';
export const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS = Object.freeze([
  'paper-research-throughput-v2-episode-guarded',
  'paper-research-throughput-v3-episode-guarded',
  'paper-research-throughput-v4-pair-side-reliability',
  'paper-research-throughput-v5-controlled-execution',
  'paper-research-throughput-v6-controlled-exploration',
  'paper-research-throughput-v7-edge-tiered-exploration',
  'paper-research-throughput-v8-momentum-confirmed-exploration',
  'paper-research-throughput-v9-bounded-mtf-exploration',
  'paper-research-throughput-v10-evidence-backed-acceleration',
  PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
]);
export const PAPER_RESEARCH_THROUGHPUT_LOT_CAP = 1.0;
export const REJECTED_EDGE_CANARY_EXECUTION_ENABLED = false;
export const PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R = 0.08;
export const PAPER_RESEARCH_THROUGHPUT_MIN_CONFIDENCE = 0.64;
export const PAPER_RESEARCH_THROUGHPUT_MIN_DIRECTION_QUALITY = 0.25;
export const PAPER_RESEARCH_THROUGHPUT_MIN_TRADE_QUALITY = 0.48;
export const PAPER_RESEARCH_THROUGHPUT_MIN_EXIT_QUALITY = 0.48;
export const PAPER_RESEARCH_EXPLORATION_MIN_CONFIDENCE = 0.6;
export const PAPER_RESEARCH_EXPLORATION_MIN_DIRECTION_QUALITY = 0.1;
export const PAPER_RESEARCH_EXPLORATION_MIN_TRADE_QUALITY = 0.35;
export const PAPER_RESEARCH_EXPLORATION_MIN_EXIT_QUALITY = 0.35;
export const PAPER_RESEARCH_EXPLORATION_STRONG_NET_EXPECTED_R = 0.12;
export const PAPER_RESEARCH_EXPLORATION_STRONG_MIN_DIRECTION_QUALITY = 0.05;
export const PAPER_RESEARCH_EXPLORATION_STRONG_MIN_TRADE_QUALITY = 0.3;
export const PAPER_RESEARCH_EXPLORATION_STRONG_MIN_EXIT_QUALITY = 0.3;
export const PAPER_RESEARCH_BOUNDED_MTF_MIN_CONFIDENCE = 0.64;
export const PAPER_RESEARCH_BOUNDED_MTF_MIN_DIRECTION_QUALITY = 0.15;
export const PAPER_RESEARCH_BOUNDED_MTF_MIN_TRADE_QUALITY = 0.2;
export const PAPER_RESEARCH_BOUNDED_MTF_MIN_EXIT_QUALITY = 0.2;

export const PAPER_PAIRED_REVERSAL_RESEARCH_ARTIFACT = 'paper-paired-reversal-research-v1';
export const PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP = 1.0;
export const PAPER_PAIRED_REVERSAL_RESEARCH_MIN_NET_EXPECTED_R = 0.08;

export const PAPER_RESEARCH_THROUGHPUT_EPISODE_COOLDOWN_MINUTES = 30;

export const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES = 5;
export const PAPER_RESEARCH_THROUGHPUT_EARLY_LOSS_BRAKE_SAMPLES = 3;
export const PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_SAMPLES = 3;
export const PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_EXPECTED_R = 0.25;
export const PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_DIRECTION_QUALITY = 0.05;
export const PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_TRADE_QUALITY = 0.2;
export const PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_EXIT_QUALITY = 0.2;
const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_WINS = 1;
const PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_LOSSES = 1;
const PAPER_RESEARCH_THROUGHPUT_TARGET_R_MULTIPLE = 2.5 / 1.5;

export interface PaperResearchPairSideReliabilityInput {
  wins: number;
  losses: number;
  /** Optional unitless realised-R evidence from closed trade geometry. */
  realisedRSamples?: number;
  realisedRSum?: number;
}

export interface PaperResearchPairSideReliabilityDecision {
  eligible: boolean;
  samples: number;
  wins: number;
  losses: number;
  smoothedWinRate: number;
  smoothedExpectedR: number;
  realisedRSamples: number;
  realisedAverageR: number | null;
  reason:
    | 'INSUFFICIENT_EVIDENCE'
    | 'POSITIVE_PAIR_SIDE_EXPECTANCY'
    | 'NEGATIVE_PAIR_SIDE_EXPECTANCY'
    | 'NEGATIVE_REALISED_PAIR_SIDE_EXPECTANCY'
    | 'EARLY_LOSS_STREAK'
    | 'INVALID_EVIDENCE';
}

export function evaluatePaperResearchPairSideReliability(
  input: PaperResearchPairSideReliabilityInput,
): PaperResearchPairSideReliabilityDecision {
  const wins = input.wins;
  const losses = input.losses;
  const samples = Number.isInteger(wins) && Number.isInteger(losses) ? wins + losses : 0;
  const hasRealisedREvidence =
    input.realisedRSamples !== undefined || input.realisedRSum !== undefined;
  const realisedRSamples = input.realisedRSamples ?? 0;
  const realisedRSum = input.realisedRSum ?? 0;
  const realisedEvidenceValid =
    !hasRealisedREvidence ||
    (Number.isInteger(realisedRSamples) &&
      realisedRSamples >= 0 &&
      realisedRSamples <= samples &&
      Number.isFinite(realisedRSum));
  const valid =
    Number.isInteger(wins) &&
    Number.isInteger(losses) &&
    wins >= 0 &&
    losses >= 0 &&
    realisedEvidenceValid;
  const realisedAverageR = valid && realisedRSamples > 0 ? realisedRSum / realisedRSamples : null;

  if (!valid) {
    return {
      eligible: false,
      samples: 0,
      wins: 0,
      losses: 0,
      smoothedWinRate: 0,
      smoothedExpectedR: -1,
      realisedRSamples: 0,
      realisedAverageR: null,
      reason: 'INVALID_EVIDENCE',
    };
  }

  const smoothedWinRate =
    (wins + PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_WINS) /
    (samples +
      PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_WINS +
      PAPER_RESEARCH_THROUGHPUT_RELIABILITY_PRIOR_LOSSES);
  const smoothedExpectedR =
    smoothedWinRate * PAPER_RESEARCH_THROUGHPUT_TARGET_R_MULTIPLE - (1 - smoothedWinRate);

  if (
    samples >= PAPER_RESEARCH_THROUGHPUT_EARLY_LOSS_BRAKE_SAMPLES &&
    wins === 0 &&
    losses >= PAPER_RESEARCH_THROUGHPUT_EARLY_LOSS_BRAKE_SAMPLES
  ) {
    return {
      eligible: false,
      samples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realisedRSamples,
      realisedAverageR,
      reason: 'EARLY_LOSS_STREAK',
    };
  }

  if (samples < PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES) {
    return {
      eligible: true,
      samples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realisedRSamples,
      realisedAverageR,
      reason: 'INSUFFICIENT_EVIDENCE',
    };
  }

  // Win/loss counts assume the design target payoff (2.5R / 1.5R). Once at
  // least five closed trades carry trustworthy price geometry, observed
  // realised-R becomes an additional fail-closed requirement. This prevents
  // profit-protection exits from making the binary win rate look healthy while
  // actual winners are much smaller than full-stop losses.
  if (
    realisedRSamples >= PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES &&
    realisedAverageR !== null &&
    realisedAverageR <= 0
  ) {
    return {
      eligible: false,
      samples,
      wins,
      losses,
      smoothedWinRate,
      smoothedExpectedR,
      realisedRSamples,
      realisedAverageR,
      reason: 'NEGATIVE_REALISED_PAIR_SIDE_EXPECTANCY',
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
    realisedRSamples,
    realisedAverageR,
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
  | 'PAIRED_REVERSAL_RESEARCH'
  | 'NONE';

export function selectPaperExecutionRoute(input: {
  normalPaperExecution: boolean;
  rejectedEdgeCanaryEligible: boolean;
  rejectedEdgeCanaryExecutionEnabled?: boolean;
  paperResearchThroughputEligible: boolean;
  pairedReversalResearchEligible?: boolean;
}): PaperExecutionRoute {
  if (input.normalPaperExecution) return 'NORMAL_PAPER';
  const canaryExecutionEnabled =
    input.rejectedEdgeCanaryExecutionEnabled ?? REJECTED_EDGE_CANARY_EXECUTION_ENABLED;
  if (canaryExecutionEnabled && input.rejectedEdgeCanaryEligible) return 'REJECTED_EDGE_CANARY';
  if (input.paperResearchThroughputEligible) return 'PAPER_RESEARCH_THROUGHPUT';
  if (input.pairedReversalResearchEligible) return 'PAIRED_REVERSAL_RESEARCH';
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

const ALLOWED_RESEARCH_EXPLORATION_BLOCKERS = new Set([
  ...ALLOWED_RESEARCH_BLOCKERS,
  'DRIFT_STRESSED',
  'DRIFT_OUT_OF_DISTRIBUTION',
]);

export interface PaperResearchThroughputInput {
  normalPaperExecution: boolean;
  confidence: number;
  netExpectedR: number;
  executionSpreadEvidenceValid: boolean;
  paperExecutionCostUsable?: boolean;
  eventRisk: string;
  strategyRoute: string;
  driftState: string;
  driftDiagnostics?: string[];
  directionQuality: number;
  /** Direction-aligned short-horizon momentum in ATR units; positive supports the candidate. */
  alignedMomentumAtr?: number;
  tradeQuality: number;
  exitQuality: number;
  paperExecutionBlockers: string[];
  routeReliabilityDemoted?: boolean;
  pairSideReliability?: PaperResearchPairSideReliabilityDecision;
}

export interface PaperResearchThroughputDecision {
  eligible: boolean;
  artifact: typeof PAPER_RESEARCH_THROUGHPUT_ARTIFACT;
  route: 'PAPER_RESEARCH_THROUGHPUT';
  reason: string;
  qualificationEvidence: false;
  executionAuthority: 'PAPER_ONLY_RESEARCH';
}

export function evaluatePaperResearchThroughput(
  input: PaperResearchThroughputInput,
): PaperResearchThroughputDecision {
  if (input.normalPaperExecution) {
    return {
      eligible: false,
      artifact: PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
      route: 'PAPER_RESEARCH_THROUGHPUT',
      reason: 'NORMAL_PAPER_EXECUTION',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    };
  }

  const costUsable = input.paperExecutionCostUsable ?? input.executionSpreadEvidenceValid;
  const strictBlockersSafe =
    (input.routeReliabilityDemoted || input.paperExecutionBlockers.length > 0) &&
    input.paperExecutionBlockers.every((blocker) => ALLOWED_RESEARCH_BLOCKERS.has(blocker));
  const strictEligible =
    input.strategyRoute === 'TREND_CONTINUATION' &&
    Number.isFinite(input.confidence) &&
    input.confidence >= PAPER_RESEARCH_THROUGHPUT_MIN_CONFIDENCE &&
    input.driftState === 'NORMAL' &&
    Number.isFinite(input.directionQuality) &&
    input.directionQuality >= PAPER_RESEARCH_THROUGHPUT_MIN_DIRECTION_QUALITY &&
    Number.isFinite(input.tradeQuality) &&
    input.tradeQuality >= PAPER_RESEARCH_THROUGHPUT_MIN_TRADE_QUALITY &&
    Number.isFinite(input.exitQuality) &&
    input.exitQuality >= PAPER_RESEARCH_THROUGHPUT_MIN_EXIT_QUALITY &&
    costUsable &&
    input.eventRisk === 'CLEAR' &&
    Number.isFinite(input.netExpectedR) &&
    input.netExpectedR >= PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R &&
    strictBlockersSafe;

  if (strictEligible) {
    return {
      eligible: true,
      artifact: PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
      route: 'PAPER_RESEARCH_THROUGHPUT',
      reason: 'RESEARCH_EVIDENCE_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    };
  }

  const boundedSingleMtfDriftResearch =
    input.strategyRoute === 'TREND_CONTINUATION' &&
    Number.isFinite(input.confidence) &&
    input.confidence >= PAPER_RESEARCH_BOUNDED_MTF_MIN_CONFIDENCE &&
    input.driftState === 'OUT_OF_DISTRIBUTION' &&
    Array.isArray(input.driftDiagnostics) &&
    input.driftDiagnostics.length === 1 &&
    input.driftDiagnostics[0] === 'mtfStrength:HARD_LOW' &&
    Number.isFinite(input.directionQuality) &&
    input.directionQuality >= PAPER_RESEARCH_BOUNDED_MTF_MIN_DIRECTION_QUALITY &&
    Number.isFinite(input.tradeQuality) &&
    input.tradeQuality >= PAPER_RESEARCH_BOUNDED_MTF_MIN_TRADE_QUALITY &&
    Number.isFinite(input.exitQuality) &&
    input.exitQuality >= PAPER_RESEARCH_BOUNDED_MTF_MIN_EXIT_QUALITY &&
    Number.isFinite(input.alignedMomentumAtr) &&
    input.alignedMomentumAtr! >= REJECTED_EDGE_CANARY_MIN_ALIGNED_MOMENTUM_ATR &&
    input.alignedMomentumAtr! <= REJECTED_EDGE_CANARY_MAX_ALIGNED_MOMENTUM_ATR &&
    costUsable &&
    input.eventRisk === 'CLEAR' &&
    Number.isFinite(input.netExpectedR) &&
    input.netExpectedR >= PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R &&
    input.paperExecutionBlockers.length > 0 &&
    input.paperExecutionBlockers.every((blocker) =>
      ALLOWED_RESEARCH_EXPLORATION_BLOCKERS.has(blocker),
    );

  if (boundedSingleMtfDriftResearch) {
    return {
      eligible: true,
      artifact: PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
      route: 'PAPER_RESEARCH_THROUGHPUT',
      reason: 'BOUNDED_MTF_RESEARCH_CANDIDATE',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    };
  }

  const strongEdgeExploration =
    Number.isFinite(input.netExpectedR) &&
    input.netExpectedR >= PAPER_RESEARCH_EXPLORATION_STRONG_NET_EXPECTED_R;
  const explorationDirectionFloor = strongEdgeExploration
    ? PAPER_RESEARCH_EXPLORATION_STRONG_MIN_DIRECTION_QUALITY
    : PAPER_RESEARCH_EXPLORATION_MIN_DIRECTION_QUALITY;
  const explorationTradeFloor = strongEdgeExploration
    ? PAPER_RESEARCH_EXPLORATION_STRONG_MIN_TRADE_QUALITY
    : PAPER_RESEARCH_EXPLORATION_MIN_TRADE_QUALITY;
  const alignedMomentumConfirmsDirection =
    Number.isFinite(input.alignedMomentumAtr) &&
    input.alignedMomentumAtr! >= REJECTED_EDGE_CANARY_MIN_ALIGNED_MOMENTUM_ATR &&
    input.alignedMomentumAtr! <= REJECTED_EDGE_CANARY_MAX_ALIGNED_MOMENTUM_ATR;
  const explorationExitFloor = strongEdgeExploration
    ? PAPER_RESEARCH_EXPLORATION_STRONG_MIN_EXIT_QUALITY
    : PAPER_RESEARCH_EXPLORATION_MIN_EXIT_QUALITY;

  let reason = 'RESEARCH_EXPLORATION_CANDIDATE';
  if (input.strategyRoute !== 'TREND_CONTINUATION') {
    reason = 'ROUTE_NOT_VALIDATED';
  } else if (
    !Number.isFinite(input.confidence) ||
    input.confidence < PAPER_RESEARCH_EXPLORATION_MIN_CONFIDENCE
  ) {
    reason = 'CONFIDENCE_TOO_LOW';
  } else if (
    (!Number.isFinite(input.directionQuality) ||
      input.directionQuality < explorationDirectionFloor) &&
    !alignedMomentumConfirmsDirection
  ) {
    reason = 'DIRECTION_QUALITY_TOO_LOW';
  } else if (!Number.isFinite(input.tradeQuality) || input.tradeQuality < explorationTradeFloor) {
    reason = 'TRADE_QUALITY_TOO_LOW';
  } else if (!Number.isFinite(input.exitQuality) || input.exitQuality < explorationExitFloor) {
    reason = 'EXIT_QUALITY_TOO_LOW';
  } else if (!costUsable) {
    reason = 'SPREAD_EVIDENCE_INVALID';
  } else if (input.eventRisk !== 'CLEAR') {
    reason = 'EVENT_RISK_NOT_CLEAR';
  } else if (!Number.isFinite(input.netExpectedR)) {
    reason = 'NET_EXPECTED_R_INVALID';
  } else if (input.netExpectedR < PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R) {
    reason = 'NET_EXPECTED_R_TOO_LOW';
  } else if (
    (!input.routeReliabilityDemoted && input.paperExecutionBlockers.length === 0) ||
    input.paperExecutionBlockers.some(
      (blocker) => !ALLOWED_RESEARCH_EXPLORATION_BLOCKERS.has(blocker),
    )
  ) {
    reason = 'UNSAFE_BLOCKER';
  } else if (!alignedMomentumConfirmsDirection) {
    reason = 'MOMENTUM_NOT_CONFIRMED';
  }

  const accelerationReliability = input.pairSideReliability;
  const qualityLimited =
    reason === 'DIRECTION_QUALITY_TOO_LOW' ||
    reason === 'TRADE_QUALITY_TOO_LOW' ||
    reason === 'EXIT_QUALITY_TOO_LOW';
  const evidenceBackedPairSideAccelerationStructure =
    qualityLimited &&
    Boolean(accelerationReliability?.eligible) &&
    (accelerationReliability?.samples ?? 0) >= PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_SAMPLES &&
    (accelerationReliability?.smoothedExpectedR ?? Number.NEGATIVE_INFINITY) >=
      PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_EXPECTED_R &&
    input.strategyRoute === 'TREND_CONTINUATION' &&
    Number.isFinite(input.confidence) &&
    input.confidence >= PAPER_RESEARCH_EXPLORATION_MIN_CONFIDENCE &&
    Number.isFinite(input.netExpectedR) &&
    input.netExpectedR >= PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R &&
    Number.isFinite(input.directionQuality) &&
    input.directionQuality >= PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_DIRECTION_QUALITY &&
    Number.isFinite(input.tradeQuality) &&
    input.tradeQuality >= PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_TRADE_QUALITY &&
    Number.isFinite(input.exitQuality) &&
    input.exitQuality >= PAPER_RESEARCH_EVIDENCE_ACCELERATION_MIN_EXIT_QUALITY &&
    (input.driftState === 'NORMAL' || input.driftState === 'OUT_OF_DISTRIBUTION') &&
    costUsable &&
    input.eventRisk === 'CLEAR' &&
    input.paperExecutionBlockers.length > 0 &&
    input.paperExecutionBlockers.every((blocker) =>
      ALLOWED_RESEARCH_EXPLORATION_BLOCKERS.has(blocker),
    );
  const evidenceBackedPairSideAcceleration =
    evidenceBackedPairSideAccelerationStructure && alignedMomentumConfirmsDirection;

  if (evidenceBackedPairSideAcceleration) {
    return {
      eligible: true,
      artifact: PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
      route: 'PAPER_RESEARCH_THROUGHPUT',
      reason: 'EVIDENCE_BACKED_PAIR_SIDE_ACCELERATION',
      qualificationEvidence: false,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
    };
  }

  if (evidenceBackedPairSideAccelerationStructure && !alignedMomentumConfirmsDirection) {
    reason = 'MOMENTUM_NOT_CONFIRMED';
  }

  return {
    eligible: reason === 'RESEARCH_EXPLORATION_CANDIDATE',
    artifact: PAPER_RESEARCH_THROUGHPUT_ARTIFACT,
    route: 'PAPER_RESEARCH_THROUGHPUT',
    reason,
    qualificationEvidence: false,
    executionAuthority: 'PAPER_ONLY_RESEARCH',
  };
}

export interface PaperPairedReversalResearchInput {
  candidateDirection: 'BUY' | 'SELL';
  preferredDirection: 'BUY' | 'SELL' | null;
  reversalCandidate: boolean;
  researchNetExpectedR: number;
  executionSpreadEvidenceValid: boolean;
  paperExecutionCostUsable?: boolean;
  eventRisk: string;
  driftState: string;
}

export interface PaperPairedReversalResearchDecision {
  eligible: boolean;
  route: 'PAIRED_REVERSAL_RESEARCH';
  reason:
    | 'PAIRED_REVERSAL_RESEARCH_CANDIDATE'
    | 'PAIRED_REVERSAL_NOT_CONFIRMED'
    | 'PAIRED_DIRECTION_NOT_SELECTED'
    | 'SPREAD_EVIDENCE_INVALID'
    | 'EVENT_RISK_NOT_CLEAR'
    | 'DRIFT_OUT_OF_DISTRIBUTION'
    | 'DRIFT_INVALID'
    | 'NET_EXPECTED_R_INVALID'
    | 'NET_EXPECTED_R_TOO_LOW';
  qualificationEvidence: false;
  executionAuthority: 'PAPER_ONLY_RESEARCH';
  lotCap: typeof PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP;
}

export function evaluatePaperPairedReversalResearch(
  input: PaperPairedReversalResearchInput,
): PaperPairedReversalResearchDecision {
  let reason: PaperPairedReversalResearchDecision['reason'] = 'PAIRED_REVERSAL_RESEARCH_CANDIDATE';

  if (!input.reversalCandidate) {
    reason = 'PAIRED_REVERSAL_NOT_CONFIRMED';
  } else if (!input.preferredDirection || input.preferredDirection !== input.candidateDirection) {
    reason = 'PAIRED_DIRECTION_NOT_SELECTED';
  } else if (!(input.paperExecutionCostUsable ?? input.executionSpreadEvidenceValid)) {
    reason = 'SPREAD_EVIDENCE_INVALID';
  } else if (input.eventRisk !== 'CLEAR') {
    reason = 'EVENT_RISK_NOT_CLEAR';
  } else if (input.driftState === 'OUT_OF_DISTRIBUTION') {
    reason = 'DRIFT_OUT_OF_DISTRIBUTION';
  } else if (input.driftState !== 'NORMAL' && input.driftState !== 'STRESSED') {
    reason = 'DRIFT_INVALID';
  } else if (!Number.isFinite(input.researchNetExpectedR)) {
    reason = 'NET_EXPECTED_R_INVALID';
  } else if (input.researchNetExpectedR < PAPER_PAIRED_REVERSAL_RESEARCH_MIN_NET_EXPECTED_R) {
    reason = 'NET_EXPECTED_R_TOO_LOW';
  }

  return {
    eligible: reason === 'PAIRED_REVERSAL_RESEARCH_CANDIDATE',
    route: 'PAIRED_REVERSAL_RESEARCH',
    reason,
    qualificationEvidence: false,
    executionAuthority: 'PAPER_ONLY_RESEARCH',
    lotCap: PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP,
  };
}
