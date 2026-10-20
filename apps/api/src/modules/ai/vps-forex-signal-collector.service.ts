import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { v5 as uuidv5 } from 'uuid';
import { AiSignalService } from './ai-signal.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { SIGNAL_MAX_AGE_MS } from '../execution/orchestration/signal-identity.gate';
import { BrokerService } from '../broker/broker.service';
import { BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import {
  LivePaperCandleInput,
  LivePaperMarketDataService,
} from '../broker/services/live-paper-market-data.service';
import { PAPER_MARKET_SPECS } from '../broker/services/paper-market-spec';
import {
  PLAN_B_SHADOW_ADMISSION_THRESHOLD,
  scorePlanBShadowMeta,
  scoreV8ShadowMeta,
} from './v8-shadow-meta-scorer';
import {
  PLAN_B_ACTIVE_MODEL_POLICY_VERSION,
  PLAN_B_PREDICTION_CALIBRATION_EVIDENCE_POLICY_VERSIONS,
  PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS,
  PLAN_B_ENSEMBLE_ARTIFACT,
  PLAN_B_GROSS_EXPECTED_R_FLOOR,
  PlanBEnsembleScore,
  PlanBPortfolioPosition,
  scorePlanBMultimodelShadow,
} from './plan-b-multimodel-shadow';
import {
  ENSEMBLE_NET_EXPECTED_R_FLOOR,
  ENSEMBLE_PAPER_NET_EXPECTED_R_FLOOR,
  ENSEMBLE_SLEEVE_CORE_MIN_CLOSED_TRADES,
  EnsembleSleeveEvidence,
  EnsembleGovernanceDecision,
  ExecutionSpreadEvidence,
  classifyEnsembleSleeveEvidence,
  evaluateEnsembleGovernance,
} from './ensemble-governance';
import { MacroEventRiskAssessment, MacroEventRiskService } from './macro-event-risk.service';
import {
  ENSEMBLE_OUTCOME_MODEL_VERSION,
  EnsembleShadowOutcome,
  collapseEnsembleOutcomeEpisodes,
  resolveEnsembleShadowOutcome,
  summarizeEnsembleSleeveOutcomes,
} from './ensemble-shadow-outcome';
import { buildEnsembleExpertRegistry } from './ensemble-expert-registry';
import {
  PAPER_EXTENSION_EXHAUSTION_RESEARCH_ARTIFACT,
  evaluatePaperExtensionExhaustionResearch,
  scoreExtensionExhaustionShadow,
} from './extension-exhaustion-shadow';
import { scoreTrendPersistenceShadow } from './trend-persistence-shadow';
import {
  PAPER_RESEARCH_THROUGHPUT_LOT_CAP,
  PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R,
  PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES,
  PAPER_RESEARCH_EXPLORATION_MIN_CONFIDENCE,
  PAPER_PAIRED_REVERSAL_RESEARCH_ARTIFACT,
  PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP,
  PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS,
  PaperResearchPairSideReliabilityDecision,
  PaperResearchThroughputDecision,
  evaluatePaperResearchCalibrationBrake,
  evaluatePaperResearchEpisodeGuard,
  evaluatePaperResearchExecutionGate,
  evaluatePaperResearchPortfolioBrake,
  evaluatePaperResearchPairSideReliability,
  evaluatePaperResearchThroughput,
  evaluatePaperPairedReversalResearch,
  paperResearchThroughputModelVersion,
  selectPaperExecutionRoute,
} from './paper-research-throughput';
import {
  evaluateRejectedEdgePaperCanary,
  rejectedEdgeCanaryEvaluationState,
  RejectedEdgeCanaryDecision,
  RejectedEdgeCanaryEvidence,
} from './rejected-edge-paper-canary';
import { EnsemblePostEntryProtectionShadowService } from './ensemble-post-entry-protection-shadow.service';
import { isFxWeeklySessionOpen as isFxWeeklySessionOpenAt } from '../market-data/utils/fx-weekly-session';
import {
  PaperTrendPairSideReliabilityDecision,
  PaperTrendPairSideReliabilityShadowDecision,
  PaperTrendRouteReliabilityDecision,
  evaluatePaperTrendPairSideReliability,
  evaluatePaperTrendPairSideReliabilityShadow,
  evaluatePaperTrendReliabilityExecutionGate,
  evaluatePaperTrendRouteReliability,
} from './paper-route-reliability';
import {
  HighConvictionOverlay,
  HighConvictionOverlayState,
  classifyHighConvictionOverlay,
  summarizeHighConvictionOverlayCohort,
} from './high-conviction-overlay';
import { PAPER_POST_LOSS_STATE_QUERY } from './paper-post-loss-state-query';
import {
  PaperPostLossEntryDecision,
  PaperPostLossEntryState,
  evaluatePaperPostLossEntryGuard,
} from './paper-post-loss-entry-guard';
import {
  PairedDirectionReversalDecision,
  evaluatePairedDirectionReversal,
} from './paired-direction-reversal';
import {
  PaperSpreadCalibrationDecision,
  PaperSpreadCalibrationHistory,
  classifyPaperSpreadSession,
  evaluatePaperSpreadCalibrationShadow,
} from './paper-spread-calibration-shadow';
import {
  PaperCostAwareCohortEvidence,
  PaperCostAwareEntryDecision,
  evaluatePaperCostAwareEntry,
} from './paper-cost-aware-entry';
import {
  PaperCalibratedCostResearchRescueDecision,
  evaluatePaperCalibratedCostResearchRescue,
} from './paper-calibrated-cost-rescue';
import { AllocationService } from '../execution/services/allocation.service';
import {
  paperAllocationRiskTargetPercent,
  type PaperAllocationConfidenceTier,
} from '../execution/services/paper-allocation-sizing-policy';
import { AdaptiveMarketStateDecision, classifyAdaptiveMarketState } from './adaptive-market-state';
import {
  AdaptiveCurrencyExposureDecision,
  AdaptiveCurrencyRiskPosition,
  analyzeAdaptiveCurrencyExposure,
} from './adaptive-currency-exposure';
import {
  AdaptiveEdgeEvidence,
  AdaptiveEdgeMatrixService,
  unavailableAdaptiveEdgeEvidence,
} from './adaptive-edge-matrix.service';
import {
  AdaptiveOpportunityDecision,
  scoreAdaptiveOpportunity,
} from './adaptive-opportunity-score';
import {
  AdaptiveRiskMultiplierDecision,
  selectAdaptiveRiskMultiplier,
} from './adaptive-risk-multiplier';
import {
  AdaptivePredictionCalibrationService,
  applyAdaptivePredictionCalibrationAuthority,
  unavailableAdaptivePredictionCalibration,
  type AdaptivePredictionCalibrationDecision,
} from './adaptive-prediction-calibration.service';
import {
  adaptiveCandidateRiskAtStop,
  adaptiveMarketDataFreshness,
  rankAdaptivePaperScanWinners,
} from './adaptive-paper-authority';

const LEGACY_PROVIDER_CODE = 'vps-twelvedata-six-pair-v7';
const ACTIVE_ENGINE_CODE = 'irexpro-multimodel-ensemble-v1';
const LEGACY_V7_EXECUTION_FROZEN = true;
const MULTI_MODEL_PAPER_EXECUTION_ENABLED = true;

export function canExecuteMultiModelPaper(
  ensemble: Pick<PlanBEnsembleScore, 'paperAdmitted'>,
  governance: Pick<EnsembleGovernanceDecision, 'paperExecutionEligible'>,
): boolean {
  return (
    MULTI_MODEL_PAPER_EXECUTION_ENABLED &&
    ensemble.paperAdmitted &&
    governance.paperExecutionEligible
  );
}
const PROVIDER_CODE = LEGACY_PROVIDER_CODE;
const SIGNAL_NAMESPACE = '802e16f8-8209-4e1f-aa7e-a6a46387081c';
const SYMBOLS = Object.freeze([
  ['EURUSD', 'EUR/USD'],
  ['GBPUSD', 'GBP/USD'],
  ['USDJPY', 'USD/JPY'],
  ['AUDUSD', 'AUD/USD'],
  ['USDCAD', 'USD/CAD'],
  ['USDCHF', 'USD/CHF'],
] as const);
const CONFIDENCE_FLOOR = 0.64;
const COUNTERFACTUAL_MIN_EDGE_R = 0.02;
const COUNTERFACTUAL_COST_UNCERTAINTY_FRACTION = 0.25;
const ACTIVE_MODEL_POLICY_VERSION = PLAN_B_ACTIVE_MODEL_POLICY_VERSION;
const STOP_ATR_MULTIPLIER = 1.5;
const TARGET_ATR_MULTIPLIER = 2.5;
const PAPER_BASE_LOT_UPPER_BOUND = 0.2;
const PAPER_RELIABILITY_STATUS_CACHE_TTL_MS = 30_000;

export interface PaperTrendPairSideReliabilityStatus {
  instrument: string;
  direction: 'BUY' | 'SELL';
  state: PaperTrendPairSideReliabilityDecision['state'];
  episodes: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  positiveWindowFraction: number | null;
  fullSizeEligible: boolean;
  researchFallbackRequested: boolean;
  reason: PaperTrendPairSideReliabilityDecision['reason'];
}

export interface DynamicPaperLotSizingInput {
  confidence: number;
  metaProbability: number;
  netExpectedR: number;
  consensusPassed: number;
  consensusRequired: number;
  volatilityScore: number;
}

export interface DynamicPaperLotSizingDecision {
  upperBound: number;
  tier: 'BASE' | 'STRONG' | 'VERY_STRONG' | 'EXCEPTIONAL';
}

/**
 * PAPER-only confidence/quality ceiling. This never bypasses PositionSizingService:
 * equity risk %, stop distance, profile max lots, broker margin, allocation and
 * portfolio/risk gates can only reduce the final volume below this ceiling.
 * Confidence alone is deliberately insufficient for larger size.
 */
export function dynamicPaperLotUpperBound(
  input: DynamicPaperLotSizingInput,
): DynamicPaperLotSizingDecision {
  const fullConsensus =
    input.consensusRequired > 0 && input.consensusPassed >= input.consensusRequired;

  if (
    fullConsensus &&
    input.confidence >= 0.82 &&
    input.metaProbability >= 0.68 &&
    input.netExpectedR >= 0.4 &&
    input.volatilityScore <= 0.55
  ) {
    return { upperBound: 2.0, tier: 'EXCEPTIONAL' };
  }
  if (
    fullConsensus &&
    input.confidence >= 0.76 &&
    input.metaProbability >= 0.62 &&
    input.netExpectedR >= 0.28 &&
    input.volatilityScore <= 0.65
  ) {
    return { upperBound: 1.0, tier: 'VERY_STRONG' };
  }
  if (
    fullConsensus &&
    input.confidence >= 0.7 &&
    input.metaProbability >= 0.56 &&
    input.netExpectedR >= 0.18 &&
    input.volatilityScore <= 0.75
  ) {
    return { upperBound: 0.5, tier: 'STRONG' };
  }
  return { upperBound: PAPER_BASE_LOT_UPPER_BOUND, tier: 'BASE' };
}
const MIN_STOP_LOSS_PIPS = 5;
const STOP_FLOOR_BUFFER_PIPS = 0.1;
const BAR_MS = 5 * 60_000;
const COLLECTION_CADENCE_MINUTES = 5;
const PAPER_PRE_INTENT_RETRY_SAFE_CODE = 'PAPER_PRE_INTENT_RETRY_SAFE';
const BROKER_FALLBACK_SOURCE_UNAVAILABLE_CODE = 'BROKER_FALLBACK_SOURCE_UNAVAILABLE';
const EXECUTION_SPREAD_WINDOW_MINUTES = 30;
const FRESH_BREAKOUT_ATR = 0.5;
const FRESH_CONFIDENCE_DELTA = 0.02;
const MAX_CONFIDENCE_DECAY_ON_BREAKOUT = 0.015;
const PAPER_ENTRY_MAX_STOP_BUDGET_CONSUMED = 0.25;
const PAPER_ENTRY_FAST_MARK_MAX_AGE_MS = 60_000;

export interface PaperEntryMarketAlignmentInput {
  direction: 'BUY' | 'SELL';
  candidateBarTime: Date;
  evaluatedAt: Date;
  stopLoss: number;
  executionQuote: {
    bid: string;
    ask: string;
    timestamp: Date;
    source: 'REST_M5' | 'STREAM' | 'PROVIDER';
  };
  fastMark: {
    bid: string;
    ask: string;
    timestamp: Date;
    source: 'REST_M5' | 'STREAM' | 'PROVIDER';
    streamProvider?: string;
  };
}

export interface PaperEntryMarketAlignmentDecision {
  eligible: boolean;
  reason:
    | 'ALIGNED'
    | 'STALE_M5_CANDIDATE'
    | 'EXECUTION_SNAPSHOT_MISMATCH'
    | 'FAST_MARK_UNAVAILABLE'
    | 'FAST_MARK_STALE'
    | 'INVALID_ENTRY_GEOMETRY'
    | 'LIVE_STOP_ALREADY_BREACHED'
    | 'ADVERSE_MOVE_CONSUMED_STOP_BUDGET';
  plannedEntry: number | null;
  liveProtectivePrice: number | null;
  plannedStopDistance: number | null;
  remainingStopDistance: number | null;
  stopBudgetConsumedFraction: number | null;
}

/**
 * Final PAPER-only entry sanity check between the closed-M5 decision/fill lane
 * and the fresh fast-mark protection lane.
 *
 * The fast mark is VETO-ONLY: it can reject an already stale/dislocated entry,
 * but it never becomes model evidence, a fill price, sizing authority or a
 * replacement stop/target. That keeps the trained M5 distribution unchanged
 * while preventing a trade from opening with most/all of its stop already
 * consumed in the live market.
 */
export function evaluatePaperEntryMarketAlignment(
  input: PaperEntryMarketAlignmentInput,
): PaperEntryMarketAlignmentDecision {
  const reject = (
    reason: Exclude<PaperEntryMarketAlignmentDecision['reason'], 'ALIGNED'>,
    details: Partial<Omit<PaperEntryMarketAlignmentDecision, 'eligible' | 'reason'>> = {},
  ): PaperEntryMarketAlignmentDecision => ({
    eligible: false,
    reason,
    plannedEntry: null,
    liveProtectivePrice: null,
    plannedStopDistance: null,
    remainingStopDistance: null,
    stopBudgetConsumedFraction: null,
    ...details,
  });

  const evaluatedAtMs = new Date(input.evaluatedAt).getTime();
  const candidateBarMs = new Date(input.candidateBarTime).getTime();
  if (!Number.isFinite(evaluatedAtMs) || !Number.isFinite(candidateBarMs)) {
    return reject('INVALID_ENTRY_GEOMETRY');
  }
  const expectedLatestClosedBarMs = Math.floor(evaluatedAtMs / BAR_MS) * BAR_MS - BAR_MS;
  if (candidateBarMs !== expectedLatestClosedBarMs) {
    return reject('STALE_M5_CANDIDATE');
  }

  const executionTimestampMs = new Date(input.executionQuote.timestamp).getTime();
  if (
    input.executionQuote.source === 'REST_M5' &&
    executionTimestampMs !== candidateBarMs + BAR_MS
  ) {
    return reject('EXECUTION_SNAPSHOT_MISMATCH');
  }

  if (input.fastMark.source === 'REST_M5') {
    return reject('FAST_MARK_UNAVAILABLE');
  }
  const fastMarkMs = new Date(input.fastMark.timestamp).getTime();
  const fastMarkAgeMs = evaluatedAtMs - fastMarkMs;
  if (
    !Number.isFinite(fastMarkMs) ||
    !Number.isFinite(fastMarkAgeMs) ||
    fastMarkAgeMs < -5_000 ||
    fastMarkAgeMs > PAPER_ENTRY_FAST_MARK_MAX_AGE_MS
  ) {
    return reject('FAST_MARK_STALE');
  }

  const plannedEntry = Number(
    input.direction === 'BUY' ? input.executionQuote.ask : input.executionQuote.bid,
  );
  const liveProtectivePrice = Number(
    input.direction === 'BUY' ? input.fastMark.bid : input.fastMark.ask,
  );
  const stopLoss = Number(input.stopLoss);
  if (
    !Number.isFinite(plannedEntry) ||
    !Number.isFinite(liveProtectivePrice) ||
    !Number.isFinite(stopLoss) ||
    plannedEntry <= 0 ||
    liveProtectivePrice <= 0 ||
    stopLoss <= 0
  ) {
    return reject('INVALID_ENTRY_GEOMETRY');
  }

  const plannedStopDistance =
    input.direction === 'BUY' ? plannedEntry - stopLoss : stopLoss - plannedEntry;
  const remainingStopDistance =
    input.direction === 'BUY' ? liveProtectivePrice - stopLoss : stopLoss - liveProtectivePrice;
  if (!Number.isFinite(plannedStopDistance) || plannedStopDistance <= 0) {
    return reject('INVALID_ENTRY_GEOMETRY', {
      plannedEntry,
      liveProtectivePrice,
      plannedStopDistance,
      remainingStopDistance,
    });
  }
  if (!Number.isFinite(remainingStopDistance) || remainingStopDistance <= 0) {
    return reject('LIVE_STOP_ALREADY_BREACHED', {
      plannedEntry,
      liveProtectivePrice,
      plannedStopDistance,
      remainingStopDistance,
      stopBudgetConsumedFraction: 1,
    });
  }

  const stopBudgetConsumedFraction =
    (plannedStopDistance - remainingStopDistance) / plannedStopDistance;
  if (stopBudgetConsumedFraction >= PAPER_ENTRY_MAX_STOP_BUDGET_CONSUMED) {
    return reject('ADVERSE_MOVE_CONSUMED_STOP_BUDGET', {
      plannedEntry,
      liveProtectivePrice,
      plannedStopDistance,
      remainingStopDistance,
      stopBudgetConsumedFraction,
    });
  }

  return {
    eligible: true,
    reason: 'ALIGNED',
    plannedEntry,
    liveProtectivePrice,
    plannedStopDistance,
    remainingStopDistance,
    stopBudgetConsumedFraction,
  };
}

interface TwelveDataValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
}
interface TwelveDataSeries {
  status?: string;
  code?: number;
  message?: string;
  values?: TwelveDataValue[];
  meta?: { symbol?: string };
}
type TwelveDataResponse = TwelveDataSeries | Record<string, TwelveDataSeries>;

export interface Candidate {
  instrument: string;
  direction: 'BUY' | 'SELL';
  confidence: number;
  volatilityScore: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  barTime: Date;
  score: number;
  atr: number;
  extensionAtr: number;
  emaSeparation: number;
  mtfStrength: number;
  /** Direction-aligned trend support from fully closed H4 candles only. */
  h4Alignment?: number;
  h4ContextAvailable?: boolean;
  h4ClosedBarCount?: number;
  rsi14: number;
  /** Direction-aligned price change / ATR: positive supports this candidate. */
  shortHorizonMomentumAtr: number;
}

export interface CounterfactualExecutionOption {
  candidate: Candidate;
  paperExecutionEligible: boolean;
  netExpectedR: number;
  estimatedExecutionCostR: number;
}

export interface CounterfactualExecutionSelection {
  selected: CounterfactualExecutionOption | null;
  reason:
    | 'NO_ELIGIBLE_DIRECTION'
    | 'SINGLE_ELIGIBLE_DIRECTION'
    | 'STRONGER_NET_EDGE'
    | 'AMBIGUOUS_DUAL_EDGE';
  requiredEdgeMarginR: number | null;
}

interface ExecutableCounterfactual {
  opportunityKey: string;
  evaluatedAt: Date;
  candidate: Candidate;
  digits: number;
  v8Shadow: ReturnType<typeof scoreV8ShadowMeta>;
  planBShadow: ReturnType<typeof scorePlanBShadowMeta>;
  planBEnsemble: PlanBEnsembleScore;
  portfolioSnapshotAvailable: boolean;
  ensembleGovernance: EnsembleGovernanceDecision;
  macroEventAssessment: MacroEventRiskAssessment;
  highConvictionOverlay: HighConvictionOverlay;
  rejectedEdgeCanary: RejectedEdgeCanaryDecision | null;
  rejectedEdgeCanaryEvidence: RejectedEdgeCanaryEvidence | null;
  paperResearchThroughput: PaperResearchThroughputDecision;
  paperExtensionExhaustionResearch: ReturnType<typeof evaluatePaperExtensionExhaustionResearch>;
  paperExtensionExhaustionPairSideReliability: PaperResearchPairSideReliabilityDecision | null;
  paperExtensionExhaustionEpisodeKey: string;
  paperExtensionExhaustionEpisodeGuard: ReturnType<typeof evaluatePaperResearchEpisodeGuard> | null;
  pairedDirectionReversal: PairedDirectionReversalDecision;
  pairedReversalGovernance: EnsembleGovernanceDecision;
  pairedReversalResearch: ReturnType<typeof evaluatePaperPairedReversalResearch>;
  pairedReversalEpisodeKey: string;
  pairedReversalEpisodeGuard: ReturnType<typeof evaluatePaperResearchEpisodeGuard> | null;
  paperResearchPairSideReliability: PaperResearchPairSideReliabilityDecision | null;
  paperTrendRouteReliability: PaperTrendRouteReliabilityDecision | null;
  paperTrendPairSideReliability: PaperTrendPairSideReliabilityDecision | null;
  paperTrendPairSideReliabilityShadow: PaperTrendPairSideReliabilityShadowDecision | null;
  paperExecutionRoute: ReturnType<typeof selectPaperExecutionRoute>;
  paperResearchEpisodeKey: string;
  paperResearchEpisodeGuard: ReturnType<typeof evaluatePaperResearchEpisodeGuard> | null;
  paperPostLossEntryGuard: PaperPostLossEntryDecision;
  paperCostAwareEntry: PaperCostAwareEntryDecision;
  paperCostAwareEvidence: PaperCostAwareCohortEvidence;
  paperCalibratedCostRescue: PaperCalibratedCostResearchRescueDecision;
}

interface AdaptiveScanDiagnosticCandidate {
  instrument: string;
  direction: 'BUY' | 'SELL';
  adaptiveScore: number;
  netExpectedR: number;
  state: AdaptiveMarketStateDecision['state'];
  blockers: string[];
}

interface AdaptiveScanWinner {
  chosen: ExecutableCounterfactual;
  selection: CounterfactualExecutionSelection;
  marketState: AdaptiveMarketStateDecision;
  edge: AdaptiveEdgeEvidence;
  exposure: AdaptiveCurrencyExposureDecision;
  opportunity: AdaptiveOpportunityDecision;
  riskMultiplier: AdaptiveRiskMultiplierDecision;
  predictionCalibration: AdaptivePredictionCalibrationDecision;
  rawNetExpectedR: number;
  candidateRiskAtStop: number | null;
  requestedRiskPercent: number;
  adaptiveScore: number;
  netExpectedR: number;
  executionCostR: number;
  preAdaptiveScanRank: number;
  adaptiveScanRank?: number;
}

function executableNetExpectedR(option: ExecutableCounterfactual): number {
  return option.paperExecutionRoute === 'PAIRED_REVERSAL_RESEARCH'
    ? option.pairedDirectionReversal.researchNetExpectedR
    : option.ensembleGovernance.netExpectedR;
}

export function selectCounterfactualExecutionCandidate(
  options: CounterfactualExecutionOption[],
): CounterfactualExecutionSelection {
  const eligible = options
    .filter(
      (option) =>
        option.paperExecutionEligible &&
        Number.isFinite(option.netExpectedR) &&
        Number.isFinite(option.estimatedExecutionCostR),
    )
    .sort((a, b) => b.netExpectedR - a.netExpectedR);
  if (eligible.length === 0) {
    return { selected: null, reason: 'NO_ELIGIBLE_DIRECTION', requiredEdgeMarginR: null };
  }
  if (eligible.length === 1) {
    return {
      selected: eligible[0]!,
      reason: 'SINGLE_ELIGIBLE_DIRECTION',
      requiredEdgeMarginR: null,
    };
  }
  const best = eligible[0]!;
  const runnerUp = eligible[1]!;
  const requiredEdgeMarginR = Math.max(
    COUNTERFACTUAL_MIN_EDGE_R,
    Math.max(best.estimatedExecutionCostR, runnerUp.estimatedExecutionCostR) *
      COUNTERFACTUAL_COST_UNCERTAINTY_FRACTION,
  );
  if (best.netExpectedR - runnerUp.netExpectedR < requiredEdgeMarginR) {
    return { selected: null, reason: 'AMBIGUOUS_DUAL_EDGE', requiredEdgeMarginR };
  }
  return { selected: best, reason: 'STRONGER_NET_EDGE', requiredEdgeMarginR };
}

export function prioritizeCounterfactualExecutionRoutes<
  T extends { paperExecutionRoute: ReturnType<typeof selectPaperExecutionRoute> },
>(options: T[]): T[] {
  const establishedRoutes = options.filter(
    (option) => option.paperExecutionRoute !== 'PAIRED_REVERSAL_RESEARCH',
  );
  return establishedRoutes.length > 0 ? establishedRoutes : options;
}

export interface PublishedOpportunity {
  direction: 'BUY' | 'SELL';
  confidence: number;
  entry: number;
  atr: number;
  barTimeMs: number;
}

export function isFreshOpportunity(
  candidate: Candidate,
  previous: PublishedOpportunity | undefined,
): boolean {
  if (!previous || previous.direction !== candidate.direction) return true;

  const directionalMove =
    candidate.direction === 'BUY'
      ? candidate.entry - previous.entry
      : previous.entry - candidate.entry;
  const breakout =
    directionalMove >= Math.max(candidate.atr, previous.atr) * FRESH_BREAKOUT_ATR &&
    candidate.confidence >= previous.confidence - MAX_CONFIDENCE_DECAY_ON_BREAKOUT;
  const confidenceExpansion = candidate.confidence >= previous.confidence + FRESH_CONFIDENCE_DELTA;

  return breakout || confidenceExpansion;
}

export function ema(values: number[], period: number): number {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let value = values[0]!;
  for (let i = 1; i < values.length; i += 1) value = values[i]! * k + value * (1 - k);
  return value;
}

export function rsi(values: number[], period = 14): number {
  if (values.length <= period) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i]! - values[i - 1]!;
    gain += Math.max(0, d);
    loss += Math.max(0, -d);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function aggregateCandles(
  candles: LivePaperCandleInput[],
  bucketMinutes: number,
): LivePaperCandleInput[] {
  const bucketMs = bucketMinutes * 60_000;
  const groups = new Map<number, LivePaperCandleInput[]>();
  for (const candle of candles) {
    const ts = new Date(candle.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    const rows = groups.get(bucket) ?? [];
    rows.push(candle);
    groups.set(bucket, rows);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, rows]) => ({
      timestamp: new Date(bucket),
      open: rows[0]!.open,
      high: String(Math.max(...rows.map((r) => Number(r.high)))),
      low: String(Math.min(...rows.map((r) => Number(r.low)))),
      close: rows[rows.length - 1]!.close,
    }));
}

export function aggregateCompletedCandles(
  candles: LivePaperCandleInput[],
  bucketMinutes: number,
  baseBarMinutes = 5,
): LivePaperCandleInput[] {
  if (
    !candles.length ||
    bucketMinutes <= 0 ||
    baseBarMinutes <= 0 ||
    bucketMinutes % baseBarMinutes !== 0
  ) {
    return [];
  }
  const baseBarMs = baseBarMinutes * 60_000;
  const bucketMs = bucketMinutes * 60_000;
  const expectedBars = bucketMinutes / baseBarMinutes;
  const latestOpenMs = new Date(candles[candles.length - 1]!.timestamp).getTime();
  if (!Number.isFinite(latestOpenMs)) return [];
  const knownThroughMs = latestOpenMs + baseBarMs;
  const groups = new Map<number, LivePaperCandleInput[]>();
  for (const candle of candles) {
    const openMs = new Date(candle.timestamp).getTime();
    if (!Number.isFinite(openMs)) continue;
    const bucketOpenMs = Math.floor(openMs / bucketMs) * bucketMs;
    if (bucketOpenMs + bucketMs > knownThroughMs) continue;
    const rows = groups.get(bucketOpenMs) ?? [];
    rows.push(candle);
    groups.set(bucketOpenMs, rows);
  }
  return [...groups.entries()]
    .filter(([, rows]) => {
      if (rows.length !== expectedBars) return false;
      const opens = new Set(rows.map((row) => new Date(row.timestamp).getTime()));
      return rows.every((row, index) => {
        const bucketOpenMs = Math.floor(new Date(row.timestamp).getTime() / bucketMs) * bucketMs;
        return opens.has(bucketOpenMs + index * baseBarMs);
      });
    })
    .sort((a, b) => a[0] - b[0])
    .map(([bucketOpenMs, rows]) => {
      const ordered = [...rows].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      return {
        timestamp: new Date(bucketOpenMs),
        open: ordered[0]!.open,
        high: String(Math.max(...ordered.map((row) => Number(row.high)))),
        low: String(Math.min(...ordered.map((row) => Number(row.low)))),
        close: ordered[ordered.length - 1]!.close,
      };
    });
}

export function atr(candles: LivePaperCandleInput[], period = 14): number {
  if (candles.length <= period) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const high = Number(candles[i]!.high);
    const low = Number(candles[i]!.low);
    const prevClose = Number(candles[i - 1]!.close);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length < period) return NaN;
  let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i += 1) value = (value * (period - 1) + trs[i]!) / period;
  return value;
}

export function buildDirectionalCandidates(
  instrument: string,
  candles: LivePaperCandleInput[],
): Candidate[] {
  if (candles.length < 55) return [];
  const closes = candles.map((c) => Number(c.close));
  if (closes.some((x) => !Number.isFinite(x) || x <= 0)) return [];
  const px = closes[closes.length - 1]!;
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const m15 = aggregateCandles(candles, 15);
  const h1 = aggregateCandles(candles, 60);
  const h4 = aggregateCompletedCandles(candles, 240);
  if (m15.length < 30 || h1.length < 24) return [];
  const m15Closes = m15.map((c) => Number(c.close));
  const h1Closes = h1.map((c) => Number(c.close));
  const m15Ema9 = ema(m15Closes, 9);
  const m15Ema21 = ema(m15Closes, 21);
  const h1Ema21 = ema(h1Closes, 21);
  const h4Closes = h4.map((c) => Number(c.close));
  const h4ContextAvailable = h4.length >= 9 && h4Closes.every(Number.isFinite);
  const h4Ema3 = h4ContextAvailable ? ema(h4Closes, 3) : Number.NaN;
  const h4Ema8 = h4ContextAvailable ? ema(h4Closes, 8) : Number.NaN;
  const h4Atr5 = h4ContextAvailable ? atr(h4, 5) : Number.NaN;
  if (
    ![ema9, ema21, ema50, rsi14, atr14, m15Ema9, m15Ema21, h1Ema21].every(Number.isFinite) ||
    atr14 <= 0 ||
    (h4ContextAvailable && (![h4Ema3, h4Ema8, h4Atr5].every(Number.isFinite) || h4Atr5 <= 0))
  ) {
    return [];
  }

  // Common market-quality gates stay direction-neutral. Direction is decided
  // later by comparing two independently scored counterfactuals from the same
  // closed market snapshot.
  const extensionAtr = Math.abs(px - ema21) / atr14;
  if (!Number.isFinite(extensionAtr) || extensionAtr > 1.5) return [];
  const relativeAtr = atr14 / px;
  const volatilityScore = Math.max(0, Math.min(1, relativeAtr / 0.0015));
  if (volatilityScore >= 0.75) return [];

  const barTime = new Date(candles[candles.length - 1]!.timestamp);
  const pipSize = instrument.endsWith('JPY') ? 0.01 : 0.0001;
  const stopDistance = Math.max(
    atr14 * STOP_ATR_MULTIPLIER,
    (MIN_STOP_LOSS_PIPS + STOP_FLOOR_BUFFER_PIPS) * pipSize,
  );
  const targetDistance = stopDistance * (TARGET_ATR_MULTIPLIER / STOP_ATR_MULTIPLIER);
  const rawMomentumAtr = (px - closes[closes.length - 2]!) / atr14;

  return (['BUY', 'SELL'] as const).map((direction) => {
    const sign = direction === 'BUY' ? 1 : -1;
    // Preserve the historical feature scale for the trend-aligned side while
    // giving the opposite side zero directional support instead of rejecting
    // it before the ensemble can evaluate it.
    const emaSeparation = Math.max(0, Math.min(1, (sign * (ema9 - ema21)) / atr14 / 2));
    const mtfStrength = Math.min(1, Math.max(0, (sign * (m15Ema9 - m15Ema21)) / atr14));
    const h1Alignment = Math.max(0, Math.min(1, (sign * (px - h1Ema21)) / atr14));
    const h4Alignment = h4ContextAvailable
      ? Math.max(0, Math.min(1, (sign * (h4Ema3 - h4Ema8)) / h4Atr5))
      : 0;
    const rsiStrength =
      direction === 'BUY'
        ? Math.max(0, Math.min(1, (rsi14 - 50) / 22))
        : Math.max(0, Math.min(1, (50 - rsi14) / 22));
    const shortHorizonMomentumAtr = sign * rawMomentumAtr;
    const momentumQuality = Math.max(0, Math.min(1, shortHorizonMomentumAtr / 0.5));
    const confidence = Math.max(
      0.6,
      Math.min(0.8, 0.6 + 0.12 * emaSeparation + 0.08 * rsiStrength),
    );
    const score =
      confidence +
      0.05 * emaSeparation +
      0.025 * mtfStrength +
      0.015 * h1Alignment +
      0.015 * h4Alignment +
      0.015 * momentumQuality -
      0.02 * volatilityScore -
      0.02 * Math.min(1.5, extensionAtr);

    return {
      instrument,
      direction,
      confidence,
      volatilityScore,
      entry: px,
      stopLoss: direction === 'BUY' ? px - stopDistance : px + stopDistance,
      takeProfit: direction === 'BUY' ? px + targetDistance : px - targetDistance,
      barTime,
      score,
      atr: atr14,
      extensionAtr,
      emaSeparation,
      mtfStrength,
      h4Alignment,
      h4ContextAvailable,
      h4ClosedBarCount: h4.length,
      rsi14,
      shortHorizonMomentumAtr,
    };
  });
}

/** Backward-compatible single-candidate helper used by diagnostics/tests. */
export function buildCandidate(
  instrument: string,
  candles: LivePaperCandleInput[],
): Candidate | null {
  return (
    buildDirectionalCandidates(instrument, candles)
      .filter((candidate) => candidate.confidence >= CONFIDENCE_FLOOR)
      .sort((a, b) => b.score - a.score)[0] ?? null
  );
}

@Injectable()
export class VpsForexSignalCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VpsForexSignalCollectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private startupPrimePromise: Promise<void> | null = null;
  private destroyed = false;
  private running = false;
  private lastSlot: string | null = null;
  private nextCollectionAttemptAt = 0;
  private preIntentRetrySlot: string | null = null;
  private readonly signalGeneratedAtById = new Map<string, Date>();
  private transientProviderFailureMinute: string | null = null;
  private lastProviderFetchMinute: string | null = null;
  private lastProviderSeries: Map<string, LivePaperCandleInput[]> | null = null;
  private providerCooldownUntil: Date | null = null;
  private providerCooldownReason: 'DAILY_CREDIT_LIMIT' | null = null;
  private lastMarketDataAuthority: 'NONE' | 'TWELVE_DATA' | 'METAAPI_BROKER_FALLBACK' = 'NONE';
  private readonly lastPublishedOpportunity = new Map<string, PublishedOpportunity>();
  private readonly pairSideReliabilityStatusCache = new Map<
    string,
    { expiresAt: number; snapshot: PaperTrendPairSideReliabilityStatus[] }
  >();
  private lastEnsembleDecision: {
    evaluatedAt: Date | null;
    instrument: string | null;
    direction: 'BUY' | 'SELL' | null;
    paperAdmitted: boolean;
    admitted: boolean;
    candidateConfidence: number | null;
    ensembleScore: number | null;
    metaProbability: number | null;
    expectedR: number | null;
    consensusPassed: number | null;
    consensusRequired: number | null;
    regime: string | null;
    reasons: string[];
    governance: EnsembleGovernanceDecision | null;
    macroEventAssessment: MacroEventRiskAssessment | null;
    highConvictionOverlay: HighConvictionOverlay | null;
  } = {
    evaluatedAt: null,
    instrument: null,
    direction: null,
    paperAdmitted: false,
    admitted: false,
    candidateConfidence: null,
    ensembleScore: null,
    metaProbability: null,
    expectedR: null,
    consensusPassed: null,
    consensusRequired: null,
    regime: null,
    reasons: ['WAITING_FOR_MARKET_SCAN'],
    governance: null,
    macroEventAssessment: null,
    highConvictionOverlay: null,
  };
  private lastEvaluation: {
    confidence: number | null;
    instrument: string | null;
    direction: 'BUY' | 'SELL' | null;
    evaluatedAt: Date | null;
    qualified: boolean;
    reason: 'QUALIFYING_SETUP' | 'NO_QUALIFYING_SETUP';
  } = {
    confidence: null,
    instrument: null,
    direction: null,
    evaluatedAt: null,
    qualified: false,
    reason: 'NO_QUALIFYING_SETUP',
  };

  constructor(
    private readonly config: ConfigService,
    private readonly aiSignalService: AiSignalService,
    private readonly executionService: ExecutionService,
    private readonly brokerService: BrokerService,
    private readonly livePaperMarket: LivePaperMarketDataService,
    private readonly aiEngineClient: AiEngineClient,
    @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly macroEventRisk?: MacroEventRiskService,
    @Optional()
    private readonly ensemblePostEntryProtection?: EnsemblePostEntryProtectionShadowService,
    @Optional() private readonly adaptiveEdgeMatrix?: AdaptiveEdgeMatrixService,
    @Optional() private readonly allocationService?: AllocationService,
    @Optional()
    private readonly adaptivePredictionCalibration?: AdaptivePredictionCalibrationService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.destroyed = false;
    if (!this.enabled()) {
      this.logger.log('VPS six-pair forex scanner disabled');
      return;
    }
    const apiKey = this.apiKey();
    const userId = this.userId();
    const connectionId = this.connectionId();
    if (!apiKey || apiKey.toLowerCase() === 'demo' || !userId || !connectionId) {
      this.logger.error(
        'VPS forex scanner enabled but production evidence configuration is incomplete; scanner remains fail-closed',
      );
      return;
    }
    // Claim the exact PAPER connection immediately so no restored live position
    // can fall back to the historical/default simulator during boot. Until the
    // cache is primed, quote reads fail closed with PROVIDER_UNAVAILABLE.
    this.livePaperMarket.registerLiveConnection(connectionId);

    // API restarts can happen while a PAPER session already exists. Stop any
    // legacy Python scheduler job for the exact bound session before this
    // provider begins evidence collection, otherwise replay/model decisions
    // could compete for the same risk/capital authority.
    try {
      const active = await this.executionService.getActiveSession(userId);
      if (
        active &&
        active.executionMode === ExecutionMode.PAPER_ONLY &&
        active.brokerConnectionId === connectionId &&
        this.aiEngineClient.isSchedulerIntegrationEnabled()
      ) {
        await this.aiEngineClient.notifySessionStopped({ tradingSessionId: active.id });
        this.logger.log(`Legacy AI scheduler stopped for VPS scanner session=${active.id}`);
      }
    } catch (error) {
      // Fail closed for signal publication: market collection may initialize,
      // but no scanner signal should compete with an unverified scheduler.
      this.livePaperMarket.unregisterLiveConnection(connectionId);
      this.logger.error(
        `VPS scanner could not isolate legacy scheduler; scanner remains disabled: ${(error as Error).message}`,
      );
      return;
    }

    try {
      await this.restorePublishedOpportunities(userId, connectionId);
      const schedule = this.marketSchedule(new Date());
      if (schedule.paused) {
        this.logger.log(
          `Multi-model market collection paused reason=${schedule.reason} next=${schedule.nextEligibleScanAt}`,
        );
      } else {
        // Market providers can take minutes to fail when quota-limited or broker
        // connectivity is degraded. Do not hold Nest bootstrap hostage to that
        // external I/O. The connection was already claimed above, so every PAPER
        // quote/risk path remains fail-closed until this prime actually succeeds.
        const startupPrime = this.primeStartupMarketData(apiKey, userId, connectionId);
        this.startupPrimePromise = startupPrime;
        void startupPrime.finally(() => {
          if (this.startupPrimePromise === startupPrime) this.startupPrimePromise = null;
        });
      }
    } catch (error) {
      this.logger.error(
        `VPS startup state restore failed; live PAPER remains fail-closed: ${(error as Error).message}`,
      );
    }

    this.logger.log(
      `iRexPro multi-model engine enabled engine=${ACTIVE_ENGINE_CODE} legacyProvider=${LEGACY_PROVIDER_CODE} ` +
        `legacyExecutionFrozen=${LEGACY_V7_EXECUTION_FROZEN} paperExecution=${MULTI_MODEL_PAPER_EXECUTION_ENABLED} ` +
        `cadence=${COLLECTION_CADENCE_MINUTES}m timeframe=M5 marketHours=FX_24X5_SUN21_FRI21_UTC`,
    );
    this.timer = setInterval(() => void this.maybeCollect(), 15_000);
    this.timer.unref?.();
    this.startupTimer = setTimeout(() => void this.maybeCollect(), 2_000);
    this.startupTimer.unref?.();
  }

  private async primeStartupMarketData(
    apiKey: string,
    userId: string,
    connectionId: string,
  ): Promise<void> {
    try {
      await this.primeMarketData(apiKey, connectionId);
      if (this.destroyed) return;
      const activeAfterPrime = await this.executionService.getActiveSession(userId);
      if (this.destroyed) return;
      if (
        activeAfterPrime &&
        activeAfterPrime.executionMode === ExecutionMode.PAPER_ONLY &&
        activeAfterPrime.brokerConnectionId === connectionId
      ) {
        await this.heartbeatLivePaper(userId, connectionId);
        this.logger.log(
          'Multi-model startup live PAPER protection heartbeat completed for 6/6 pairs',
        );
      }
    } catch (error) {
      // Keep live ownership registered so restored live positions fail closed
      // rather than being valued against a mismatched simulator feed. The
      // periodic scanner can recover on a later successful provider request.
      this.logger.error(
        `VPS startup market prime/heartbeat failed; live PAPER remains fail-closed: ${(error as Error).message}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
    const connectionId = this.connectionId();
    if (connectionId) this.livePaperMarket.unregisterLiveConnection(connectionId);
  }

  async getStatus(requestingUserId: string) {
    const now = new Date();
    const marketSchedule = this.marketSchedule(now);
    const configuredUserId = this.userId();
    const configured = Boolean(
      this.apiKey() &&
      this.apiKey().toLowerCase() !== 'demo' &&
      configuredUserId &&
      this.connectionId(),
    );
    const ownsBinding = Boolean(configuredUserId && configuredUserId === requestingUserId);
    let activePaperSession = false;
    let pairSideReliability: PaperTrendPairSideReliabilityStatus[] = [];
    let ensembleCampaign = await this.loadEnsembleCampaignStatus('', '');
    const brokerExpertConfigured =
      ownsBinding && this.brokerExpertEnabled() && Boolean(this.brokerExpertSourceConnectionId());
    const lastOverlay = this.lastEnsembleDecision.highConvictionOverlay;
    const overlayScoringState = !brokerExpertConfigured
      ? 'BROKER_SOURCE_NOT_CONFIGURED'
      : marketSchedule.paused
        ? 'READY_WAITING_FRESH_MARKET'
        : lastOverlay?.state === 'CONFIRM' ||
            lastOverlay?.state === 'CONFLICT' ||
            lastOverlay?.state === 'ABSTAIN'
          ? 'READY'
          : lastOverlay?.state === 'STALE'
            ? 'STALE'
            : 'READY_WAITING_FRESH_SCORE';
    let highConvictionChallenger: Record<string, unknown> = {
      state: 'UNAVAILABLE',
      artifact: null,
      loaded: false,
      featureCount: null,
      qualificationCutoff: null,
      sealedFutureHoldoutTouched: null,
      frozenConsensus: null,
      historicalValidation: null,
      executionAuthority: 'NONE',
      paperPromotionEligible: false,
      brokerNativeRequired: true,
      brokerSourceConfigured: brokerExpertConfigured,
      prospectiveScoringState: overlayScoringState,
      lastOverlay,
      error: null,
    };
    try {
      const challenger = await this.aiEngineClient.getPlanBV4ChallengerStatus();
      highConvictionChallenger = {
        state: !challenger.configured
          ? 'NOT_CONFIGURED'
          : !challenger.loaded
            ? 'ERROR'
            : brokerExpertConfigured
              ? 'BROKER_MTF_OVERLAY_READY'
              : 'ARTIFACT_READY_BROKER_MTF_REQUIRED',
        artifact: challenger.artifact,
        loaded: challenger.loaded,
        featureCount: challenger.feature_count,
        qualificationCutoff: challenger.qualification_cutoff,
        sealedFutureHoldoutTouched: challenger.sealed_future_holdout_touched,
        frozenConsensus: challenger.frozen_consensus,
        historicalValidation: challenger.historical_validation,
        executionAuthority: challenger.execution_authority,
        paperPromotionEligible: challenger.paper_promotion_eligible,
        brokerNativeRequired: true,
        brokerSourceConfigured: brokerExpertConfigured,
        prospectiveScoringState: overlayScoringState,
        lastOverlay,
        error: challenger.load_error,
      };
    } catch (error) {
      highConvictionChallenger = {
        ...highConvictionChallenger,
        error: (error as Error).message,
      };
    }
    const configuredConnectionId = this.connectionId();
    if (ownsBinding && configuredConnectionId) {
      [ensembleCampaign, pairSideReliability] = await Promise.all([
        this.loadEnsembleCampaignStatus(requestingUserId, configuredConnectionId),
        this.loadPaperTrendPairSideReliabilitySnapshot(requestingUserId, configuredConnectionId),
      ]);
      const session = await this.executionService.getActiveSession(requestingUserId);
      activePaperSession = Boolean(
        session &&
        session.executionMode === ExecutionMode.PAPER_ONLY &&
        session.brokerConnectionId === this.connectionId(),
      );
    }
    const postEntryShadow = this.ensemblePostEntryProtection
      ? await this.ensemblePostEntryProtection.getUserStatus(requestingUserId)
      : {
          artifact: 'plan-b-v85-profitable-state-giveback-classifier-v1',
          enabled: false,
          cohort: 'ENSEMBLE_SHADOW_DECISIONS' as const,
          sourceArtifact: PLAN_B_ENSEMBLE_ARTIFACT,
          sourcePolicyVersion: PLAN_B_ACTIVE_MODEL_POLICY_VERSION,
          executionAuthority: 'NONE' as const,
          modifiesExecution: false,
          cadenceSeconds: 60,
          checkpointsMinutes: [5, 10, 15, 30, 60, 120, 240],
          brokerSourceConfigured: false,
          lastRunAt: null,
          lastScored: 0,
          lastCandidates: 0,
          observedCheckpoints: 0,
          distinctDecisionsObserved: 0,
          eligibleProfitDecisions: 0,
          protectRecommendations: 0,
          observeRecommendations: 0,
          evidenceMinimums: {
            distinctDecisions: 100,
            eligibleProfitDecisions: 30,
          },
          sampleMinimumSatisfied: false,
          evidenceState: 'COLLECTING_PROSPECTIVE_EVIDENCE' as const,
          paperPromotionEligible: false as const,
          promotionBlocker: 'MINIMUM_PROSPECTIVE_SAMPLE_NOT_MET' as const,
          lastError: 'SERVICE_NOT_AVAILABLE',
        };
    const expertRegistry = buildEnsembleExpertRegistry({
      highConvictionArtifact:
        typeof highConvictionChallenger.artifact === 'string'
          ? highConvictionChallenger.artifact
          : null,
      highConvictionLoaded: highConvictionChallenger.loaded === true,
      highConvictionBrokerDataReady: highConvictionChallenger.prospectiveScoringState === 'READY',
      postEntryArtifactReady: postEntryShadow.enabled,
      postEntryBrokerDataReady: postEntryShadow.brokerSourceConfigured,
      postEntryShadowObservations: postEntryShadow.observedCheckpoints,
      macroEventConfigured: Boolean(this.macroEventRisk?.isConfigured()),
      sleeveResolvedOutcomes: ensembleCampaign.evaluableResolved,
      legacyBaselineFrozen: LEGACY_V7_EXECUTION_FROZEN,
    });
    return {
      providerCode: PROVIDER_CODE,
      activeEngineCode: ACTIVE_ENGINE_CODE,
      activeEngineDisplayName: 'iRexPro Multi-Model Ensemble',
      engineArchitecture: 'MULTI_MODEL_ENSEMBLE',
      legacyBaselineProviderCode: LEGACY_PROVIDER_CODE,
      legacyBaselineFrozen: LEGACY_V7_EXECUTION_FROZEN,
      multiModelPaperExecutionEnabled: MULTI_MODEL_PAPER_EXECUTION_ENABLED,
      executionAuthority: MULTI_MODEL_PAPER_EXECUTION_ENABLED ? 'PAPER_ONLY' : 'SHADOW_ONLY',
      enabled: this.enabled(),
      configured: configured && ownsBinding,
      activePaperSession,
      cadenceMinutes: COLLECTION_CADENCE_MINUTES,
      timeframe: 'M5',
      skippedUtcHours: [],
      confidenceFloor: CONFIDENCE_FLOOR,
      ensembleThresholds: {
        candidateConfidenceFloor: CONFIDENCE_FLOOR,
        metaProbabilityFloor: PLAN_B_SHADOW_ADMISSION_THRESHOLD,
        grossExpectedRFloor: PLAN_B_GROSS_EXPECTED_R_FLOOR,
        paperNetExpectedRFloor: ENSEMBLE_PAPER_NET_EXPECTED_R_FLOOR,
        promotionNetExpectedRFloor: ENSEMBLE_NET_EXPECTED_R_FLOOR,
        sleeveCoreMinClosedTrades: ENSEMBLE_SLEEVE_CORE_MIN_CLOSED_TRADES,
      },
      lastEvaluatedConfidence: this.lastEvaluation.confidence,
      lastEvaluatedInstrument: this.lastEvaluation.instrument,
      lastEvaluatedDirection: this.lastEvaluation.direction,
      lastEvaluatedAt: this.lastEvaluation.evaluatedAt?.toISOString() ?? null,
      lastEvaluationQualified: this.lastEvaluation.qualified,
      lastEvaluationReason: this.lastEvaluation.reason,
      paperOnly: true,
      automaticDemoPromotion: false,
      automaticLivePromotion: false,
      marketSchedule,
      ensembleCampaign,
      pairSideReliability,
      highConvictionChallenger,
      postEntryShadow,
      expertRegistry,
      lastEnsembleDecision: {
        evaluatedAt: this.lastEnsembleDecision.evaluatedAt?.toISOString() ?? null,
        instrument: this.lastEnsembleDecision.instrument,
        direction: this.lastEnsembleDecision.direction,
        paperAdmitted: this.lastEnsembleDecision.paperAdmitted,
        admitted: this.lastEnsembleDecision.admitted,
        candidateConfidence: this.lastEnsembleDecision.candidateConfidence,
        ensembleScore: this.lastEnsembleDecision.ensembleScore,
        metaProbability: this.lastEnsembleDecision.metaProbability,
        expectedR: this.lastEnsembleDecision.expectedR,
        consensusPassed: this.lastEnsembleDecision.consensusPassed,
        consensusRequired: this.lastEnsembleDecision.consensusRequired,
        regime: this.lastEnsembleDecision.regime,
        reasons: this.lastEnsembleDecision.reasons,
        governance: this.lastEnsembleDecision.governance,
        macroEventAssessment: this.lastEnsembleDecision.macroEventAssessment,
        highConvictionOverlay: this.lastEnsembleDecision.highConvictionOverlay,
      },
      components: {
        regimeRouter: 'IMPLEMENTED',
        directionExpert: 'IMPLEMENTED',
        expectedValueMeta: 'IMPLEMENTED',
        tradeQuality: 'IMPLEMENTED',
        exitFeasibility: 'IMPLEMENTED',
        pairSideRouter: 'IMPLEMENTED',
        sessionQuality: 'IMPLEMENTED',
        portfolioCorrelation: 'IMPLEMENTED',
        highConvictionExpert:
          highConvictionChallenger.state === 'BROKER_MTF_OVERLAY_READY'
            ? 'BROKER_MTF_OVERLAY_READY_SHADOW_ONLY'
            : highConvictionChallenger.state === 'ARTIFACT_READY_BROKER_MTF_REQUIRED'
              ? 'ARTIFACT_READY_BROKER_MTF_REQUIRED'
              : 'CHALLENGER_VALIDATION',
        fastMicrostructureSpecialists: 'REJECTED_NO_QUALIFIED_SPECIALIST',
        newsEventRisk: this.macroEventRisk?.isConfigured()
          ? 'IMPLEMENTED'
          : 'GUARD_IMPLEMENTED_PROVIDER_REQUIRED',
        netExecutionEconomics: 'IMPLEMENTED',
        driftSleeveHealth: 'IMPLEMENTED_COLLECTING',
        postEntryExitModel: postEntryShadow.enabled
          ? postEntryShadow.brokerSourceConfigured
            ? 'TRAINED_V85_VIRTUAL_COHORT_COLLECTING'
            : 'TRAINED_V85_ARTIFACT_READY_BROKER_SOURCE_REQUIRED'
          : 'TELEMETRY_IMPLEMENTED_POLICY_RESEARCH',
      },
      providerCooldownReason: this.providerCooldownReason,
      providerCooldownUntil: this.providerCooldownUntil?.toISOString() ?? null,
      marketDataAuthority: this.lastMarketDataAuthority,
      providerFallbackActive: this.lastMarketDataAuthority === 'METAAPI_BROKER_FALLBACK',
      marketCache: ownsBinding
        ? this.livePaperMarket.status(this.connectionId())
        : {
            cachedInstruments: [],
            cachedInstrumentCount: 0,
            streamingInstruments: [],
            streamingInstrumentCount: 0,
            latestObservedAt: null,
            latestQuoteObservedAt: null,
          },
      state:
        !ownsBinding || !configured
          ? 'WAITING_FOR_CONFIGURATION'
          : !this.enabled()
            ? 'DISABLED'
            : marketSchedule.paused
              ? 'MARKET_PAUSED'
              : this.providerCooldownUntil &&
                  this.providerCooldownUntil.getTime() > Date.now() &&
                  this.lastMarketDataAuthority !== 'METAAPI_BROKER_FALLBACK'
                ? 'WAITING_FOR_PROVIDER_QUOTA'
                : this.livePaperMarket.status(this.connectionId()).cachedInstrumentCount <
                    SYMBOLS.length
                  ? 'WAITING_FOR_MARKET_DATA'
                  : MULTI_MODEL_PAPER_EXECUTION_ENABLED
                    ? activePaperSession
                      ? 'ACTIVE'
                      : 'WAITING_FOR_PAPER_SESSION'
                    : 'MULTI_MODEL_SHADOW',
    };
  }

  async maybeCollect(now = new Date()): Promise<void> {
    if (this.destroyed || this.startupPrimePromise) return;
    if (this.providerCooldownUntil && this.providerCooldownUntil.getTime() <= now.getTime()) {
      this.providerCooldownUntil = null;
      this.providerCooldownReason = null;
    }
    if (!this.enabled() || this.running || !this.isCollectionSlot(now)) return;
    if (now.getTime() < this.nextCollectionAttemptAt) return;
    // A delayed timer or restart can still evaluate the current closed M5 bar.
    // Reserve the whole five-minute slot, not just its boundary minute.
    const slot = new Date(Math.floor(now.getTime() / BAR_MS) * BAR_MS).toISOString();
    if (this.lastSlot === slot) return;
    this.lastSlot = slot;
    try {
      await this.collectOnce();
      this.nextCollectionAttemptAt = 0;
    } catch (error) {
      const retrySafeCode = (error as { code?: string }).code;
      if (retrySafeCode === BROKER_FALLBACK_SOURCE_UNAVAILABLE_CODE) {
        // A configured fallback connection in SUSPENDED/CONNECTING/etc. state
        // cannot become usable by repeating history calls inside this same M5
        // market slot. Keep the slot consumed and let the next normal closed
        // bar retry after broker health/recovery has had time to run.
        this.nextCollectionAttemptAt = 0;
        this.logger.warn(
          `VPS forex broker fallback unavailable; holding until the next collection slot: ` +
            `${(error as Error).message}`,
        );
        return;
      }
      if (retrySafeCode === PAPER_PRE_INTENT_RETRY_SAFE_CODE) {
        if (this.preIntentRetrySlot === slot) {
          // A pre-intent failure is safe to retry exactly once because durable
          // state proves provider dispatch was impossible. Do not loop forever
          // on a persistent database/schema failure inside the same scan slot.
          this.nextCollectionAttemptAt = 0;
          this.logger.error(
            `VPS forex scan pre-intent retry exhausted for slot=${slot}; ` +
              `holding until the next collection slot: ${(error as Error).message}`,
          );
          return;
        }
        this.preIntentRetrySlot = slot;
        this.lastSlot = null;
        this.nextCollectionAttemptAt = Math.max(now.getTime(), Date.now()) + 60_000;
        this.logger.warn(
          `VPS forex scan stopped before TradeIntent creation; retrying the exact slot once in 60s: ` +
            `${(error as Error).message}`,
        );
        return;
      }

      // Generic failed collection must not consume the slot. One minute of
      // backoff protects the six-credit primary batch from the 15-second timer.
      // Feed/network failures keep their existing recover-until-success behavior.
      this.lastSlot = null;
      this.nextCollectionAttemptAt = Math.max(now.getTime(), Date.now()) + 60_000;
      this.logger.warn(`VPS forex scan failed; retry in 60s: ${(error as Error).message}`);
    }
  }

  async collectOnce(fetchImpl: typeof fetch = fetch): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const apiKey = this.apiKey();
      const userId = this.userId();
      const connectionId = this.connectionId();
      if (!apiKey || apiKey.toLowerCase() === 'demo' || !userId || !connectionId) {
        throw new Error('production Twelve Data key, user id and paper connection id are required');
      }

      const seriesByInstrument = await this.fetchSixPairSeries(apiKey, fetchImpl);
      for (const [instrument, candles] of seriesByInstrument.entries()) {
        this.livePaperMarket.updateClosedCandles(instrument, candles, connectionId);
      }
      await this.resolvePendingEnsembleShadowOutcomes(userId, connectionId, seriesByInstrument);

      const activeSession = await this.executionService.getActiveSession(userId);
      const paperSession =
        activeSession &&
        activeSession.executionMode === ExecutionMode.PAPER_ONLY &&
        activeSession.brokerConnectionId === connectionId
          ? activeSession
          : null;

      // Shadow observation is independent of execution authority. A PAPER
      // session is required only to hand market ownership to the PAPER broker
      // and to permit any future execution path. This lets the prospective
      // campaign collect clean evidence while every old trading session is ended.
      if (paperSession) {
        this.livePaperMarket.registerLiveConnection(connectionId);
        const cacheStatus = this.livePaperMarket.status(connectionId);
        this.logger.log(
          `VPS live market cache primed pairs=${cacheStatus.cachedInstrumentCount}/6 ` +
            `latest=${cacheStatus.latestObservedAt?.toISOString() ?? 'unknown'}`,
        );

        // Heartbeat every instrument after the cache refresh. This makes the
        // PAPER adapter evaluate SL/TP/resting orders against the SAME live
        // closed-candle quote set used by the strategy.
        await this.heartbeatLivePaper(userId, connectionId);
      } else {
        this.logger.debug(
          'Multi-model shadow observation continues without active PAPER execution authority',
        );
      }

      const candidates = [...seriesByInstrument.entries()].flatMap(([instrument, candles]) =>
        buildDirectionalCandidates(instrument, candles),
      );
      this.recordEvaluation(candidates);

      const currentInstruments = new Set(candidates.map((candidate) => candidate.instrument));
      for (const instrument of this.lastPublishedOpportunity.keys()) {
        if (!currentInstruments.has(instrument)) this.lastPublishedOpportunity.delete(instrument);
      }

      // Every closed-bar pair now enters a bidirectional counterfactual contest:
      // BUY and SELL are scored independently from the same immutable market
      // snapshot. Final execution is deferred until both directions have passed
      // through ensemble + governance, so a rejected primary side can be rescued
      // by a genuinely positive-edge opposite side.
      // scanner already runs once per five-minute slot and the deterministic
      // signal id includes the market bar time, so an additional same-direction
      // freshness throttle can hide valid repeat opportunities without adding
      // idempotency. Downstream ensemble, governance, risk, margin and portfolio
      // controls remain authoritative for every candidate.
      const rankedCandidates = candidates.sort((a, b) => b.score - a.score);
      if (rankedCandidates.length === 0) {
        this.logger.log('VPS six-pair scan: no qualifying market snapshot');
        return;
      }

      const candidatesByInstrument = new Map<string, Candidate[]>();
      for (const candidate of rankedCandidates) {
        const pair = candidatesByInstrument.get(candidate.instrument) ?? [];
        pair.push(candidate);
        candidatesByInstrument.set(candidate.instrument, pair);
      }

      let representativeSet = false;
      let representativeIsPaperEligible = false;
      const adaptiveScanStartedAt = new Date();
      const preAdaptiveCandidateRanks = new Map<Candidate, number>(
        rankedCandidates.map((candidate, index) => [candidate, index + 1]),
      );
      const adaptiveAllocationCapital = paperSession
        ? await this.loadAdaptiveAllocationCapital(userId, connectionId)
        : null;
      const initialAdaptivePortfolio = paperSession
        ? await this.loadAdaptiveOpenRiskPositions(userId, connectionId)
        : { available: false, positions: [] as AdaptiveCurrencyRiskPosition[] };
      const adaptiveScanWinners: Array<{
        chosen: ExecutableCounterfactual;
        selection: CounterfactualExecutionSelection;
      }> = [];
      let bestAdaptiveDiagnostic: AdaptiveScanDiagnosticCandidate | null = null;
      const paperSpreadCalibrationHistoryCache = new Map<
        string,
        Promise<PaperSpreadCalibrationHistory>
      >();
      for (const pairCandidates of candidatesByInstrument.values()) {
        const executableCounterfactuals: ExecutableCounterfactual[] = [];

        const rankedPairCandidates = [...pairCandidates].sort((a, b) => b.score - a.score);
        const primaryDirection = rankedPairCandidates[0]?.direction ?? null;
        const pairMetaProbabilities = new Map<'BUY' | 'SELL', number>();
        for (const pairCandidate of rankedPairCandidates) {
          const rawMarketMomentumAtr =
            (pairCandidate.direction === 'BUY' ? 1 : -1) * pairCandidate.shortHorizonMomentumAtr;
          const pairMeta = scorePlanBShadowMeta({
            instrument: pairCandidate.instrument,
            direction: pairCandidate.direction,
            confidence: pairCandidate.confidence,
            extensionAtr: pairCandidate.extensionAtr,
            volatilityScore: pairCandidate.volatilityScore,
            emaSeparation: pairCandidate.emaSeparation,
            mtfStrength: pairCandidate.mtfStrength,
            rsi14: pairCandidate.rsi14,
            shortHorizonMomentumAtr: rawMarketMomentumAtr,
            scanTime: new Date(pairCandidate.barTime.getTime() + BAR_MS),
          });
          pairMetaProbabilities.set(pairCandidate.direction, pairMeta.probability);
        }

        for (const best of rankedPairCandidates) {
          const eventId = `${ACTIVE_ENGINE_CODE}|${best.instrument}|${best.barTime.toISOString()}|${best.direction}`;
          const digits = this.livePaperMarket.spec(best.instrument).digits;
          // Candidates store direction-aligned momentum for ranking/telemetry.
          // Model and governance inputs expect the raw signed price change and
          // align it themselves. Undo candidate alignment once at this boundary.
          const rawMarketMomentumAtr =
            (best.direction === 'BUY' ? 1 : -1) * best.shortHorizonMomentumAtr;
          const v8Shadow = scoreV8ShadowMeta({
            instrument: best.instrument,
            direction: best.direction,
            confidence: best.confidence,
            extensionAtr: best.extensionAtr,
            volatilityScore: best.volatilityScore,
            emaSeparation: best.emaSeparation,
            mtfStrength: best.mtfStrength,
            rsi14: best.rsi14,
            shortHorizonMomentumAtr: rawMarketMomentumAtr,
            // Historical v7 events define scan_time as the close of the selected
            // M5 bar. Keep the prospective shadow feature clock identical.
            scanTime: new Date(best.barTime.getTime() + BAR_MS),
          });
          const planBShadow = scorePlanBShadowMeta({
            instrument: best.instrument,
            direction: best.direction,
            confidence: best.confidence,
            extensionAtr: best.extensionAtr,
            volatilityScore: best.volatilityScore,
            emaSeparation: best.emaSeparation,
            mtfStrength: best.mtfStrength,
            rsi14: best.rsi14,
            shortHorizonMomentumAtr: rawMarketMomentumAtr,
            scanTime: new Date(best.barTime.getTime() + BAR_MS),
          });
          const portfolioPositions: PlanBPortfolioPosition[] = [];
          let portfolioSnapshotAvailable = false;
          try {
            const getPositions = this.brokerService.getOpenPositionsForConnection?.bind(
              this.brokerService,
            );
            if (getPositions) {
              const snapshot = await getPositions(connectionId, userId);
              portfolioPositions.push(
                ...snapshot.positions.map((position) => ({
                  instrument: position.instrument,
                  direction: position.direction,
                  lotSize: position.lotSize,
                })),
              );
              portfolioSnapshotAvailable = true;
            }
          } catch (error) {
            this.logger.warn(
              `Plan B portfolio shadow snapshot unavailable: ${(error as Error).message}`,
            );
          }
          const planBEnsemble = scorePlanBMultimodelShadow(
            {
              instrument: best.instrument,
              direction: best.direction,
              confidence: best.confidence,
              extensionAtr: best.extensionAtr,
              volatilityScore: best.volatilityScore,
              emaSeparation: best.emaSeparation,
              mtfStrength: best.mtfStrength,
              rsi14: best.rsi14,
              shortHorizonMomentumAtr: rawMarketMomentumAtr,
              scanTime: new Date(best.barTime.getTime() + BAR_MS),
            },
            portfolioPositions,
          );
          const highConvictionOverlay = await this.evaluateHighConvictionOverlay(userId, best);
          const sleeveEvidence = await this.loadEnsembleSleeveEvidence(
            userId,
            connectionId,
            best.instrument,
            best.direction,
          );
          const macroEventAssessment: MacroEventRiskAssessment = this.macroEventRisk
            ? await this.macroEventRisk.assess(
                best.instrument,
                new Date(best.barTime.getTime() + BAR_MS),
              )
            : {
                state: 'UNVERIFIED',
                provider: 'NONE',
                configured: false,
                checkedAt: new Date().toISOString(),
                instrument: best.instrument,
                relevantCountries: [],
                blockWindowMinutesBefore: 30,
                blockWindowMinutesAfter: 30,
                blockingEvents: [],
                reason: 'SERVICE_NOT_AVAILABLE',
                attribution: null,
              };
          const evaluatedAt = new Date();
          const fixedPaperSpreadPrice = PAPER_MARKET_SPECS[best.instrument]?.spread ?? 0;
          const paperSpreadSession = classifyPaperSpreadSession(evaluatedAt);
          const paperSpreadHistoryCacheKey = `${best.instrument}|${paperSpreadSession}`;
          let paperSpreadHistoryPromise = paperSpreadCalibrationHistoryCache.get(
            paperSpreadHistoryCacheKey,
          );
          if (!paperSpreadHistoryPromise) {
            paperSpreadHistoryPromise = this.loadPaperSpreadCalibrationHistory(
              best.instrument,
              evaluatedAt,
            );
            paperSpreadCalibrationHistoryCache.set(
              paperSpreadHistoryCacheKey,
              paperSpreadHistoryPromise,
            );
          }
          const paperSpreadCalibrationHistory = await paperSpreadHistoryPromise;
          const paperSpreadCalibrationShadow = evaluatePaperSpreadCalibrationShadow({
            instrument: best.instrument,
            evaluatedAt,
            fixedSpreadPrice: fixedPaperSpreadPrice,
            stopDistancePrice: Math.abs(best.entry - best.stopLoss),
            history: paperSpreadCalibrationHistory,
          });
          const executionSpreadEvidence = await this.loadExecutionSpreadEvidence(
            best.instrument,
            evaluatedAt,
          );
          const calibratedPaperSpreadPrice =
            paperSpreadCalibrationShadow.reason === 'CALIBRATED_P95_WITH_FLOOR' &&
            paperSpreadCalibrationShadow.calibratedSpreadPrice > 0
              ? paperSpreadCalibrationShadow.calibratedSpreadPrice
              : fixedPaperSpreadPrice;
          if (paperSession && calibratedPaperSpreadPrice > 0) {
            this.livePaperMarket.setPaperFallbackSpread(
              best.instrument,
              calibratedPaperSpreadPrice,
              connectionId,
            );
          }
          // Standard PAPER governance never becomes looser because of historical
          // calibration: it uses the worse of fixed and calibrated fallback cost.
          // A lower calibrated cost may be used only by the separately gated
          // calibrated-cost PAPER research rescue below; final lot remains risk-sized.
          const standardPaperSpreadPrice = paperSession
            ? Math.max(fixedPaperSpreadPrice, calibratedPaperSpreadPrice)
            : undefined;
          const governanceInput = {
            ensemble: planBEnsemble,
            instrument: best.instrument,
            direction: best.direction,
            entryPrice: best.entry,
            stopLoss: best.stopLoss,
            takeProfit: best.takeProfit,
            confidence: best.confidence,
            extensionAtr: best.extensionAtr,
            volatilityScore: best.volatilityScore,
            emaSeparation: best.emaSeparation,
            mtfStrength: best.mtfStrength,
            rsi14: best.rsi14,
            shortHorizonMomentumAtr: rawMarketMomentumAtr,
            eventRisk: macroEventAssessment.state,
            sleeveEvidence,
            evaluatedAt,
            executionSpreadEvidence,
          };
          const fixedPaperGovernance = evaluateEnsembleGovernance({
            ...governanceInput,
            paperSimulationSpreadPrice: paperSession ? fixedPaperSpreadPrice : undefined,
          });
          let ensembleGovernance =
            standardPaperSpreadPrice === fixedPaperSpreadPrice
              ? fixedPaperGovernance
              : evaluateEnsembleGovernance({
                  ...governanceInput,
                  paperSimulationSpreadPrice: standardPaperSpreadPrice,
                });
          const paperSimulationSpreadPrice = standardPaperSpreadPrice;
          const paperPostLossEntryState = await this.loadPaperPostLossEntryState(
            userId,
            connectionId,
            best.instrument,
            best.direction,
          );
          const paperPostLossEntryGuard = evaluatePaperPostLossEntryGuard({
            state: paperPostLossEntryState,
            marketBarOpenedAt: best.barTime,
            evaluatedAt,
            alignedMomentumAtr: best.shortHorizonMomentumAtr,
            netExpectedR: ensembleGovernance.netExpectedR,
            driftState: ensembleGovernance.driftState,
            consensusPassed: planBEnsemble.consensusPassed,
            consensusRequired: planBEnsemble.consensusRequired,
            eventRisk: ensembleGovernance.eventRisk,
            executionCostUsable: Boolean(
              ensembleGovernance.paperExecutionCostUsable ??
              ensembleGovernance.executionSpreadEvidenceValid,
            ),
          });
          if (paperSession && !paperPostLossEntryGuard.eligible) {
            const blocker = `PAPER_POST_LOSS_${paperPostLossEntryGuard.reason}`;
            ensembleGovernance = {
              ...ensembleGovernance,
              paperExecutionEligible: false,
              paperExecutionBlockers: Array.from(
                new Set([...ensembleGovernance.paperExecutionBlockers, blocker]),
              ),
            };
            this.logger.log(
              `PAPER post-loss guard ${best.instrument} ${best.direction} execution=BLOCKED ` +
                `reason=${paperPostLossEntryGuard.reason} lastTrade=${paperPostLossEntryGuard.lastClosedTradeId ?? 'none'}`,
            );
          }
          const decision = {
            evaluatedAt,
            instrument: best.instrument,
            direction: best.direction,
            paperAdmitted: planBEnsemble.paperAdmitted,
            admitted: planBEnsemble.admitted,
            candidateConfidence: best.confidence,
            ensembleScore: planBEnsemble.ensembleScore,
            metaProbability: planBEnsemble.metaProbability,
            expectedR: planBEnsemble.expectedR,
            consensusPassed: planBEnsemble.consensusPassed,
            consensusRequired: planBEnsemble.consensusRequired,
            regime: planBEnsemble.regime,
            reasons: planBEnsemble.reasons,
            governance: ensembleGovernance,
            macroEventAssessment,
            highConvictionOverlay,
          };
          if (
            !representativeSet ||
            (!representativeIsPaperEligible && ensembleGovernance.paperExecutionEligible)
          ) {
            this.lastEnsembleDecision = decision;
            representativeSet = true;
            representativeIsPaperEligible = ensembleGovernance.paperExecutionEligible;
          }
          const normalPaperExecutionCandidate = canExecuteMultiModelPaper(
            planBEnsemble,
            ensembleGovernance,
          );
          await this.persistEnsembleShadowDecision(
            userId,
            paperSession?.id ?? null,
            connectionId,
            eventId,
            best,
            planBEnsemble,
            portfolioSnapshotAvailable,
            ensembleGovernance,
            macroEventAssessment,
            highConvictionOverlay,
            paperPostLossEntryGuard,
            paperSpreadCalibrationShadow,
          );
          const preliminaryAdaptive = await this.evaluateAdaptiveCore({
            userId,
            connectionId,
            candidate: best,
            ensemble: planBEnsemble,
            governance: ensembleGovernance,
            executionRoute: normalPaperExecutionCandidate ? 'NORMAL_PAPER' : 'NONE',
            evaluatedAt,
            allocationCapital: adaptiveAllocationCapital,
            portfolio: initialAdaptivePortfolio,
          });
          const preliminaryRank = preAdaptiveCandidateRanks.get(best) ?? rankedCandidates.length;
          const diagnosticCandidate: AdaptiveScanDiagnosticCandidate = {
            instrument: best.instrument,
            direction: best.direction,
            adaptiveScore: preliminaryAdaptive.opportunity.score,
            netExpectedR: preliminaryAdaptive.netExpectedR,
            state: preliminaryAdaptive.marketState.state,
            blockers: preliminaryAdaptive.opportunity.hardBlockers,
          };
          if (
            Number.isFinite(diagnosticCandidate.netExpectedR) &&
            Number.isFinite(diagnosticCandidate.adaptiveScore) &&
            (bestAdaptiveDiagnostic === null ||
              diagnosticCandidate.netExpectedR > bestAdaptiveDiagnostic.netExpectedR ||
              (diagnosticCandidate.netExpectedR === bestAdaptiveDiagnostic.netExpectedR &&
                diagnosticCandidate.adaptiveScore > bestAdaptiveDiagnostic.adaptiveScore))
          ) {
            bestAdaptiveDiagnostic = diagnosticCandidate;
          }
          await this.persistAdaptiveDecisionAnnotation(
            userId,
            eventId,
            this.adaptiveMarketIntelligencePayload(
              {
                marketState: preliminaryAdaptive.marketState,
                edge: preliminaryAdaptive.edge,
                exposure: preliminaryAdaptive.exposure,
                opportunity: preliminaryAdaptive.opportunity,
                riskMultiplier: preliminaryAdaptive.riskMultiplier,
                predictionCalibration: preliminaryAdaptive.predictionCalibration,
                rawNetExpectedR: preliminaryAdaptive.rawNetExpectedR,
                candidateRiskAtStop: preliminaryAdaptive.candidateRiskAtStop,
                requestedRiskPercent: preliminaryAdaptive.requestedRiskPercent,
                adaptiveScore: preliminaryAdaptive.opportunity.score,
                netExpectedR: preliminaryAdaptive.netExpectedR,
                executionCostR: preliminaryAdaptive.executionCostR,
                preAdaptiveScanRank: preliminaryRank,
              },
              normalPaperExecutionCandidate ? 'NORMAL_PAPER' : 'NONE',
            ),
          );
          let paperTrendRouteReliability: PaperTrendRouteReliabilityDecision | null = null;
          let paperTrendPairSideReliability: PaperTrendPairSideReliabilityDecision | null = null;
          let paperTrendPairSideReliabilityShadow: PaperTrendPairSideReliabilityShadowDecision | null =
            null;
          let normalPaperExecution = normalPaperExecutionCandidate;
          if (
            normalPaperExecutionCandidate &&
            planBEnsemble.strategyRoute === 'TREND_CONTINUATION'
          ) {
            const routeEvidence = await this.loadPaperTrendRouteReliabilityEvidence(
              userId,
              connectionId,
            );
            paperTrendRouteReliability = evaluatePaperTrendRouteReliability({
              strategyRoute: planBEnsemble.strategyRoute,
              evidence: routeEvidence,
            });
            const pairSideEvidence = await this.loadPaperTrendPairSideReliabilityEvidence(
              userId,
              connectionId,
              best.instrument,
              best.direction,
            );
            paperTrendPairSideReliabilityShadow = evaluatePaperTrendPairSideReliabilityShadow({
              strategyRoute: planBEnsemble.strategyRoute,
              evidence: pairSideEvidence,
            });
            paperTrendPairSideReliability = evaluatePaperTrendPairSideReliability({
              strategyRoute: planBEnsemble.strategyRoute,
              evidence: pairSideEvidence,
            });
            this.logger.log(
              `PAPER pair-side reliability shadow ${best.instrument} ${best.direction} ` +
                `state=${paperTrendPairSideReliabilityShadow.state} ` +
                `episodes=${paperTrendPairSideReliabilityShadow.episodes} ` +
                `profitFactor=${paperTrendPairSideReliabilityShadow.profitFactor ?? 'n/a'} ` +
                `maxDrawdown=${paperTrendPairSideReliabilityShadow.maxDrawdown ?? 'n/a'} ` +
                `executionAuthority=${paperTrendPairSideReliabilityShadow.executionAuthority}`,
            );
            const reliabilityExecutionGate = evaluatePaperTrendReliabilityExecutionGate({
              route: paperTrendRouteReliability,
              pairSide: paperTrendPairSideReliability,
            });
            if (!paperTrendRouteReliability.fullSizeEligible) {
              this.logger.warn(
                `PAPER trend-route reliability ${best.instrument} ${best.direction} execution=DIAGNOSTIC_ONLY ` +
                  `state=${paperTrendRouteReliability.state} reason=${paperTrendRouteReliability.reason} ` +
                  `episodes=${paperTrendRouteReliability.episodes} ` +
                  `profitFactor=${paperTrendRouteReliability.profitFactor ?? 'n/a'} ` +
                  `maxDrawdown=${paperTrendRouteReliability.maxDrawdown ?? 'n/a'}`,
              );
            }
            if (!reliabilityExecutionGate.fullSizeEligible) {
              normalPaperExecution = false;
              this.logger.warn(
                `PAPER pair-side reliability ${best.instrument} ${best.direction} fullSize=DEMOTED ` +
                  `state=${paperTrendPairSideReliability.state} reason=${paperTrendPairSideReliability.reason} ` +
                  `episodes=${paperTrendPairSideReliability.episodes} ` +
                  `profitFactor=${paperTrendPairSideReliability.profitFactor ?? 'n/a'} ` +
                  `maxDrawdown=${paperTrendPairSideReliability.maxDrawdown ?? 'n/a'}`,
              );
            }
          }
          const pairSideReliabilityDemoted = normalPaperExecutionCandidate && !normalPaperExecution;
          const canaryEvaluationState = rejectedEdgeCanaryEvaluationState({
            normalPaperExecution: normalPaperExecutionCandidate,
            evidenceServiceAvailable: Boolean(this.ensemblePostEntryProtection),
            netExpectedR: ensembleGovernance.netExpectedR,
          });
          const extensionExhaustionDiagnostic = scoreExtensionExhaustionShadow({
            regime: planBEnsemble.regime,
            driftState: ensembleGovernance.driftState,
            confidence: best.confidence,
            netExpectedR: ensembleGovernance.netExpectedR,
            directionQuality: planBEnsemble.directionQuality,
            tradeQuality: planBEnsemble.tradeQuality,
            exitQuality: planBEnsemble.exitQuality,
            extensionAtr: best.extensionAtr,
            executionSpreadEvidenceValid: ensembleGovernance.executionSpreadEvidenceValid,
          });
          let rejectedEdgeCanary: RejectedEdgeCanaryDecision | null = null;
          let rejectedEdgeCanaryEvidence: RejectedEdgeCanaryEvidence | null = null;
          if (canaryEvaluationState === 'EVALUATED' && this.ensemblePostEntryProtection) {
            rejectedEdgeCanaryEvidence =
              await this.ensemblePostEntryProtection.getRejectedEdgeCanaryEvidence(
                userId,
                best.instrument,
                best.direction,
              );
            rejectedEdgeCanary = evaluateRejectedEdgePaperCanary({
              candidate: {
                confidence: best.confidence,
                netExpectedR: ensembleGovernance.netExpectedR,
                alignedMomentumAtr: best.shortHorizonMomentumAtr,
                executionSpreadEvidenceValid: ensembleGovernance.executionSpreadEvidenceValid,
                paperExecutionCostUsable: ensembleGovernance.paperExecutionCostUsable,
                eventRisk: ensembleGovernance.eventRisk,
                portfolioQuality: planBEnsemble.portfolioQuality,
                strategyRoute: planBEnsemble.strategyRoute,
                paperExecutionBlockers: ensembleGovernance.paperExecutionBlockers,
              },
              evidence: rejectedEdgeCanaryEvidence,
            });
          }
          const fixedPaperResearchThroughputInput = {
            normalPaperExecution,
            confidence: best.confidence,
            netExpectedR: fixedPaperGovernance.netExpectedR,
            executionSpreadEvidenceValid: fixedPaperGovernance.executionSpreadEvidenceValid,
            paperExecutionCostUsable: fixedPaperGovernance.paperExecutionCostUsable,
            eventRisk: fixedPaperGovernance.eventRisk,
            strategyRoute: planBEnsemble.strategyRoute,
            driftState: fixedPaperGovernance.driftState,
            driftDiagnostics: fixedPaperGovernance.driftDiagnostics,
            directionQuality: planBEnsemble.directionQuality,
            alignedMomentumAtr: best.shortHorizonMomentumAtr,
            tradeQuality: planBEnsemble.tradeQuality,
            exitQuality: planBEnsemble.exitQuality,
            paperExecutionBlockers: fixedPaperGovernance.paperExecutionBlockers,
            routeReliabilityDemoted: pairSideReliabilityDemoted,
          };
          const paperCalibratedCostRescue = evaluatePaperCalibratedCostResearchRescue({
            grossExpectedR: fixedPaperGovernance.grossExpectedR,
            fixedNetExpectedR: fixedPaperGovernance.netExpectedR,
            researchInput: fixedPaperResearchThroughputInput,
            calibration: paperSpreadCalibrationShadow,
            freshBrokerSpreadAvailable: Boolean(executionSpreadEvidence),
          });
          if (paperSession && paperCalibratedCostRescue.eligible) {
            ensembleGovernance = evaluateEnsembleGovernance({
              ...governanceInput,
              paperSimulationSpreadPrice: calibratedPaperSpreadPrice,
            });
          }

          const researchCalibrationRequest = {
            userId,
            brokerConnectionId: connectionId,
            instrument: best.instrument,
            direction: best.direction,
            session: preliminaryAdaptive.marketState.session,
            state: preliminaryAdaptive.marketState.state,
            strategyRoute: planBEnsemble.strategyRoute,
            decisionPolicyVersions: PLAN_B_PREDICTION_CALIBRATION_EVIDENCE_POLICY_VERSIONS,
            evaluatedAt,
            rawConfidence: best.confidence,
            rawNetExpectedR: ensembleGovernance.netExpectedR,
          } as const;
          const researchPredictionCalibration = this.adaptivePredictionCalibration
            ? await this.adaptivePredictionCalibration.getCalibration(researchCalibrationRequest)
            : unavailableAdaptivePredictionCalibration(researchCalibrationRequest);
          const researchCalibrationAuthority = applyAdaptivePredictionCalibrationAuthority({
            calibration: researchPredictionCalibration,
            rawConfidence: best.confidence,
            rawNetExpectedR: ensembleGovernance.netExpectedR,
            paperExecutionBlockers: ensembleGovernance.paperExecutionBlockers,
            allowResearchRescue: true,
          });
          const paperResearchCalibrationBrake = evaluatePaperResearchCalibrationBrake({
            authoritative: researchPredictionCalibration.authoritative,
            sourceLevel: researchPredictionCalibration.sourceLevel,
            maturity: researchPredictionCalibration.maturity,
            samples: researchPredictionCalibration.samples,
            calibratedNetExpectedR: researchPredictionCalibration.calibratedNetExpectedR,
            recentDegradation: researchPredictionCalibration.recentDegradation,
          });

          const paperResearchThroughputInput = {
            normalPaperExecution,
            confidence: researchCalibrationAuthority.effectiveConfidence,
            netExpectedR: researchCalibrationAuthority.effectiveNetExpectedR,
            executionSpreadEvidenceValid: ensembleGovernance.executionSpreadEvidenceValid,
            paperExecutionCostUsable: ensembleGovernance.paperExecutionCostUsable,
            eventRisk: ensembleGovernance.eventRisk,
            strategyRoute: planBEnsemble.strategyRoute,
            driftState: ensembleGovernance.driftState,
            driftDiagnostics: ensembleGovernance.driftDiagnostics,
            directionQuality: planBEnsemble.directionQuality,
            alignedMomentumAtr: best.shortHorizonMomentumAtr,
            tradeQuality: planBEnsemble.tradeQuality,
            exitQuality: planBEnsemble.exitQuality,
            paperExecutionBlockers: researchCalibrationAuthority.effectivePaperExecutionBlockers,
            routeReliabilityDemoted: pairSideReliabilityDemoted,
          };
          let paperResearchThroughput = evaluatePaperResearchThroughput(
            paperResearchThroughputInput,
          );
          const paperResearchQualityLimited =
            paperResearchThroughput.reason === 'DIRECTION_QUALITY_TOO_LOW' ||
            paperResearchThroughput.reason === 'TRADE_QUALITY_TOO_LOW' ||
            paperResearchThroughput.reason === 'EXIT_QUALITY_TOO_LOW';
          const paperResearchAccelerationEvidenceCandidate =
            paperResearchQualityLimited &&
            Number.isFinite(researchCalibrationAuthority.effectiveConfidence) &&
            researchCalibrationAuthority.effectiveConfidence >=
              PAPER_RESEARCH_EXPLORATION_MIN_CONFIDENCE &&
            Number.isFinite(researchCalibrationAuthority.effectiveNetExpectedR) &&
            researchCalibrationAuthority.effectiveNetExpectedR >=
              PAPER_RESEARCH_THROUGHPUT_MIN_NET_EXPECTED_R &&
            (ensembleGovernance.paperExecutionCostUsable ??
              ensembleGovernance.executionSpreadEvidenceValid) &&
            ensembleGovernance.eventRisk === 'CLEAR';
          const paperResearchEpisodeKey = `${best.instrument}|${best.direction}|${planBEnsemble.regime}|${planBEnsemble.strategyRoute}`;
          let paperResearchPairSideReliability: PaperResearchPairSideReliabilityDecision | null =
            null;
          let paperResearchEpisodeGuard: ReturnType<
            typeof evaluatePaperResearchEpisodeGuard
          > | null = null;
          if (paperResearchThroughput.eligible || paperResearchAccelerationEvidenceCandidate) {
            const reliabilityEvidence = await this.loadPaperResearchPairSideEvidence(
              userId,
              connectionId,
              best.instrument,
              best.direction,
            );
            paperResearchPairSideReliability =
              evaluatePaperResearchPairSideReliability(reliabilityEvidence);

            if (!paperResearchThroughput.eligible && paperResearchAccelerationEvidenceCandidate) {
              paperResearchThroughput = evaluatePaperResearchThroughput({
                ...paperResearchThroughputInput,
                pairSideReliability: paperResearchPairSideReliability,
              });
            }

            if (paperResearchThroughput.eligible && !paperResearchPairSideReliability.eligible) {
              this.logger.warn(
                `PAPER research-throughput ${best.instrument} ${best.direction} execution=SHADOW_ONLY ` +
                  `reason=${paperResearchPairSideReliability.reason} samples=${paperResearchPairSideReliability.samples} ` +
                  `wins=${paperResearchPairSideReliability.wins} losses=${paperResearchPairSideReliability.losses} ` +
                  `smoothedExpectedR=${paperResearchPairSideReliability.smoothedExpectedR.toFixed(4)} ` +
                  `realisedRSamples=${paperResearchPairSideReliability.realisedRSamples} ` +
                  `realisedAverageR=${paperResearchPairSideReliability.realisedAverageR?.toFixed(4) ?? 'n/a'}`,
              );
            } else if (paperResearchThroughput.eligible) {
              const previousEpisode = await this.loadPaperResearchEpisodeState(
                userId,
                connectionId,
                best.instrument,
                best.direction,
              );
              paperResearchEpisodeGuard = evaluatePaperResearchEpisodeGuard({
                currentEpisodeKey: paperResearchEpisodeKey,
                previousEpisodeKey: previousEpisode.previousEpisodeKey,
                previousTradeStatus: previousEpisode.previousTradeStatus,
                previousClosedAt: previousEpisode.previousClosedAt,
                evaluatedAt: new Date(),
              });
              if (!paperResearchEpisodeGuard.eligible) {
                this.logger.log(
                  `PAPER research-throughput ${best.instrument} ${best.direction} execution=SHADOW_ONLY ` +
                    `reason=${paperResearchEpisodeGuard.reason} episode=${paperResearchEpisodeKey}`,
                );
              }
            }
          }
          let paperResearchPortfolioBrake = evaluatePaperResearchPortfolioBrake({ outcomes: [] });
          if (
            paperResearchThroughput.eligible &&
            Boolean(paperResearchPairSideReliability?.eligible) &&
            Boolean(paperResearchEpisodeGuard?.eligible) &&
            !paperResearchCalibrationBrake.blocked
          ) {
            paperResearchPortfolioBrake = evaluatePaperResearchPortfolioBrake({
              outcomes: await this.loadPaperResearchPortfolioOutcomes(userId, connectionId),
            });
          }
          const paperResearchExecutionGate = evaluatePaperResearchExecutionGate({
            throughputEligible: paperResearchThroughput.eligible,
            pairSideEligible: Boolean(paperResearchPairSideReliability?.eligible),
            episodeEligible: Boolean(paperResearchEpisodeGuard?.eligible),
            calibrationBlocked: paperResearchCalibrationBrake.blocked,
            portfolioBlocked: paperResearchPortfolioBrake.blocked,
          });
          const paperResearchExecutionEligible = paperResearchExecutionGate.eligible;
          if (paperResearchThroughput.eligible && !paperResearchExecutionEligible) {
            this.logger.warn(
              `PAPER research-throughput ${best.instrument} ${best.direction} execution=SHADOW_ONLY ` +
                `reason=${paperResearchExecutionGate.reason} calibrationBrake=${paperResearchCalibrationBrake.reason} ` +
                `portfolioBrake=${paperResearchPortfolioBrake.reason} recentPortfolio=${paperResearchPortfolioBrake.wins}W/${paperResearchPortfolioBrake.losses}L`,
            );
          }
          const paperExtensionExhaustionResearch = evaluatePaperExtensionExhaustionResearch({
            regime: planBEnsemble.regime,
            driftState: ensembleGovernance.driftState,
            confidence: best.confidence,
            netExpectedR: ensembleGovernance.netExpectedR,
            directionQuality: planBEnsemble.directionQuality,
            tradeQuality: planBEnsemble.tradeQuality,
            exitQuality: planBEnsemble.exitQuality,
            extensionAtr: best.extensionAtr,
            eventRisk: ensembleGovernance.eventRisk,
            paperExecutionCostUsable: Boolean(
              ensembleGovernance.paperExecutionCostUsable ??
              ensembleGovernance.executionSpreadEvidenceValid,
            ),
          });
          const paperExtensionExhaustionEpisodeKey = `${best.instrument}|${best.direction}|${planBEnsemble.regime}|PAPER_EXTENSION_EXHAUSTION_RESEARCH`;
          let paperExtensionExhaustionPairSideReliability: PaperResearchPairSideReliabilityDecision | null =
            null;
          let paperExtensionExhaustionEpisodeGuard: ReturnType<
            typeof evaluatePaperResearchEpisodeGuard
          > | null = null;
          if (
            paperExtensionExhaustionResearch.eligible &&
            !researchPredictionCalibration.blockRecommended
          ) {
            const inheritedReliabilityEvidence = paperResearchPairSideReliability
              ? null
              : await this.loadPaperResearchPairSideEvidence(
                  userId,
                  connectionId,
                  best.instrument,
                  best.direction,
                );
            const extensionRouteReliabilityEvidence =
              await this.loadPaperExtensionExhaustionPairSideEvidence(
                userId,
                connectionId,
                best.instrument,
                best.direction,
              );
            if (
              paperResearchPairSideReliability &&
              extensionRouteReliabilityEvidence.wins === 0 &&
              extensionRouteReliabilityEvidence.losses === 0
            ) {
              paperExtensionExhaustionPairSideReliability = paperResearchPairSideReliability;
            } else {
              const inherited = inheritedReliabilityEvidence ?? {
                wins: paperResearchPairSideReliability?.wins ?? 0,
                losses: paperResearchPairSideReliability?.losses ?? 0,
                realisedRSamples: paperResearchPairSideReliability?.realisedRSamples ?? 0,
                realisedRSum:
                  (paperResearchPairSideReliability?.realisedAverageR ?? 0) *
                  (paperResearchPairSideReliability?.realisedRSamples ?? 0),
              };
              paperExtensionExhaustionPairSideReliability =
                evaluatePaperResearchPairSideReliability({
                  wins: inherited.wins + extensionRouteReliabilityEvidence.wins,
                  losses: inherited.losses + extensionRouteReliabilityEvidence.losses,
                  realisedRSamples:
                    inherited.realisedRSamples + extensionRouteReliabilityEvidence.realisedRSamples,
                  realisedRSum:
                    inherited.realisedRSum + extensionRouteReliabilityEvidence.realisedRSum,
                });
            }
            if (!paperExtensionExhaustionPairSideReliability.eligible) {
              this.logger.warn(
                `PAPER extension-exhaustion ${best.instrument} ${best.direction} execution=SHADOW_ONLY ` +
                  `reason=${paperExtensionExhaustionPairSideReliability.reason} samples=${paperExtensionExhaustionPairSideReliability.samples} ` +
                  `realisedRSamples=${paperExtensionExhaustionPairSideReliability.realisedRSamples} ` +
                  `realisedAverageR=${paperExtensionExhaustionPairSideReliability.realisedAverageR?.toFixed(4) ?? 'n/a'}`,
              );
            } else {
              const previousExtensionEpisode = await this.loadPaperExtensionExhaustionEpisodeState(
                userId,
                connectionId,
                best.instrument,
                best.direction,
              );
              paperExtensionExhaustionEpisodeGuard = evaluatePaperResearchEpisodeGuard({
                currentEpisodeKey: paperExtensionExhaustionEpisodeKey,
                previousEpisodeKey: previousExtensionEpisode.previousEpisodeKey,
                previousTradeStatus: previousExtensionEpisode.previousTradeStatus,
                previousClosedAt: previousExtensionEpisode.previousClosedAt,
                evaluatedAt,
              });
            }
          }
          const paperExtensionExhaustionResearchEligible =
            paperExtensionExhaustionResearch.eligible &&
            !researchPredictionCalibration.blockRecommended &&
            Boolean(paperExtensionExhaustionPairSideReliability?.eligible) &&
            Boolean(paperExtensionExhaustionEpisodeGuard?.eligible);
          const pairedDirectionReversal = evaluatePairedDirectionReversal({
            primaryDirection: primaryDirection ?? best.direction,
            buyProbability: pairMetaProbabilities.get('BUY') ?? 0,
            sellProbability: pairMetaProbabilities.get('SELL') ?? 0,
            rawMomentumAtr: rawMarketMomentumAtr,
            baseRegime: planBEnsemble.regime,
            executionCostR: ensembleGovernance.estimatedExecutionCostR,
            targetRMultiple: TARGET_ATR_MULTIPLIER / STOP_ATR_MULTIPLIER,
          });
          const pairedReversalGovernance =
            pairedDirectionReversal.reversalCandidate &&
            pairedDirectionReversal.preferredDirection === best.direction
              ? evaluateEnsembleGovernance({
                  ensemble: planBEnsemble,
                  instrument: best.instrument,
                  direction: best.direction,
                  entryPrice: best.entry,
                  stopLoss: best.stopLoss,
                  takeProfit: best.takeProfit,
                  confidence: best.confidence,
                  extensionAtr: best.extensionAtr,
                  volatilityScore: best.volatilityScore,
                  emaSeparation: best.emaSeparation,
                  mtfStrength: best.mtfStrength,
                  rsi14: best.rsi14,
                  shortHorizonMomentumAtr: rawMarketMomentumAtr,
                  eventRisk: macroEventAssessment.state,
                  sleeveEvidence,
                  evaluatedAt,
                  executionSpreadEvidence,
                  paperSimulationSpreadPrice,
                  driftRoute: 'PAIRED_REVERSAL_RESEARCH',
                })
              : ensembleGovernance;
          const pairedReversalResearch = evaluatePaperPairedReversalResearch({
            candidateDirection: best.direction,
            preferredDirection: pairedDirectionReversal.preferredDirection,
            reversalCandidate: pairedDirectionReversal.reversalCandidate,
            researchNetExpectedR: pairedDirectionReversal.researchNetExpectedR,
            executionSpreadEvidenceValid: pairedReversalGovernance.executionSpreadEvidenceValid,
            paperExecutionCostUsable: pairedReversalGovernance.paperExecutionCostUsable,
            eventRisk: pairedReversalGovernance.eventRisk,
            driftState: pairedReversalGovernance.driftState,
          });
          const pairedReversalEpisodeKey = `${best.instrument}|${best.direction}|${planBEnsemble.regime}|PAIRED_REVERSAL_RESEARCH`;
          let pairedReversalEpisodeGuard: ReturnType<
            typeof evaluatePaperResearchEpisodeGuard
          > | null = null;
          if (pairedReversalResearch.eligible) {
            const previousEpisode = await this.loadPaperPairedReversalEpisodeState(
              userId,
              connectionId,
              best.instrument,
              best.direction,
            );
            pairedReversalEpisodeGuard = evaluatePaperResearchEpisodeGuard({
              currentEpisodeKey: pairedReversalEpisodeKey,
              previousEpisodeKey: previousEpisode.previousEpisodeKey,
              previousTradeStatus: previousEpisode.previousTradeStatus,
              previousClosedAt: previousEpisode.previousClosedAt,
              evaluatedAt,
            });
          }
          const pairedReversalResearchEligible =
            pairedReversalResearch.eligible && Boolean(pairedReversalEpisodeGuard?.eligible);
          const selectedPaperExecutionRoute = selectPaperExecutionRoute({
            normalPaperExecution,
            rejectedEdgeCanaryEligible: Boolean(rejectedEdgeCanary?.eligible),
            paperResearchThroughputEligible: paperResearchExecutionEligible,
            extensionExhaustionResearchEligible: paperExtensionExhaustionResearchEligible,
            pairedReversalResearchEligible,
          });
          let paperExecutionRoute = paperPostLossEntryGuard.eligible
            ? selectedPaperExecutionRoute
            : 'NONE';
          const paperCostAwareEvidence =
            paperExecutionRoute === 'PAPER_RESEARCH_THROUGHPUT'
              ? await this.loadPaperCostAwareEntryEvidence(
                  userId,
                  connectionId,
                  best.instrument,
                  best.direction,
                )
              : { grossPositiveSamples: 0, costFlippedSamples: 0, netPositiveSamples: 0 };
          const paperCostAwareEntry = evaluatePaperCostAwareEntry({
            executionRoute: paperExecutionRoute === 'NONE' ? 'NORMAL_PAPER' : paperExecutionRoute,
            grossExpectedR: ensembleGovernance.grossExpectedR,
            netExpectedR: researchCalibrationAuthority.effectiveNetExpectedR,
            estimatedExecutionCostR: ensembleGovernance.estimatedExecutionCostR,
            calibratedCostRescue: paperCalibratedCostRescue.eligible,
            evidence: paperCostAwareEvidence,
          });
          if (paperExecutionRoute !== 'NONE') {
            await this.annotatePaperCostAwareEntryDecision(
              userId,
              connectionId,
              eventId,
              paperCostAwareEntry,
              paperCostAwareEvidence,
            );
          }
          if (
            paperExecutionRoute === 'PAPER_RESEARCH_THROUGHPUT' &&
            paperCostAwareEntry.action !== 'ENTER_NOW'
          ) {
            this.logger.log(
              `PAPER cost-aware entry ${best.instrument} ${best.direction} execution=${paperCostAwareEntry.action} ` +
                `reason=${paperCostAwareEntry.reason} costFlipRate=${paperCostAwareEntry.costFlipRate?.toFixed(4) ?? 'n/a'} ` +
                `currentCostRatio=${paperCostAwareEntry.currentCostRatio?.toFixed(4) ?? 'n/a'} ` +
                `qualificationEvidence=false`,
            );
            paperExecutionRoute = 'NONE';
          }
          if (
            paperExecutionRoute === 'PAPER_RESEARCH_THROUGHPUT' &&
            paperCostAwareEntry.action === 'ENTER_NOW'
          ) {
            this.logger.log(
              `PAPER research-throughput ${best.instrument} ${best.direction} ` +
                `execution=ELIGIBLE executionAuthority=PAPER_ONLY_RESEARCH ` +
                `netExpectedR=${researchCalibrationAuthority.effectiveNetExpectedR.toFixed(4)} ` +
                `rawNetExpectedR=${ensembleGovernance.netExpectedR.toFixed(4)} ` +
                `calibration=${researchPredictionCalibration.reason} ` +
                `qualificationEvidence=false`,
            );
          }
          if (paperExtensionExhaustionResearchEligible) {
            this.logger.log(
              `PAPER extension-exhaustion ${best.instrument} ${best.direction} ` +
                `execution=ELIGIBLE executionAuthority=PAPER_ONLY_RESEARCH ` +
                `netExpectedR=${ensembleGovernance.netExpectedR.toFixed(4)} ` +
                `calibration=${researchPredictionCalibration.reason} qualificationEvidence=false`,
            );
          }
          if (pairedReversalResearchEligible) {
            this.logger.log(
              `PAPER paired-reversal ${best.instrument} ${best.direction} ` +
                `execution=ELIGIBLE executionAuthority=PAPER_ONLY_RESEARCH ` +
                `directionProbability=${(best.direction === 'BUY' ? pairedDirectionReversal.buyDirectionalProbability : pairedDirectionReversal.sellDirectionalProbability).toFixed(4)} ` +
                `researchNetExpectedR=${pairedDirectionReversal.researchNetExpectedR.toFixed(4)} ` +
                `qualificationEvidence=false`,
            );
          }
          if (paperExecutionRoute === 'NONE') {
            this.logger.log(
              `Multi-model ensemble ${best.instrument} ${best.direction} ` +
                `paperAdmitted=${planBEnsemble.paperAdmitted} admitted=${planBEnsemble.admitted} ` +
                `consensusPassed=${planBEnsemble.consensusPassed} consensusRequired=${planBEnsemble.consensusRequired} ` +
                `execution=SHADOW_ONLY legacyV7Frozen=${LEGACY_V7_EXECUTION_FROZEN} ` +
                `netExpectedR=${ensembleGovernance.netExpectedR.toFixed(4)} ` +
                `costSource=${ensembleGovernance.executionCostSource} ` +
                `drift=${ensembleGovernance.driftState} ` +
                `driftDiagnostics=${(ensembleGovernance.driftDiagnostics ?? []).join('|') || 'NONE'} ` +
                `sleeve=${ensembleGovernance.sleeveState} ` +
                `highConviction=${highConvictionOverlay.state} ` +
                `canary=${rejectedEdgeCanary?.reason ?? canaryEvaluationState} ` +
                `extensionExhaustion=${extensionExhaustionDiagnostic.reason} ` +
                `paperGovernance=${ensembleGovernance.paperExecutionBlockers.join(',') || 'PASS'} ` +
                `promotionGovernance=${ensembleGovernance.blockers.join(',') || 'PASS'} ` +
                `reasons=${planBEnsemble.reasons.join(',')}`,
            );
            continue;
          }
          if (rejectedEdgeCanary?.eligible) {
            this.logger.warn(
              `Rejected-edge PAPER canary ${best.instrument} ${best.direction} execution=ELIGIBLE ` +
                `netExpectedR=${ensembleGovernance.netExpectedR.toFixed(4)} ` +
                `global30m=${rejectedEdgeCanaryEvidence?.global30m.positive ?? 0}/${rejectedEdgeCanaryEvidence?.global30m.samples ?? 0} ` +
                `pairSide30m=${rejectedEdgeCanaryEvidence?.pairSide30m.positive ?? 0}/${rejectedEdgeCanaryEvidence?.pairSide30m.samples ?? 0}`,
            );
          }

          executableCounterfactuals.push({
            opportunityKey: eventId,
            evaluatedAt,
            candidate: best,
            digits,
            v8Shadow,
            planBShadow,
            planBEnsemble,
            portfolioSnapshotAvailable,
            ensembleGovernance,
            macroEventAssessment,
            highConvictionOverlay,
            rejectedEdgeCanary,
            rejectedEdgeCanaryEvidence,
            paperResearchThroughput,
            paperExtensionExhaustionResearch,
            paperExtensionExhaustionPairSideReliability,
            paperExtensionExhaustionEpisodeKey,
            paperExtensionExhaustionEpisodeGuard,
            pairedDirectionReversal,
            pairedReversalGovernance,
            pairedReversalResearch,
            pairedReversalEpisodeKey,
            pairedReversalEpisodeGuard,
            paperResearchPairSideReliability,
            paperTrendRouteReliability,
            paperTrendPairSideReliability,
            paperTrendPairSideReliabilityShadow,
            paperExecutionRoute,
            paperResearchEpisodeKey,
            paperResearchEpisodeGuard,
            paperPostLossEntryGuard,
            paperCostAwareEntry,
            paperCostAwareEvidence,
            paperCalibratedCostRescue,
          });
        }

        const prioritizedCounterfactuals =
          prioritizeCounterfactualExecutionRoutes(executableCounterfactuals);
        const selection = selectCounterfactualExecutionCandidate(
          prioritizedCounterfactuals.map((option) => ({
            candidate: option.candidate,
            paperExecutionEligible: true,
            netExpectedR:
              option.paperExecutionRoute === 'PAIRED_REVERSAL_RESEARCH'
                ? option.pairedDirectionReversal.researchNetExpectedR
                : option.ensembleGovernance.netExpectedR,
            estimatedExecutionCostR: option.ensembleGovernance.estimatedExecutionCostR,
          })),
        );
        if (!selection.selected) {
          if (selection.reason === 'AMBIGUOUS_DUAL_EDGE') {
            const edges = executableCounterfactuals
              .map(
                (option) =>
                  `${option.candidate.direction}:${option.ensembleGovernance.netExpectedR.toFixed(4)}R`,
              )
              .join(' ');
            this.logger.log(
              `Counterfactual ${pairCandidates[0]!.instrument} execution=ABSTAIN reason=${selection.reason} ` +
                `edges=${edges} requiredMargin=${selection.requiredEdgeMarginR?.toFixed(4) ?? 'n/a'}R`,
            );
          }
          continue;
        }

        const chosen = executableCounterfactuals.find(
          (option) => option.candidate === selection.selected!.candidate,
        );
        if (!chosen) continue;
        adaptiveScanWinners.push({ chosen, selection });
      }

      const preAdaptiveWinnerOrder = [...adaptiveScanWinners].sort(
        (a, b) =>
          executableNetExpectedR(b.chosen) - executableNetExpectedR(a.chosen) ||
          b.chosen.candidate.score - a.chosen.candidate.score,
      );
      const preAdaptiveWinnerRanks = new Map<ExecutableCounterfactual, number>(
        preAdaptiveWinnerOrder.map((entry, index) => [entry.chosen, index + 1]),
      );
      const initiallyEvaluatedWinners: AdaptiveScanWinner[] = [];
      for (const entry of adaptiveScanWinners) {
        const adaptive = await this.evaluateAdaptiveCore({
          userId,
          connectionId,
          candidate: entry.chosen.candidate,
          ensemble: entry.chosen.planBEnsemble,
          governance: entry.chosen.ensembleGovernance,
          executionRoute: entry.chosen.paperExecutionRoute,
          evaluatedAt: entry.chosen.evaluatedAt,
          allocationCapital: adaptiveAllocationCapital,
          portfolio: initialAdaptivePortfolio,
          pairedReversalNetExpectedR: entry.chosen.pairedDirectionReversal.researchNetExpectedR,
          paperResearchPairSideReliability:
            entry.chosen.paperExecutionRoute === 'PAPER_EXTENSION_EXHAUSTION_RESEARCH'
              ? entry.chosen.paperExtensionExhaustionPairSideReliability
              : entry.chosen.paperResearchPairSideReliability,
        });
        initiallyEvaluatedWinners.push({
          ...entry,
          marketState: adaptive.marketState,
          edge: adaptive.edge,
          exposure: adaptive.exposure,
          opportunity: adaptive.opportunity,
          riskMultiplier: adaptive.riskMultiplier,
          predictionCalibration: adaptive.predictionCalibration,
          rawNetExpectedR: adaptive.rawNetExpectedR,
          candidateRiskAtStop: adaptive.candidateRiskAtStop,
          requestedRiskPercent: adaptive.requestedRiskPercent,
          adaptiveScore: adaptive.opportunity.score,
          netExpectedR: adaptive.netExpectedR,
          executionCostR: adaptive.executionCostR,
          preAdaptiveScanRank:
            preAdaptiveWinnerRanks.get(entry.chosen) ?? adaptiveScanWinners.length,
        });
      }
      const adaptiveRankedWinners = rankAdaptivePaperScanWinners(initiallyEvaluatedWinners);
      await this.persistAdaptiveScanSummary({
        userId,
        connectionId,
        scanStartedAt: adaptiveScanStartedAt,
        evaluatedCandidates: rankedCandidates.length,
        executableWinners: adaptiveRankedWinners.length,
        best: adaptiveRankedWinners[0] ?? null,
        bestEvaluated: bestAdaptiveDiagnostic,
        reason:
          adaptiveRankedWinners.length > 0
            ? 'ADAPTIVE_WINNERS_RANKED'
            : 'NO_EXECUTABLE_PAIR_WINNER',
      });

      for (const rankedWinner of adaptiveRankedWinners) {
        const refreshedPortfolio = paperSession
          ? await this.loadAdaptiveOpenRiskPositions(userId, connectionId)
          : initialAdaptivePortfolio;
        const refreshed = await this.evaluateAdaptiveCore({
          userId,
          connectionId,
          candidate: rankedWinner.chosen.candidate,
          ensemble: rankedWinner.chosen.planBEnsemble,
          governance: rankedWinner.chosen.ensembleGovernance,
          executionRoute: rankedWinner.chosen.paperExecutionRoute,
          evaluatedAt: rankedWinner.chosen.evaluatedAt,
          allocationCapital: adaptiveAllocationCapital,
          portfolio: refreshedPortfolio,
          pairedReversalNetExpectedR:
            rankedWinner.chosen.pairedDirectionReversal.researchNetExpectedR,
          paperResearchPairSideReliability:
            rankedWinner.chosen.paperExecutionRoute === 'PAPER_EXTENSION_EXHAUSTION_RESEARCH'
              ? rankedWinner.chosen.paperExtensionExhaustionPairSideReliability
              : rankedWinner.chosen.paperResearchPairSideReliability,
        });
        const adaptiveWinner: AdaptiveScanWinner = {
          ...rankedWinner,
          marketState: refreshed.marketState,
          edge: refreshed.edge,
          exposure: refreshed.exposure,
          opportunity: refreshed.opportunity,
          riskMultiplier: refreshed.riskMultiplier,
          predictionCalibration: refreshed.predictionCalibration,
          rawNetExpectedR: refreshed.rawNetExpectedR,
          candidateRiskAtStop: refreshed.candidateRiskAtStop,
          requestedRiskPercent: refreshed.requestedRiskPercent,
          adaptiveScore: refreshed.opportunity.score,
          netExpectedR: refreshed.netExpectedR,
          executionCostR: refreshed.executionCostR,
          adaptiveScanRank: rankedWinner.adaptiveScanRank,
        };
        const adaptivePayload = this.adaptiveMarketIntelligencePayload(
          {
            marketState: adaptiveWinner.marketState,
            edge: adaptiveWinner.edge,
            exposure: adaptiveWinner.exposure,
            opportunity: adaptiveWinner.opportunity,
            riskMultiplier: adaptiveWinner.riskMultiplier,
            predictionCalibration: adaptiveWinner.predictionCalibration,
            rawNetExpectedR: adaptiveWinner.rawNetExpectedR,
            candidateRiskAtStop: adaptiveWinner.candidateRiskAtStop,
            requestedRiskPercent: adaptiveWinner.requestedRiskPercent,
            adaptiveScore: adaptiveWinner.adaptiveScore,
            netExpectedR: adaptiveWinner.netExpectedR,
            executionCostR: adaptiveWinner.executionCostR,
            preAdaptiveScanRank: adaptiveWinner.preAdaptiveScanRank,
            adaptiveScanRank: adaptiveWinner.adaptiveScanRank,
          },
          adaptiveWinner.chosen.paperExecutionRoute,
        );
        await this.persistAdaptiveDecisionAnnotation(
          userId,
          adaptiveWinner.chosen.opportunityKey,
          adaptivePayload,
        );
        if (!adaptiveWinner.opportunity.executionEligible) {
          this.logger.log(
            `Adaptive PAPER ${adaptiveWinner.chosen.candidate.instrument} ${adaptiveWinner.chosen.candidate.direction} ` +
              `execution=ABSTAIN rank=${adaptiveWinner.adaptiveScanRank ?? 'n/a'} ` +
              `score=${adaptiveWinner.adaptiveScore.toFixed(4)} ` +
              `blockers=${adaptiveWinner.opportunity.hardBlockers.join(',') || 'NONE'}`,
          );
          continue;
        }

        const { chosen, selection } = adaptiveWinner;
        const {
          opportunityKey,
          candidate: best,
          digits,
          v8Shadow,
          planBShadow,
          planBEnsemble,
          portfolioSnapshotAvailable,
          ensembleGovernance,
          rejectedEdgeCanary,
          rejectedEdgeCanaryEvidence,
          paperResearchThroughput,
          paperExtensionExhaustionResearch,
          paperExtensionExhaustionPairSideReliability,
          paperExtensionExhaustionEpisodeKey,
          paperExtensionExhaustionEpisodeGuard,
          pairedDirectionReversal,
          pairedReversalGovernance,
          pairedReversalResearch,
          pairedReversalEpisodeKey,
          pairedReversalEpisodeGuard,
          paperResearchPairSideReliability,
          paperTrendRouteReliability,
          paperTrendPairSideReliability,
          paperTrendPairSideReliabilityShadow,
          paperExecutionRoute,
          paperResearchEpisodeKey,
          paperResearchEpisodeGuard,
          paperPostLossEntryGuard,
          paperCostAwareEntry,
          paperCostAwareEvidence,
          paperCalibratedCostRescue,
        } = chosen;

        this.lastPublishedOpportunity.set(best.instrument, {
          direction: best.direction,
          confidence: best.confidence,
          entry: best.entry,
          atr: best.atr,
          barTimeMs: best.barTime.getTime(),
        });

        this.logger.log(
          `Counterfactual ${best.instrument} execution=${best.direction} selection=${selection.reason} ` +
            `netExpectedR=${(paperExecutionRoute === 'PAIRED_REVERSAL_RESEARCH' ? pairedDirectionReversal.researchNetExpectedR : ensembleGovernance.netExpectedR).toFixed(4)}R ` +
            `shortHorizonMomentum=${best.shortHorizonMomentumAtr.toFixed(3)}ATR`,
        );

        if (!paperSession) {
          this.logger.warn(
            'Multi-model counterfactual winner passed governance but PAPER execution authority is unavailable; retaining shadow-only decision',
          );
          continue;
        }

        const entryAlignmentCheckedAt = new Date();
        const suggestedStopLoss = Number(best.stopLoss.toFixed(digits));
        let paperEntryMarketAlignment: PaperEntryMarketAlignmentDecision;
        let paperEntryExecutionQuote: ReturnType<LivePaperMarketDataService['getQuote']>;
        let paperEntryFastMark: ReturnType<LivePaperMarketDataService['getMarkQuote']>;
        try {
          paperEntryExecutionQuote = this.livePaperMarket.getQuote(
            best.instrument,
            20 * 60_000,
            connectionId,
          );
          paperEntryFastMark = this.livePaperMarket.getMarkQuote(
            best.instrument,
            PAPER_ENTRY_FAST_MARK_MAX_AGE_MS,
            20 * 60_000,
            connectionId,
          );
          paperEntryMarketAlignment = evaluatePaperEntryMarketAlignment({
            direction: best.direction,
            candidateBarTime: best.barTime,
            evaluatedAt: entryAlignmentCheckedAt,
            stopLoss: suggestedStopLoss,
            executionQuote: paperEntryExecutionQuote,
            fastMark: paperEntryFastMark,
          });
        } catch (error) {
          this.logger.warn(
            `PAPER entry alignment ${best.instrument} ${best.direction} execution=BLOCKED ` +
              `reason=ENTRY_MARKET_DATA_UNAVAILABLE detail=${(error as Error).message}`,
          );
          continue;
        }
        if (!paperEntryMarketAlignment.eligible) {
          this.logger.warn(
            `PAPER entry alignment ${best.instrument} ${best.direction} execution=BLOCKED ` +
              `reason=${paperEntryMarketAlignment.reason} candidateBar=${best.barTime.toISOString()} ` +
              `executionSource=${paperEntryExecutionQuote.source} fastMarkSource=${paperEntryFastMark.source} ` +
              `fastMarkProvider=${paperEntryFastMark.streamProvider ?? 'NONE'} ` +
              `stopBudgetConsumed=${paperEntryMarketAlignment.stopBudgetConsumedFraction ?? 'n/a'}`,
          );
          continue;
        }

        const dynamicLotSizing = this.adaptiveLotSizingFor(chosen);
        const suggestedEntryPrice = Number(best.entry.toFixed(digits));
        const suggestedTakeProfit = Number(best.takeProfit.toFixed(digits));
        const strategyCode = `external-${ACTIVE_ENGINE_CODE}`;
        const timeframe = 'M5';
        const modelVersion =
          paperExecutionRoute === 'REJECTED_EDGE_CANARY'
            ? `external-provider/${ACTIVE_ENGINE_CODE}/paper-rejected-edge-canary-v1`
            : paperExecutionRoute === 'PAPER_RESEARCH_THROUGHPUT'
              ? paperResearchThroughputModelVersion(ACTIVE_ENGINE_CODE)
              : paperExecutionRoute === 'PAPER_EXTENSION_EXHAUSTION_RESEARCH'
                ? `external-provider/${ACTIVE_ENGINE_CODE}/${PAPER_EXTENSION_EXHAUSTION_RESEARCH_ARTIFACT}`
                : paperExecutionRoute === 'PAIRED_REVERSAL_RESEARCH'
                  ? `external-provider/${ACTIVE_ENGINE_CODE}/${PAPER_PAIRED_REVERSAL_RESEARCH_ARTIFACT}`
                  : `external-provider/${ACTIVE_ENGINE_CODE}/paper-only-v1`;
        const signalId = this.materialSignalIdFor({
          opportunityKey,
          instrument: best.instrument,
          direction: best.direction,
          requestedLotSize: String(dynamicLotSizing.upperBound),
          entryPrice: suggestedEntryPrice,
          stopLoss: suggestedStopLoss,
          takeProfit: suggestedTakeProfit,
          strategyCode,
          timeframe,
          modelVersion,
        });
        const signalDelivery = await this.resolveSignalDeliveryTimestamp(userId, signalId);
        if (!signalDelivery.deliver || !signalDelivery.generatedAt) {
          this.logger.log(
            `Adaptive PAPER ${best.instrument} ${best.direction} execution=SKIPPED ` +
              `signal=${signalId} reason=${signalDelivery.reason}`,
          );
          continue;
        }

        const outcome = await this.aiSignalService.receiveSignal({
          signalId,
          userId,
          tradingSessionId: paperSession.id,
          brokerConnectionId: connectionId,
          instrument: best.instrument,
          direction: best.direction,
          confidenceScore: best.confidence,
          suggestedEntryPrice,
          suggestedStopLoss,
          suggestedTakeProfit,
          // PAPER-only dynamic upper bound. PositionSizingService still computes
          // the actual lot from equity, stop distance, risk %, broker min/max/step,
          // available margin, allocation and the user's profile max. Stronger size
          // therefore cannot bypass the authoritative risk engine.
          suggestedVolume: dynamicLotSizing.upperBound,
          timeframe,
          strategyCode,
          marketRegime: adaptiveWinner.marketState.state,
          volatilityScore: best.volatilityScore,
          generatedAt: signalDelivery.generatedAt,
          modelVersion,
          metadata: {
            signal_source: 'EXTERNAL_PROVIDER',
            external_provider_code: ACTIVE_ENGINE_CODE,
            legacy_baseline_provider_code: LEGACY_PROVIDER_CODE,
            legacy_v7_execution_frozen: LEGACY_V7_EXECUTION_FROZEN,
            multi_model_execution_authority: MULTI_MODEL_PAPER_EXECUTION_ENABLED,
            external_provider_paper_only: true,
            production_eligible: false,
            paper_execution_route: paperExecutionRoute,
            adaptive_risk_multiplier: adaptiveWinner.riskMultiplier.multiplier,
            adaptive_market_state: adaptiveWinner.marketState.state,
            adaptive_opportunity_score: adaptiveWinner.adaptiveScore,
            adaptive_scan_rank: adaptiveWinner.adaptiveScanRank ?? null,
            adaptive_pre_scan_rank: adaptiveWinner.preAdaptiveScanRank,
            adaptiveMarketIntelligence: adaptivePayload,
            paper_post_loss_entry_guard_artifact: paperPostLossEntryGuard.artifact,
            paper_post_loss_entry_guard_reason: paperPostLossEntryGuard.reason,
            paper_post_loss_entry_guard_last_trade_id: paperPostLossEntryGuard.lastClosedTradeId,
            paper_post_loss_entry_guard_last_closed_at: paperPostLossEntryGuard.lastClosedAt,
            paper_entry_market_alignment_artifact: 'paper-entry-market-alignment-v1',
            paper_entry_market_alignment_reason: paperEntryMarketAlignment.reason,
            paper_entry_market_alignment_checked_at: entryAlignmentCheckedAt.toISOString(),
            paper_entry_market_alignment_execution_quote_source: paperEntryExecutionQuote.source,
            paper_entry_market_alignment_fast_mark_source: paperEntryFastMark.source,
            paper_entry_market_alignment_fast_mark_provider:
              paperEntryFastMark.streamProvider ?? null,
            paper_entry_market_alignment_stop_budget_consumed_fraction:
              paperEntryMarketAlignment.stopBudgetConsumedFraction,
            rejected_edge_canary: paperExecutionRoute === 'REJECTED_EDGE_CANARY',
            rejected_edge_canary_artifact: rejectedEdgeCanary?.artifact ?? null,
            rejected_edge_canary_reason: rejectedEdgeCanary?.reason ?? null,
            rejected_edge_canary_global_30m: rejectedEdgeCanaryEvidence?.global30m ?? null,
            rejected_edge_canary_pair_side_30m: rejectedEdgeCanaryEvidence?.pairSide30m ?? null,
            paper_research_throughput: paperExecutionRoute === 'PAPER_RESEARCH_THROUGHPUT',
            paper_research_throughput_artifact: paperResearchThroughput.artifact,
            paper_research_throughput_reason: paperResearchThroughput.reason,
            paper_cost_aware_entry_artifact: paperCostAwareEntry.artifact,
            paper_cost_aware_entry_action: paperCostAwareEntry.action,
            paper_cost_aware_entry_reason: paperCostAwareEntry.reason,
            paper_cost_aware_entry_modifies_execution: paperCostAwareEntry.modifiesExecution,
            paper_cost_aware_entry_qualification_evidence:
              paperCostAwareEntry.qualificationEvidence,
            paper_cost_aware_entry_cost_flip_rate: paperCostAwareEntry.costFlipRate,
            paper_cost_aware_entry_current_cost_ratio: paperCostAwareEntry.currentCostRatio,
            paper_cost_aware_entry_gross_positive_samples:
              paperCostAwareEvidence.grossPositiveSamples,
            paper_cost_aware_entry_cost_flipped_samples: paperCostAwareEvidence.costFlippedSamples,
            paper_cost_aware_entry_net_positive_samples: paperCostAwareEvidence.netPositiveSamples,
            paper_calibrated_cost_rescue: paperCalibratedCostRescue.eligible,
            paper_calibrated_cost_rescue_artifact: paperCalibratedCostRescue.artifact,
            paper_calibrated_cost_rescue_reason: paperCalibratedCostRescue.reason,
            paper_calibrated_cost_rescue_execution_authority:
              paperCalibratedCostRescue.executionAuthority,
            paper_calibrated_cost_rescue_qualification_evidence:
              paperCalibratedCostRescue.qualificationEvidence,
            paper_calibrated_cost_rescue_fixed_net_expected_r:
              paperCalibratedCostRescue.fixedNetExpectedR,
            paper_calibrated_cost_rescue_calibrated_net_expected_r:
              paperCalibratedCostRescue.calibratedNetExpectedR,
            paper_calibrated_cost_rescue_fixed_execution_cost_r:
              paperCalibratedCostRescue.fixedExecutionCostR,
            paper_calibrated_cost_rescue_calibrated_execution_cost_r:
              paperCalibratedCostRescue.calibratedExecutionCostR,
            paper_calibrated_cost_rescue_cost_reduction_r: paperCalibratedCostRescue.costReductionR,
            paper_research_throughput_qualification_evidence:
              paperResearchThroughput.qualificationEvidence,
            paper_research_throughput_execution_authority:
              paperResearchThroughput.executionAuthority,
            paper_extension_exhaustion_research:
              paperExecutionRoute === 'PAPER_EXTENSION_EXHAUSTION_RESEARCH',
            paper_extension_exhaustion_research_artifact: paperExtensionExhaustionResearch.artifact,
            paper_extension_exhaustion_research_reason: paperExtensionExhaustionResearch.reason,
            paper_extension_exhaustion_research_qualification_evidence:
              paperExtensionExhaustionResearch.qualificationEvidence,
            paper_extension_exhaustion_research_execution_authority:
              paperExtensionExhaustionResearch.executionAuthority,
            paper_extension_exhaustion_episode_key: paperExtensionExhaustionEpisodeKey,
            paper_extension_exhaustion_episode_guard_reason:
              paperExtensionExhaustionEpisodeGuard?.reason ?? null,
            paper_extension_exhaustion_pair_side_reliability_reason:
              paperExtensionExhaustionPairSideReliability?.reason ?? null,
            paper_extension_exhaustion_pair_side_reliability_realised_r_samples:
              paperExtensionExhaustionPairSideReliability?.realisedRSamples ?? null,
            paper_extension_exhaustion_pair_side_reliability_realised_average_r:
              paperExtensionExhaustionPairSideReliability?.realisedAverageR ?? null,
            paired_reversal_research: paperExecutionRoute === 'PAIRED_REVERSAL_RESEARCH',
            paired_reversal_research_artifact: PAPER_PAIRED_REVERSAL_RESEARCH_ARTIFACT,
            paired_reversal_research_reason: pairedReversalResearch.reason,
            paired_reversal_research_qualification_evidence: false,
            paired_reversal_research_execution_authority: pairedReversalResearch.executionAuthority,
            paired_reversal_preferred_direction: pairedDirectionReversal.preferredDirection,
            paired_reversal_buy_directional_probability:
              pairedDirectionReversal.buyDirectionalProbability,
            paired_reversal_sell_directional_probability:
              pairedDirectionReversal.sellDirectionalProbability,
            paired_reversal_preferred_absolute_probability:
              pairedDirectionReversal.preferredAbsoluteProbability,
            paired_reversal_directional_edge: pairedDirectionReversal.directionalEdge,
            paired_reversal_aligned_momentum_atr: pairedDirectionReversal.alignedMomentumAtr,
            paired_reversal_research_net_expected_r: pairedDirectionReversal.researchNetExpectedR,
            paired_reversal_drift_state: pairedReversalGovernance.driftState,
            paired_reversal_episode_key: pairedReversalEpisodeKey,
            paired_reversal_episode_guard_reason: pairedReversalEpisodeGuard?.reason ?? null,
            paper_research_pair_side_reliability_reason:
              paperResearchPairSideReliability?.reason ?? null,
            paper_research_pair_side_reliability_samples:
              paperResearchPairSideReliability?.samples ?? null,
            paper_research_pair_side_reliability_wins:
              paperResearchPairSideReliability?.wins ?? null,
            paper_research_pair_side_reliability_losses:
              paperResearchPairSideReliability?.losses ?? null,
            paper_research_pair_side_reliability_smoothed_win_rate:
              paperResearchPairSideReliability?.smoothedWinRate ?? null,
            paper_research_pair_side_reliability_smoothed_expected_r:
              paperResearchPairSideReliability?.smoothedExpectedR ?? null,
            paper_research_pair_side_reliability_realised_r_samples:
              paperResearchPairSideReliability?.realisedRSamples ?? null,
            paper_research_pair_side_reliability_realised_average_r:
              paperResearchPairSideReliability?.realisedAverageR ?? null,
            paper_research_episode_key: paperResearchEpisodeKey,
            paper_research_episode_guard_reason: paperResearchEpisodeGuard?.reason ?? null,
            paper_trend_route_reliability_artifact: paperTrendRouteReliability?.artifact ?? null,
            paper_trend_route_reliability_state: paperTrendRouteReliability?.state ?? null,
            paper_trend_route_reliability_reason: paperTrendRouteReliability?.reason ?? null,
            paper_trend_route_reliability_episodes: paperTrendRouteReliability?.episodes ?? null,
            paper_trend_route_reliability_profit_factor:
              paperTrendRouteReliability?.profitFactor ?? null,
            paper_trend_route_reliability_max_drawdown:
              paperTrendRouteReliability?.maxDrawdown ?? null,
            paper_trend_route_reliability_demoted: false,
            paper_trend_route_reliability_modifies_execution: false,
            paper_trend_pair_side_reliability_artifact:
              paperTrendPairSideReliability?.artifact ?? null,
            paper_trend_pair_side_reliability_state: paperTrendPairSideReliability?.state ?? null,
            paper_trend_pair_side_reliability_reason: paperTrendPairSideReliability?.reason ?? null,
            paper_trend_pair_side_reliability_episodes:
              paperTrendPairSideReliability?.episodes ?? null,
            paper_trend_pair_side_reliability_profit_factor:
              paperTrendPairSideReliability?.profitFactor ?? null,
            paper_trend_pair_side_reliability_max_drawdown:
              paperTrendPairSideReliability?.maxDrawdown ?? null,
            paper_trend_pair_side_reliability_demoted:
              paperTrendPairSideReliability?.fullSizeEligible === false,
            paper_trend_pair_side_reliability_shadow_artifact:
              paperTrendPairSideReliabilityShadow?.artifact ?? null,
            paper_trend_pair_side_reliability_shadow_state:
              paperTrendPairSideReliabilityShadow?.state ?? null,
            paper_trend_pair_side_reliability_shadow_reason:
              paperTrendPairSideReliabilityShadow?.reason ?? null,
            paper_trend_pair_side_reliability_shadow_episodes:
              paperTrendPairSideReliabilityShadow?.episodes ?? null,
            paper_trend_pair_side_reliability_shadow_profit_factor:
              paperTrendPairSideReliabilityShadow?.profitFactor ?? null,
            paper_trend_pair_side_reliability_shadow_sharpe:
              paperTrendPairSideReliabilityShadow?.sharpe ?? null,
            paper_trend_pair_side_reliability_shadow_max_drawdown:
              paperTrendPairSideReliabilityShadow?.maxDrawdown ?? null,
            paper_trend_pair_side_reliability_shadow_positive_window_fraction:
              paperTrendPairSideReliabilityShadow?.positiveWindowFraction ?? null,
            paper_trend_pair_side_reliability_shadow_modifies_execution:
              paperTrendPairSideReliabilityShadow?.modifiesExecution ?? false,
            paper_trend_pair_side_reliability_shadow_execution_authority:
              paperTrendPairSideReliabilityShadow?.executionAuthority ?? 'NONE',
            main_strategy_qualification_evidence: paperExecutionRoute === 'NORMAL_PAPER',
            source_reference:
              this.lastMarketDataAuthority === 'METAAPI_BROKER_FALLBACK'
                ? 'MetaTrader broker-native M5 closed candles via MetaApi fallback'
                : 'Twelve Data Basic real-time forex M5 closed candles',
            market_data_authority:
              this.lastMarketDataAuthority === 'METAAPI_BROKER_FALLBACK'
                ? 'PAPER_RESEARCH_BROKER_NATIVE_METAAPI_FALLBACK'
                : 'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
            live_market_data_policy:
              'DEMO/LIVE decisions must use broker-native market data via the active broker adapter; MetaTrader uses MetaApi as the broker-access bridge',
            market_data_bar_time: best.barTime.toISOString(),
            market_data_execution_model:
              'closed-candle-mid-derived-bid-ask-with-broker-p90-spread-plus-25pct-buffer',
            execution_cost_model_version: ensembleGovernance.costModelVersion,
            execution_cost_source: ensembleGovernance.executionCostSource,
            execution_spread_evidence_valid: ensembleGovernance.executionSpreadEvidenceValid,
            execution_spread_evidence: ensembleGovernance.executionSpreadEvidence,
            calibration_mode: 'SHADOW_DIAGNOSTIC_ONLY',
            calibration_modifies_execution: false,
            feature_extension_atr: best.extensionAtr,
            feature_ema_separation: best.emaSeparation,
            feature_mtf_strength: best.mtfStrength,
            feature_h4_alignment: best.h4Alignment ?? 0,
            feature_h4_context_available: best.h4ContextAvailable ?? false,
            feature_h4_closed_bar_count: best.h4ClosedBarCount ?? 0,
            feature_rsi14: best.rsi14,
            feature_volatility_score: best.volatilityScore,
            feature_atr: best.atr,
            feature_candidate_score: best.score,
            v8_shadow_artifact: v8Shadow.artifact,
            v8_shadow_mode: v8Shadow.mode,
            v8_shadow_probability: v8Shadow.probability,
            v8_shadow_admission_threshold: v8Shadow.admissionThreshold,
            v8_shadow_expected_r: v8Shadow.expectedR,
            v8_shadow_admitted: v8Shadow.admitted,
            v8_shadow_reason: v8Shadow.reason,
            v8_shadow_training_evidence:
              'HISTORICAL_DEVELOPMENT_ONLY_ALREADY_INSPECTED_NOT_QUALIFICATION',
            v8_shadow_modifies_execution: false,
            plan_b_shadow_artifact: planBShadow.artifact,
            plan_b_shadow_mode: planBShadow.mode,
            plan_b_shadow_probability: planBShadow.probability,
            plan_b_shadow_admission_threshold: planBShadow.admissionThreshold,
            plan_b_shadow_expected_r: planBShadow.expectedR,
            plan_b_shadow_admitted: planBShadow.admitted,
            plan_b_shadow_reason: planBShadow.reason,
            plan_b_shadow_training_evidence:
              'PREEXISTING_WALK_FORWARD_THRESHOLD_NOT_TODAYS_PROSPECTIVE_RESULTS',
            plan_b_shadow_modifies_execution: false,
            plan_b_ensemble_artifact: planBEnsemble.artifact,
            decision_policy_version: ACTIVE_MODEL_POLICY_VERSION,
            counterfactual_scoring: true,
            counterfactual_selection_reason: selection.reason,
            counterfactual_required_edge_margin_r: selection.requiredEdgeMarginR,
            feature_short_horizon_momentum_atr: best.shortHorizonMomentumAtr,
            plan_b_ensemble_mode: planBEnsemble.mode,
            plan_b_ensemble_modifies_execution: false,
            plan_b_ensemble_regime: planBEnsemble.regime,
            plan_b_ensemble_strategy_route: planBEnsemble.strategyRoute,
            plan_b_ensemble_regime_allowed: planBEnsemble.regimeAllowed,
            plan_b_ensemble_direction_quality: planBEnsemble.directionQuality,
            plan_b_ensemble_expected_r: planBEnsemble.expectedR,
            plan_b_ensemble_trade_quality: planBEnsemble.tradeQuality,
            plan_b_ensemble_exit_quality: planBEnsemble.exitQuality,
            plan_b_ensemble_pair_side_quality: planBEnsemble.pairSideQuality,
            plan_b_ensemble_pair_side_route: planBEnsemble.pairSideRoute,
            plan_b_ensemble_session_quality: planBEnsemble.sessionQuality,
            plan_b_ensemble_consensus_passed: planBEnsemble.consensusPassed,
            plan_b_ensemble_consensus_required: planBEnsemble.consensusRequired,
            plan_b_ensemble_portfolio_snapshot_available: portfolioSnapshotAvailable,
            plan_b_ensemble_portfolio_quality: planBEnsemble.portfolioQuality,
            plan_b_governance_version: ensembleGovernance.version,
            plan_b_governance_cost_model_version: ensembleGovernance.costModelVersion,
            plan_b_governance_drift_model_version: ensembleGovernance.driftModelVersion,
            plan_b_governance_execution_cost_r: ensembleGovernance.estimatedExecutionCostR,
            plan_b_governance_net_expected_r: ensembleGovernance.netExpectedR,
            plan_b_governance_net_expected_r_passed: ensembleGovernance.netExpectedRPassed,
            plan_b_governance_drift_state: ensembleGovernance.driftState,
            plan_b_governance_drift_quality: ensembleGovernance.driftQuality,
            plan_b_governance_sleeve_state: ensembleGovernance.sleeveState,
            plan_b_governance_event_risk: ensembleGovernance.eventRisk,
            plan_b_governance_paper_promotion_eligible: ensembleGovernance.paperPromotionEligible,
            plan_b_governance_blockers: ensembleGovernance.blockers,
            plan_b_ensemble_portfolio_risk_score: planBEnsemble.portfolioRiskScore,
            plan_b_ensemble_open_position_count: planBEnsemble.openPositionCount,
            plan_b_ensemble_same_instrument_count: planBEnsemble.sameInstrumentCount,
            plan_b_ensemble_same_instrument_directional_lots:
              planBEnsemble.sameInstrumentDirectionalLots,
            plan_b_ensemble_meta_probability: planBEnsemble.metaProbability,
            plan_b_ensemble_score: planBEnsemble.ensembleScore,
            plan_b_ensemble_paper_admitted: planBEnsemble.paperAdmitted,
            plan_b_ensemble_admitted: planBEnsemble.admitted,
            plan_b_ensemble_reasons: planBEnsemble.reasons,
            position_sizing_policy: 'risk-managed-dynamic-paper-band-v2',
            position_sizing_tier: dynamicLotSizing.tier,
            position_sizing_upper_bound_lots: dynamicLotSizing.upperBound,
            position_sizing_confidence: best.confidence,
            position_sizing_meta_probability: planBEnsemble.metaProbability,
            position_sizing_net_expected_r: ensembleGovernance.netExpectedR,
            opportunity_freshness_policy: 'each-qualifying-closed-bar-evaluated-independently',
          },
        });
        this.logger.log(
          `Multi-model PAPER candidate ${best.instrument} ${best.direction} confidence=${best.confidence.toFixed(4)} ` +
            `adaptiveRank=${adaptiveWinner.adaptiveScanRank ?? 'n/a'} adaptiveScore=${adaptiveWinner.adaptiveScore.toFixed(4)} ` +
            `riskMultiplier=${adaptiveWinner.riskMultiplier.multiplier.toFixed(2)}x ` +
            `lotTier=${dynamicLotSizing.tier} lotCap=${dynamicLotSizing.upperBound.toFixed(2)} ` +
            `outcome=${outcome.outcome} signal=${signalId} cadence=adaptive-scan-ranked`,
        );
        const retrySafePreIntentError = this.retrySafePreIntentErrorForOutcome(outcome);
        if (retrySafePreIntentError) throw retrySafePreIntentError;
      }
    } finally {
      this.running = false;
    }
  }

  private async loadAdaptiveOpenRiskPositions(
    userId: string,
    connectionId: string,
  ): Promise<{ available: boolean; positions: AdaptiveCurrencyRiskPosition[] }> {
    let providerPositions: Array<{
      externalOrderId: string;
      instrument: string;
      direction: 'BUY' | 'SELL';
    }>;
    try {
      const snapshot = await this.brokerService.getOpenPositionsForConnection(connectionId, userId);
      providerPositions = snapshot.positions.map((position) => ({
        externalOrderId: position.externalOrderId,
        instrument: position.instrument,
        direction: position.direction,
      }));
    } catch (error) {
      this.logger.warn(
        `Adaptive provider position evidence unavailable: ${(error as Error).message}`,
      );
      return { available: false, positions: [] };
    }

    // PAPER provider state is the current exposure authority. Durable trade
    // reconciliation can trail a simulator SL/TP/profit-lock close by several
    // minutes, so an empty provider snapshot must clear exposure immediately
    // rather than carrying a ghost OPEN trade from the database.
    if (providerPositions.length === 0) return { available: true, positions: [] };
    if (!this.dataSource) {
      return {
        available: false,
        positions: providerPositions.map((position) => ({
          instrument: position.instrument,
          direction: position.direction,
          riskAtStop: null,
        })),
      };
    }

    try {
      const rows = (await this.dataSource.query(
        `
          SELECT
            t.external_order_id,
            t.external_position_id,
            NULLIF(ca.sizing_inputs->>'riskAmount', '')::numeric AS risk_at_stop
          FROM trading.capital_allocations ca
          JOIN trading.trade_intents ti ON ti.id = ca.trade_intent_id
          JOIN trading.trades t ON t.trade_intent_id = ti.id
          WHERE ti.user_id = $1
            AND ti.broker_connection_id = $2
            AND ca.status = 'ACTIVE'
          ORDER BY t.opened_at ASC, t.id ASC
        `,
        [userId, connectionId],
      )) as Array<{
        external_order_id: string | null;
        external_position_id: string | null;
        risk_at_stop: string | number | null;
      }>;
      const riskByProviderId = new Map<string, number | null>();
      for (const row of rows) {
        const parsed =
          row.risk_at_stop == null || !Number.isFinite(Number(row.risk_at_stop))
            ? null
            : Number(row.risk_at_stop);
        if (row.external_position_id) riskByProviderId.set(row.external_position_id, parsed);
        if (row.external_order_id) riskByProviderId.set(row.external_order_id, parsed);
      }
      return {
        available: true,
        positions: providerPositions.map((position) => ({
          instrument: position.instrument,
          direction: position.direction,
          riskAtStop: riskByProviderId.get(position.externalOrderId) ?? null,
        })),
      };
    } catch (error) {
      this.logger.warn(`Adaptive portfolio risk evidence unavailable: ${(error as Error).message}`);
      return {
        available: false,
        positions: providerPositions.map((position) => ({
          instrument: position.instrument,
          direction: position.direction,
          riskAtStop: null,
        })),
      };
    }
  }

  private async loadAdaptiveAllocationCapital(
    userId: string,
    connectionId: string,
  ): Promise<string | null> {
    if (!this.allocationService) return null;
    try {
      const state = await this.allocationService.getUserCapitalAllocationState(
        userId,
        connectionId,
      );
      return state.hasAllocation ? state.allocatedCapital : null;
    } catch (error) {
      this.logger.warn(`Adaptive allocation evidence unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  private adaptiveLotSizingFor(option: {
    paperExecutionRoute: ReturnType<typeof selectPaperExecutionRoute>;
    candidate: Candidate;
    planBEnsemble: PlanBEnsembleScore;
    ensembleGovernance: EnsembleGovernanceDecision;
  }): {
    upperBound: number;
    tier: PaperAllocationConfidenceTier;
  } {
    if (option.paperExecutionRoute === 'REJECTED_EDGE_CANARY') {
      return { upperBound: PAPER_BASE_LOT_UPPER_BOUND, tier: 'RESEARCH' };
    }
    if (option.paperExecutionRoute === 'PAPER_RESEARCH_THROUGHPUT') {
      return { upperBound: PAPER_RESEARCH_THROUGHPUT_LOT_CAP, tier: 'RESEARCH' };
    }
    if (option.paperExecutionRoute === 'PAPER_EXTENSION_EXHAUSTION_RESEARCH') {
      return { upperBound: PAPER_RESEARCH_THROUGHPUT_LOT_CAP, tier: 'RESEARCH' };
    }
    if (option.paperExecutionRoute === 'PAIRED_REVERSAL_RESEARCH') {
      return { upperBound: PAPER_PAIRED_REVERSAL_RESEARCH_LOT_CAP, tier: 'RESEARCH' };
    }
    const normal = dynamicPaperLotUpperBound({
      confidence: option.candidate.confidence,
      metaProbability: option.planBEnsemble.metaProbability,
      netExpectedR: option.ensembleGovernance.netExpectedR,
      consensusPassed: option.planBEnsemble.consensusPassed,
      consensusRequired: option.planBEnsemble.consensusRequired,
      volatilityScore: option.candidate.volatilityScore,
    });
    return { upperBound: normal.upperBound, tier: normal.tier };
  }

  private async evaluateAdaptiveCore(input: {
    userId: string;
    connectionId: string;
    candidate: Candidate;
    ensemble: PlanBEnsembleScore;
    governance: EnsembleGovernanceDecision;
    executionRoute: ReturnType<typeof selectPaperExecutionRoute>;
    evaluatedAt: Date;
    allocationCapital: string | null;
    portfolio: { available: boolean; positions: AdaptiveCurrencyRiskPosition[] };
    pairedReversalNetExpectedR?: number;
    paperResearchPairSideReliability?: PaperResearchPairSideReliabilityDecision | null;
  }): Promise<{
    marketState: AdaptiveMarketStateDecision;
    edge: AdaptiveEdgeEvidence;
    exposure: AdaptiveCurrencyExposureDecision;
    opportunity: AdaptiveOpportunityDecision;
    riskMultiplier: AdaptiveRiskMultiplierDecision;
    predictionCalibration: AdaptivePredictionCalibrationDecision;
    rawNetExpectedR: number;
    candidateRiskAtStop: number | null;
    requestedRiskPercent: number;
    sizingTier: PaperAllocationConfidenceTier;
    sizingUpperBound: number;
    netExpectedR: number;
    executionCostR: number;
  }> {
    const executionCostUsable = Boolean(
      input.governance.paperExecutionCostUsable ?? input.governance.executionSpreadEvidenceValid,
    );
    const marketState = classifyAdaptiveMarketState({
      scanTime: input.evaluatedAt,
      legacyRegime: input.ensemble.regime,
      strategyRoute: input.ensemble.strategyRoute,
      driftState: input.governance.driftState,
      confidence: input.candidate.confidence,
      emaSeparation: input.candidate.emaSeparation,
      mtfStrength: input.candidate.mtfStrength,
      h4Alignment: input.candidate.h4Alignment ?? 0,
      h4ContextAvailable: input.candidate.h4ContextAvailable ?? false,
      extensionAtr: input.candidate.extensionAtr,
      shortHorizonMomentumAtr: input.candidate.shortHorizonMomentumAtr,
      volatilityScore: input.candidate.volatilityScore,
      rsi14: input.candidate.rsi14,
      executionCostUsable,
      dataFreshness: adaptiveMarketDataFreshness(
        new Date(input.candidate.barTime.getTime() + BAR_MS),
        input.evaluatedAt,
      ),
    });
    const evidenceClass = input.executionRoute === 'NORMAL_PAPER' ? 'QUALIFICATION' : 'RESEARCH';
    const edgeRequest = {
      userId: input.userId,
      brokerConnectionId: input.connectionId,
      instrument: input.candidate.instrument,
      direction: input.candidate.direction,
      session: marketState.session,
      state: marketState.state,
      strategyRoute: input.ensemble.strategyRoute,
      decisionPolicyVersion: ACTIVE_MODEL_POLICY_VERSION,
      evaluatedAt: input.evaluatedAt,
      evidenceClass,
    } as const;
    const edge = this.adaptiveEdgeMatrix
      ? await this.adaptiveEdgeMatrix.getEvidence(edgeRequest)
      : unavailableAdaptiveEdgeEvidence(edgeRequest);
    const rawNetExpectedR =
      input.executionRoute === 'PAIRED_REVERSAL_RESEARCH' &&
      Number.isFinite(input.pairedReversalNetExpectedR)
        ? input.pairedReversalNetExpectedR!
        : input.governance.netExpectedR;
    const calibrationRequest = {
      userId: input.userId,
      brokerConnectionId: input.connectionId,
      instrument: input.candidate.instrument,
      direction: input.candidate.direction,
      session: marketState.session,
      state: marketState.state,
      strategyRoute: input.ensemble.strategyRoute,
      decisionPolicyVersions: PLAN_B_PREDICTION_CALIBRATION_EVIDENCE_POLICY_VERSIONS,
      evaluatedAt: input.evaluatedAt,
      rawConfidence: input.candidate.confidence,
      rawNetExpectedR,
    } as const;
    const predictionCalibration = this.adaptivePredictionCalibration
      ? await this.adaptivePredictionCalibration.getCalibration(calibrationRequest)
      : unavailableAdaptivePredictionCalibration(calibrationRequest);
    const calibrationAuthority = applyAdaptivePredictionCalibrationAuthority({
      calibration: predictionCalibration,
      rawConfidence: input.candidate.confidence,
      rawNetExpectedR,
      paperExecutionBlockers: [],
      allowResearchRescue: false,
    });
    const extensionCollectingCalibrationDiagnosticOnly =
      input.executionRoute === 'PAPER_EXTENSION_EXHAUSTION_RESEARCH' &&
      predictionCalibration.maturity === 'COLLECTING' &&
      !predictionCalibration.blockRecommended;
    const netExpectedR = extensionCollectingCalibrationDiagnosticOnly
      ? rawNetExpectedR
      : calibrationAuthority.effectiveNetExpectedR;

    const sizing =
      input.executionRoute === 'NORMAL_PAPER'
        ? dynamicPaperLotUpperBound({
            confidence: input.candidate.confidence,
            metaProbability: input.ensemble.metaProbability,
            netExpectedR,
            consensusPassed: input.ensemble.consensusPassed,
            consensusRequired: input.ensemble.consensusRequired,
            volatilityScore: input.candidate.volatilityScore,
          })
        : input.executionRoute === 'NONE'
          ? { upperBound: PAPER_BASE_LOT_UPPER_BOUND, tier: 'BASE' as const }
          : this.adaptiveLotSizingFor({
              paperExecutionRoute: input.executionRoute,
              candidate: input.candidate,
              planBEnsemble: input.ensemble,
              ensembleGovernance: input.governance,
            });
    const requestedRiskPercent = paperAllocationRiskTargetPercent(
      sizing.tier as PaperAllocationConfidenceTier,
    );
    const candidateRiskAtStop = adaptiveCandidateRiskAtStop(
      input.allocationCapital,
      requestedRiskPercent,
    );
    const portfolioPositions = [...input.portfolio.positions];
    if (!input.portfolio.available || candidateRiskAtStop === null) {
      portfolioPositions.push({ instrument: 'UNKNOWN', direction: 'BUY', riskAtStop: null });
    }
    const exposure = analyzeAdaptiveCurrencyExposure({
      positions: portfolioPositions,
      candidate: {
        instrument: input.candidate.instrument,
        direction: input.candidate.direction,
        riskAtStop: candidateRiskAtStop ?? 1,
      },
    });
    const hardBlockers = [
      ...(input.executionRoute === 'NONE' ? input.governance.paperExecutionBlockers : []),
      ...(calibrationAuthority.blockExecution ? ['ADAPTIVE_CALIBRATION_NEGATIVE_EDGE'] : []),
      ...(exposure.capacity === 'BLOCKED' ? ['ADAPTIVE_CURRENCY_CONCENTRATION_BLOCKED'] : []),
    ];
    const opportunity = scoreAdaptiveOpportunity({
      netExpectedR,
      estimatedExecutionCostR: input.governance.estimatedExecutionCostR,
      directionQuality: input.ensemble.directionQuality,
      tradeQuality: input.ensemble.tradeQuality,
      exitQuality: input.ensemble.exitQuality,
      driftQuality: input.governance.driftQuality,
      hardBlockers,
      marketState,
      edge,
      exposure,
    });
    const riskMultiplier = selectAdaptiveRiskMultiplier({
      executionRoute: input.executionRoute,
      opportunityScore: opportunity.score,
      netExpectedR,
      executionCostUsable,
      hardBlockers,
      marketState,
      edge,
      exposure,
      researchPairSideReliability: input.paperResearchPairSideReliability,
    });
    return {
      marketState,
      edge,
      exposure,
      opportunity,
      riskMultiplier,
      predictionCalibration,
      rawNetExpectedR,
      candidateRiskAtStop,
      requestedRiskPercent,
      sizingTier: sizing.tier as PaperAllocationConfidenceTier,
      sizingUpperBound: sizing.upperBound,
      netExpectedR,
      executionCostR: input.governance.estimatedExecutionCostR,
    };
  }

  private adaptiveMarketIntelligencePayload(
    adaptive: Omit<AdaptiveScanWinner, 'chosen' | 'selection'>,
    executionRoute: ReturnType<typeof selectPaperExecutionRoute>,
  ): Record<string, unknown> {
    return {
      artifact: 'adaptive-market-intelligence-v1',
      policyVersion: ACTIVE_MODEL_POLICY_VERSION,
      executionAuthority: 'PAPER_ONLY',
      executionRoute,
      marketState: adaptive.marketState,
      evidenceClass: adaptive.edge.evidenceClass,
      edge: adaptive.edge,
      exposure: adaptive.exposure,
      opportunity: adaptive.opportunity,
      riskMultiplier: adaptive.riskMultiplier,
      predictionCalibration: adaptive.predictionCalibration,
      rawNetExpectedR: adaptive.rawNetExpectedR,
      candidateRiskAtStop: adaptive.candidateRiskAtStop,
      requestedRiskPercent: adaptive.requestedRiskPercent,
      scanRank: adaptive.adaptiveScanRank ?? null,
      preAdaptiveScanRank: adaptive.preAdaptiveScanRank,
      netExpectedR: adaptive.netExpectedR,
      executionCostR: adaptive.executionCostR,
      qualificationEvidence: executionRoute === 'NORMAL_PAPER',
      productionEligible: false,
    };
  }

  private async persistAdaptiveDecisionAnnotation(
    userId: string,
    opportunityKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.dataSource) {
      throw new Error('adaptive decision persistence unavailable');
    }
    await this.dataSource.query(
      `
        UPDATE trading.ensemble_shadow_decisions
        SET components = COALESCE(components, '{}'::jsonb) || jsonb_build_object(
          'adaptiveMarketIntelligence', $4::jsonb
        )
        WHERE user_id = $1
          AND engine_code = $2
          AND opportunity_key = $3
      `,
      [userId, ACTIVE_ENGINE_CODE, opportunityKey, JSON.stringify(payload)],
    );
  }

  private async persistAdaptiveScanSummary(input: {
    userId: string;
    connectionId: string;
    scanStartedAt: Date;
    evaluatedCandidates: number;
    executableWinners: number;
    best: AdaptiveScanWinner | null;
    bestEvaluated?: AdaptiveScanDiagnosticCandidate | null;
    reason: string;
  }): Promise<void> {
    const best = input.best
      ? {
          instrument: input.best.chosen.candidate.instrument,
          direction: input.best.chosen.candidate.direction,
          adaptiveScore: input.best.adaptiveScore,
          netExpectedR: input.best.netExpectedR,
          state: input.best.marketState.state,
          blockers: input.best.opportunity.hardBlockers,
        }
      : (input.bestEvaluated ?? null);
    const summary = {
      artifact: 'adaptive-scan-summary-v1',
      policyVersion: ACTIVE_MODEL_POLICY_VERSION,
      scanStartedAt: input.scanStartedAt.toISOString(),
      evaluatedCandidates: input.evaluatedCandidates,
      executableWinners: input.executableWinners,
      bestInstrument: best?.instrument ?? null,
      bestDirection: best?.direction ?? null,
      bestAdaptiveScore: best?.adaptiveScore ?? null,
      bestNetExpectedR: best?.netExpectedR ?? null,
      bestState: best?.state ?? null,
      bestBlockers: best?.blockers ?? [],
      reason: input.reason,
    };
    this.logger.log(
      `Adaptive scan summary winners=${input.executableWinners} ` +
        `best=${summary.bestInstrument ?? 'NONE'} ${summary.bestDirection ?? ''} ` +
        `score=${summary.bestAdaptiveScore ?? 'n/a'} netR=${summary.bestNetExpectedR ?? 'n/a'} ` +
        `reason=${input.reason}`,
    );
    if (!this.dataSource) return;
    const durableResourceId = `${input.connectionId}:${input.scanStartedAt.toISOString()}`;
    try {
      await this.dataSource.query(
        `
          INSERT INTO audit.audit_logs (
            actor_user_id,
            actor_type,
            action,
            resource_type,
            resource_id,
            metadata,
            severity
          )
          SELECT $1::uuid, 'SYSTEM', 'AI_ADAPTIVE_SCAN_SUMMARY', 'AdaptiveScan', $2::varchar, $3::jsonb, 'INFO'
          WHERE NOT EXISTS (
            SELECT 1
            FROM audit.audit_logs
            WHERE actor_user_id = $1::uuid
              AND actor_type = 'SYSTEM'
              AND action = 'AI_ADAPTIVE_SCAN_SUMMARY'
              AND resource_type = 'AdaptiveScan'
              AND resource_id = $2::varchar
          )
        `,
        [input.userId, durableResourceId, JSON.stringify(summary)],
      );
    } catch (error) {
      this.logger.warn(
        `Adaptive scan durable summary unavailable for ${durableResourceId}: ${(error as Error).message}`,
      );
    }
    await this.dataSource.query(
      `
        UPDATE trading.ensemble_shadow_decisions
        SET components = COALESCE(components, '{}'::jsonb) || jsonb_build_object(
          'adaptiveScanSummary', $5::jsonb
        )
        WHERE id = (
          SELECT id
          FROM trading.ensemble_shadow_decisions
          WHERE user_id = $1
            AND broker_connection_id = $2
            AND engine_code = $3
            AND evaluated_at >= $4
          ORDER BY evaluated_at DESC, id DESC
          LIMIT 1
        )
      `,
      [
        input.userId,
        input.connectionId,
        ACTIVE_ENGINE_CODE,
        input.scanStartedAt,
        JSON.stringify(summary),
      ],
    );
  }

  private materialSignalIdFor(input: {
    opportunityKey: string;
    instrument: string;
    direction: 'BUY' | 'SELL';
    requestedLotSize: string;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    strategyCode: string;
    timeframe: string;
    modelVersion: string;
  }): string {
    const canonicalMaterial = JSON.stringify([
      input.opportunityKey,
      input.instrument,
      input.direction,
      input.requestedLotSize,
      input.entryPrice,
      input.stopLoss,
      input.takeProfit,
      input.strategyCode,
      input.timeframe,
      input.modelVersion,
    ]);
    return uuidv5(canonicalMaterial, SIGNAL_NAMESPACE);
  }

  private async resolveSignalDeliveryTimestamp(
    userId: string,
    signalId: string,
  ): Promise<{
    deliver: boolean;
    generatedAt: Date | null;
    reason:
      | 'NEW_MARKET_EVENT'
      | 'IN_MEMORY_RETRY_IDENTITY_REUSED'
      | 'DURABLE_RETRY_IDENTITY_REUSED'
      | 'MARKET_EVENT_ALREADY_EVALUATED';
  }> {
    const now = new Date();
    const retentionMs = SIGNAL_MAX_AGE_MS - 5_000;
    for (const [id, generatedAt] of this.signalGeneratedAtById.entries()) {
      if (now.getTime() - generatedAt.getTime() > retentionMs) {
        this.signalGeneratedAtById.delete(id);
      }
    }

    const inMemory = this.signalGeneratedAtById.get(signalId);
    if (inMemory) {
      return {
        deliver: true,
        generatedAt: inMemory,
        reason: 'IN_MEMORY_RETRY_IDENTITY_REUSED',
      };
    }

    if (this.dataSource) {
      let rows: Array<{ generated_at: Date | string | null }>;
      try {
        rows = (await this.dataSource.query(
          `
            SELECT generated_at
            FROM trading.ai_signal_identities
            WHERE user_id = $1
              AND signal_id = $2
            LIMIT 1
          `,
          [userId, signalId],
        )) as Array<{ generated_at: Date | string | null }>;
      } catch (error) {
        throw new Error(
          `Adaptive signal identity lookup failed closed: ${(error as Error).message}`,
        );
      }

      const persistedRaw = rows[0]?.generated_at ?? null;
      if (persistedRaw != null) {
        const persisted = new Date(persistedRaw);
        if (!Number.isFinite(persisted.getTime())) {
          throw new Error('Adaptive signal identity lookup returned an invalid generated_at');
        }
        if (now.getTime() - persisted.getTime() <= retentionMs) {
          this.signalGeneratedAtById.set(signalId, persisted);
          return {
            deliver: true,
            generatedAt: persisted,
            reason: 'DURABLE_RETRY_IDENTITY_REUSED',
          };
        }
        return {
          deliver: false,
          generatedAt: null,
          reason: 'MARKET_EVENT_ALREADY_EVALUATED',
        };
      }
    }

    this.signalGeneratedAtById.set(signalId, now);
    return { deliver: true, generatedAt: now, reason: 'NEW_MARKET_EVENT' };
  }

  private retrySafePreIntentErrorForOutcome(outcome: {
    outcome: string;
    reason?: string;
  }): (Error & { code: typeof PAPER_PRE_INTENT_RETRY_SAFE_CODE }) | null {
    const retrySafe =
      outcome.outcome === 'EXECUTION_FAILED' &&
      typeof outcome.reason === 'string' &&
      outcome.reason.startsWith('Trade intent could not be recorded (fail-closed):');
    if (!retrySafe) return null;

    return Object.assign(new Error(`Retry-safe pre-intent PAPER failure: ${outcome.reason}`), {
      code: PAPER_PRE_INTENT_RETRY_SAFE_CODE as typeof PAPER_PRE_INTENT_RETRY_SAFE_CODE,
    });
  }

  private isFxWeeklySessionOpen(now: Date): boolean {
    return isFxWeeklySessionOpenAt(now);
  }

  private marketSchedule(now: Date): {
    paused: boolean;
    reason: 'WEEKEND' | 'ROLLOVER_LOW_LIQUIDITY' | null;
    nextEligibleScanAt: string;
  } {
    const marketOpen = this.isFxWeeklySessionOpen(now);
    // FX weekly boundary is 17:00 America/New_York. Using the broker-market
    // timezone keeps Sunday open / Friday close correct across EDT and EST.
    // Do not impose a blanket nightly shutdown; spread, regime and governance
    // gates decide whether low-liquidity rollover conditions are tradable.
    const paused = !marketOpen;
    const reason = paused ? 'WEEKEND' : null;
    return {
      paused,
      reason,
      nextEligibleScanAt: this.nextEligibleScanAt(now).toISOString(),
    };
  }

  private nextEligibleScanAt(now: Date): Date {
    const candidate = new Date(now);
    candidate.setUTCSeconds(0, 0);
    const remainder = candidate.getUTCMinutes() % COLLECTION_CADENCE_MINUTES;
    candidate.setUTCMinutes(
      candidate.getUTCMinutes() +
        (remainder === 0 ? COLLECTION_CADENCE_MINUTES : COLLECTION_CADENCE_MINUTES - remainder),
    );
    for (let i = 0; i < 7 * 24 * 6 + 12; i += 1) {
      if (this.isFxWeeklySessionOpen(candidate)) return candidate;
      candidate.setUTCMinutes(candidate.getUTCMinutes() + COLLECTION_CADENCE_MINUTES);
    }
    return candidate;
  }

  private isCollectionSlot(now: Date): boolean {
    return Number.isFinite(now.getTime()) && this.isFxWeeklySessionOpen(now);
  }

  private recordEvaluation(candidates: Candidate[]): void {
    const best = [...candidates].sort((a, b) => b.score - a.score)[0];
    this.lastEvaluation = best
      ? {
          confidence: best.confidence,
          instrument: best.instrument,
          direction: best.direction,
          evaluatedAt: new Date(),
          qualified: true,
          reason: 'QUALIFYING_SETUP',
        }
      : {
          confidence: null,
          instrument: null,
          direction: null,
          evaluatedAt: new Date(),
          qualified: false,
          reason: 'NO_QUALIFYING_SETUP',
        };
  }

  private async loadEnsembleCampaignStatus(userId: string, connectionId: string) {
    const empty = {
      decisions: 0,
      admitted: 0,
      rejected: 0,
      resolved: 0,
      evaluableResolved: 0,
      wins: 0,
      losses: 0,
      expired: 0,
      ambiguous: 0,
      netR: 0,
      profitFactor: null as number | null,
      sharpe: null as number | null,
      maxDrawdown: null as number | null,
      positiveWindowFraction: null as number | null,
      firstEvaluatedAt: null as string | null,
      lastEvaluatedAt: null as string | null,
      blockerCounts: {} as Record<string, number>,
      highConvictionOverlayCounts: {
        CONFIRM: 0,
        CONFLICT: 0,
        ABSTAIN: 0,
        STALE: 0,
        UNAVAILABLE: 0,
      } as Record<HighConvictionOverlay['state'], number>,
      highConvictionOverlayPerformance: {
        CONFIRM: summarizeHighConvictionOverlayCohort('CONFIRM', 0, []),
        CONFLICT: summarizeHighConvictionOverlayCohort('CONFLICT', 0, []),
        ABSTAIN: summarizeHighConvictionOverlayCohort('ABSTAIN', 0, []),
        STALE: summarizeHighConvictionOverlayCohort('STALE', 0, []),
        UNAVAILABLE: summarizeHighConvictionOverlayCohort('UNAVAILABLE', 0, []),
      } as Record<
        HighConvictionOverlayState,
        ReturnType<typeof summarizeHighConvictionOverlayCohort>
      >,
      profitProtection: {
        pathResolved: 0,
        lossesWithPath: 0,
        positiveMfeThenLosses: 0,
        lossesAfterHalfR: 0,
        lossesAfterOneR: 0,
        averageMaxFavorableR: null as number | null,
        averageMaxCloseGivebackR: null as number | null,
        counterfactuals: [] as Array<{
          code: string;
          observations: number;
          activated: number;
          exitedEarly: number;
          baselineNetR: number;
          policyNetR: number;
          deltaNetR: number;
          improved: number;
          worsened: number;
          unchanged: number;
        }>,
      },
      sleeves: [] as Array<{
        instrument: string;
        direction: 'BUY' | 'SELL';
        decisions: number;
        admitted: number;
        resolved: number;
        state: ReturnType<typeof classifyEnsembleSleeveEvidence>;
        evidence: ReturnType<typeof summarizeEnsembleSleeveOutcomes>;
      }>,
    };
    if (!this.dataSource || !userId || !connectionId) return empty;

    const rows = (await this.dataSource.query(
      `
        SELECT instrument, direction, admitted, evaluated_at, components
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND model_version = $4
        ORDER BY evaluated_at ASC
        LIMIT 10000
      `,
      [userId, connectionId, ACTIVE_ENGINE_CODE, ACTIVE_MODEL_POLICY_VERSION],
    )) as Array<{
      instrument: string;
      direction: 'BUY' | 'SELL';
      admitted: boolean;
      evaluated_at: string | Date;
      components: Record<string, unknown> | null;
    }>;
    if (!rows.length) return empty;

    const allOutcomes: EnsembleShadowOutcome[] = [];
    const blockerCounts: Record<string, number> = {};
    const highConvictionOverlayCounts: Record<HighConvictionOverlay['state'], number> = {
      CONFIRM: 0,
      CONFLICT: 0,
      ABSTAIN: 0,
      STALE: 0,
      UNAVAILABLE: 0,
    };
    const highConvictionOverlayOutcomes = new Map<
      HighConvictionOverlayState,
      EnsembleShadowOutcome[]
    >(
      (['CONFIRM', 'CONFLICT', 'ABSTAIN', 'STALE', 'UNAVAILABLE'] as const).map((state) => [
        state,
        [],
      ]),
    );
    const sleeveMap = new Map<
      string,
      {
        instrument: string;
        direction: 'BUY' | 'SELL';
        decisions: number;
        admitted: number;
        outcomes: EnsembleShadowOutcome[];
      }
    >();

    for (const row of rows) {
      const key = `${row.instrument}|${row.direction}`;
      const sleeve = sleeveMap.get(key) ?? {
        instrument: row.instrument,
        direction: row.direction,
        decisions: 0,
        admitted: 0,
        outcomes: [],
      };
      sleeve.decisions += 1;
      if (row.admitted) sleeve.admitted += 1;

      const components = row.components;
      if (components && typeof components === 'object') {
        let parsedOutcome: EnsembleShadowOutcome | null = null;
        const outcome = components.outcome;
        if (
          outcome &&
          typeof outcome === 'object' &&
          typeof (outcome as Record<string, unknown>).status === 'string'
        ) {
          parsedOutcome = outcome as unknown as EnsembleShadowOutcome;
          sleeve.outcomes.push(parsedOutcome);
          allOutcomes.push(parsedOutcome);
        }

        const overlay = components.highConvictionOverlay;
        if (overlay && typeof overlay === 'object') {
          const state = (overlay as Record<string, unknown>).state;
          if (
            state === 'CONFIRM' ||
            state === 'CONFLICT' ||
            state === 'ABSTAIN' ||
            state === 'STALE' ||
            state === 'UNAVAILABLE'
          ) {
            highConvictionOverlayCounts[state] += 1;
            if (parsedOutcome) {
              highConvictionOverlayOutcomes.get(state)?.push(parsedOutcome);
            }
          }
        }

        const governance = components.governance;
        if (governance && typeof governance === 'object') {
          const blockers = (governance as Record<string, unknown>).blockers;
          if (Array.isArray(blockers)) {
            for (const blocker of blockers) {
              if (typeof blocker !== 'string') continue;
              blockerCounts[blocker] = (blockerCounts[blocker] ?? 0) + 1;
            }
          }
        }
      }
      sleeveMap.set(key, sleeve);
    }

    const highConvictionOverlayPerformance = Object.fromEntries(
      (['CONFIRM', 'CONFLICT', 'ABSTAIN', 'STALE', 'UNAVAILABLE'] as const).map((state) => [
        state,
        summarizeHighConvictionOverlayCohort(
          state,
          highConvictionOverlayCounts[state],
          highConvictionOverlayOutcomes.get(state) ?? [],
        ),
      ]),
    ) as Record<
      HighConvictionOverlayState,
      ReturnType<typeof summarizeHighConvictionOverlayCohort>
    >;

    const evidence = summarizeEnsembleSleeveOutcomes(allOutcomes);
    const validOutcomes = allOutcomes.filter(
      (outcome) => outcome.status !== 'AMBIGUOUS' && outcome.netR != null,
    );
    const pathOutcomes = validOutcomes.filter((outcome) => outcome.postEntryTelemetry != null);
    const lossesWithPath = pathOutcomes.filter((outcome) => outcome.status === 'LOSS');
    const average = (values: number[]): number | null =>
      values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const counterfactualMap = new Map<
      string,
      {
        code: string;
        observations: number;
        activated: number;
        exitedEarly: number;
        baselineNetR: number;
        policyNetR: number;
        deltaNetR: number;
        improved: number;
        worsened: number;
        unchanged: number;
      }
    >();
    for (const outcome of pathOutcomes) {
      const baselineNetR = outcome.netR ?? 0;
      for (const policy of outcome.postEntryTelemetry?.profitProtectionCounterfactuals ?? []) {
        const summary = counterfactualMap.get(policy.code) ?? {
          code: policy.code,
          observations: 0,
          activated: 0,
          exitedEarly: 0,
          baselineNetR: 0,
          policyNetR: 0,
          deltaNetR: 0,
          improved: 0,
          worsened: 0,
          unchanged: 0,
        };
        summary.observations += 1;
        if (policy.activated) summary.activated += 1;
        if (policy.exitedEarly) summary.exitedEarly += 1;
        summary.baselineNetR += baselineNetR;
        summary.policyNetR += policy.netR;
        summary.deltaNetR += policy.deltaNetRVsBase;
        if (policy.deltaNetRVsBase > 1e-9) summary.improved += 1;
        else if (policy.deltaNetRVsBase < -1e-9) summary.worsened += 1;
        else summary.unchanged += 1;
        counterfactualMap.set(policy.code, summary);
      }
    }
    const protectionCounterfactuals = [...counterfactualMap.values()].sort(
      (a, b) => b.deltaNetR - a.deltaNetR || a.code.localeCompare(b.code),
    );

    const profitProtection = {
      pathResolved: pathOutcomes.length,
      lossesWithPath: lossesWithPath.length,
      positiveMfeThenLosses: lossesWithPath.filter(
        (outcome) => (outcome.postEntryTelemetry?.maxFavorableR ?? 0) > 0,
      ).length,
      lossesAfterHalfR: lossesWithPath.filter(
        (outcome) => outcome.postEntryTelemetry?.gaveBackHalfRToLoss,
      ).length,
      lossesAfterOneR: lossesWithPath.filter(
        (outcome) => outcome.postEntryTelemetry?.gaveBackOneRToLoss,
      ).length,
      averageMaxFavorableR: average(
        pathOutcomes.map((outcome) => outcome.postEntryTelemetry!.maxFavorableR),
      ),
      averageMaxCloseGivebackR: average(
        pathOutcomes.map((outcome) => outcome.postEntryTelemetry!.maxCloseGivebackR),
      ),
      counterfactuals: protectionCounterfactuals,
    };
    const sleeves = [...sleeveMap.values()]
      .map((sleeve) => {
        const sleeveEvidence = summarizeEnsembleSleeveOutcomes(sleeve.outcomes);
        return {
          instrument: sleeve.instrument,
          direction: sleeve.direction,
          decisions: sleeve.decisions,
          admitted: sleeve.admitted,
          resolved: sleeve.outcomes.length,
          state: classifyEnsembleSleeveEvidence(sleeveEvidence),
          evidence: sleeveEvidence,
        };
      })
      .sort((a, b) =>
        a.instrument === b.instrument
          ? a.direction.localeCompare(b.direction)
          : a.instrument.localeCompare(b.instrument),
      );

    return {
      decisions: rows.length,
      admitted: rows.filter((row) => row.admitted).length,
      rejected: rows.filter((row) => !row.admitted).length,
      resolved: allOutcomes.length,
      evaluableResolved: validOutcomes.length,
      wins: allOutcomes.filter((outcome) => outcome.status === 'WIN').length,
      losses: allOutcomes.filter((outcome) => outcome.status === 'LOSS').length,
      expired: allOutcomes.filter((outcome) => outcome.status === 'EXPIRED').length,
      ambiguous: allOutcomes.filter((outcome) => outcome.status === 'AMBIGUOUS').length,
      netR: validOutcomes.reduce((sum, outcome) => sum + (outcome.netR ?? 0), 0),
      profitFactor: evidence.profitFactor,
      sharpe: evidence.sharpe,
      maxDrawdown: evidence.maxDrawdown,
      positiveWindowFraction: evidence.positiveWindowFraction,
      firstEvaluatedAt: new Date(rows[0]!.evaluated_at).toISOString(),
      lastEvaluatedAt: new Date(rows[rows.length - 1]!.evaluated_at).toISOString(),
      blockerCounts,
      highConvictionOverlayCounts,
      highConvictionOverlayPerformance,
      profitProtection,
      sleeves,
    };
  }

  private async resolvePendingEnsembleShadowOutcomes(
    userId: string,
    connectionId: string,
    seriesByInstrument: Map<string, LivePaperCandleInput[]>,
  ): Promise<void> {
    if (!this.dataSource) return;
    const earliestCandleMs = [...seriesByInstrument.values()]
      .flatMap((candles) => candles.map((candle) => candle.timestamp.getTime()))
      .filter(Number.isFinite)
      .reduce((earliest, timestamp) => Math.min(earliest, timestamp), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliestCandleMs)) return;
    const earliestResolvableDecisionBar = new Date(earliestCandleMs - BAR_MS);

    const rows = (await this.dataSource.query(
      `
        SELECT
          id,
          instrument,
          direction,
          market_bar_time,
          evaluated_at,
          entry_price,
          components
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND market_bar_time >= $4
          AND model_version = ANY($5::text[])
          AND NOT (components ? 'outcome')
        ORDER BY evaluated_at ASC
        LIMIT 1500
      `,
      [
        userId,
        connectionId,
        ACTIVE_ENGINE_CODE,
        earliestResolvableDecisionBar,
        [...PLAN_B_PREDICTION_CALIBRATION_EVIDENCE_POLICY_VERSIONS],
      ],
    )) as Array<{
      id: string;
      instrument: string;
      direction: 'BUY' | 'SELL';
      market_bar_time: string | Date;
      evaluated_at: string | Date;
      entry_price: string | number;
      components: Record<string, unknown> | null;
    }>;

    let resolvedCount = 0;
    for (const row of rows) {
      const candles = seriesByInstrument.get(row.instrument);
      const components = row.components;
      if (!candles || !components || typeof components !== 'object') continue;

      const stopLoss = Number(components.stopLoss);
      const takeProfit = Number(components.takeProfit);
      const governance =
        components.governance && typeof components.governance === 'object'
          ? (components.governance as Record<string, unknown>)
          : null;
      const estimatedExecutionCostR = Number(governance?.estimatedExecutionCostR ?? 0);
      const spreadEvidence =
        governance?.executionSpreadEvidence &&
        typeof governance.executionSpreadEvidence === 'object'
          ? (governance.executionSpreadEvidence as Record<string, unknown>)
          : null;
      const rawExecutionSpreadPrice = Number(spreadEvidence?.spreadPrice ?? 0);
      const executionSpreadPrice =
        Number.isFinite(rawExecutionSpreadPrice) && rawExecutionSpreadPrice >= 0
          ? rawExecutionSpreadPrice
          : 0;
      if (
        !Number.isFinite(stopLoss) ||
        !Number.isFinite(takeProfit) ||
        !Number.isFinite(estimatedExecutionCostR)
      ) {
        continue;
      }

      const outcome = resolveEnsembleShadowOutcome(
        {
          direction: row.direction,
          marketBarTime: row.market_bar_time,
          evaluatedAt: row.evaluated_at,
          entryPrice: Number(row.entry_price),
          stopLoss,
          takeProfit,
          estimatedExecutionCostR,
          executionSpreadPrice,
          candlePriceBasis:
            this.lastMarketDataAuthority === 'METAAPI_BROKER_FALLBACK' ? 'BID' : 'MID',
        },
        candles,
      );
      if (!outcome) continue;

      await this.dataSource.query(
        `
          UPDATE trading.ensemble_shadow_decisions
          SET components = jsonb_set(components, '{outcome}', $2::jsonb, true)
          WHERE id = $1
            AND NOT (components ? 'outcome')
        `,
        [row.id, JSON.stringify(outcome)],
      );
      resolvedCount += 1;
    }

    if (resolvedCount > 0) {
      this.logger.log(`Multi-model shadow outcomes resolved count=${resolvedCount}`);
    }
  }

  private async loadPaperTrendRouteReliabilityEvidence(
    userId: string,
    connectionId: string,
  ): Promise<EnsembleSleeveEvidence | null> {
    if (!this.dataSource) return null;

    const rows = (await this.dataSource.query(
      `
        SELECT instrument, direction, evaluated_at, components->'outcome' AS outcome
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND model_version = ANY($4::text[])
          AND components->>'strategyRoute' = 'TREND_CONTINUATION'
          AND COALESCE((components->>'paperAdmitted')::boolean, false) = true
          AND COALESCE(
            (components->'governance'->>'paperExecutionEligible')::boolean,
            false
          ) = true
          AND components ? 'outcome'
          AND components->'outcome'->>'version' = $5
        ORDER BY evaluated_at ASC
      `,
      [
        userId,
        connectionId,
        ACTIVE_ENGINE_CODE,
        [...PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS],
        ENSEMBLE_OUTCOME_MODEL_VERSION,
      ],
    )) as Array<{
      instrument: string;
      direction: 'BUY' | 'SELL';
      evaluated_at: string | Date;
      outcome: EnsembleShadowOutcome | null;
    }>;

    const byPairSide = new Map<
      string,
      Array<{ evaluatedAt: string | Date; outcome: EnsembleShadowOutcome }>
    >();
    for (const row of rows) {
      if (
        !row.outcome ||
        typeof row.outcome !== 'object' ||
        typeof row.outcome.status !== 'string'
      ) {
        continue;
      }
      const key = `${row.instrument}|${row.direction}`;
      const observations = byPairSide.get(key) ?? [];
      observations.push({ evaluatedAt: row.evaluated_at, outcome: row.outcome });
      byPairSide.set(key, observations);
    }

    const episodes = [...byPairSide.values()]
      .flatMap((observations) => collapseEnsembleOutcomeEpisodes(observations))
      .sort((a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime());
    return summarizeEnsembleSleeveOutcomes(episodes);
  }

  private async loadPaperTrendPairSideReliabilitySnapshot(
    userId: string,
    connectionId: string,
  ): Promise<PaperTrendPairSideReliabilityStatus[]> {
    const cacheKey = [
      userId,
      connectionId,
      ...PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS,
      ENSEMBLE_OUTCOME_MODEL_VERSION,
    ].join(':');
    const cached = this.pairSideReliabilityStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot;

    const rows = this.dataSource
      ? ((await this.dataSource.query(
          `
            SELECT instrument, direction, evaluated_at, components->'outcome' AS outcome
            FROM trading.ensemble_shadow_decisions
            WHERE user_id = $1
              AND broker_connection_id = $2
              AND engine_code = $3
              AND model_version = ANY($4::text[])
              AND instrument = ANY($5::text[])
              AND direction IN ('BUY', 'SELL')
              AND components->>'strategyRoute' = 'TREND_CONTINUATION'
              AND COALESCE((components->>'paperAdmitted')::boolean, false) = true
              AND COALESCE(
                (components->'governance'->>'paperExecutionEligible')::boolean,
                false
              ) = true
              AND components ? 'outcome'
              AND components->'outcome'->>'version' = $6
            ORDER BY instrument, direction, evaluated_at ASC
          `,
          [
            userId,
            connectionId,
            ACTIVE_ENGINE_CODE,
            [...PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS],
            SYMBOLS.map(([instrument]) => instrument),
            ENSEMBLE_OUTCOME_MODEL_VERSION,
          ],
        )) as Array<{
          instrument: string;
          direction: 'BUY' | 'SELL';
          evaluated_at: string | Date;
          outcome: EnsembleShadowOutcome | null;
        }>)
      : [];

    const grouped = new Map<
      string,
      Array<{ evaluatedAt: string | Date; outcome: EnsembleShadowOutcome | null }>
    >();
    for (const row of rows) {
      const instrument = row.instrument.trim().toUpperCase();
      if (!SYMBOLS.some(([symbol]) => symbol === instrument)) continue;
      if (row.direction !== 'BUY' && row.direction !== 'SELL') continue;
      const key = `${instrument}:${row.direction}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push({ evaluatedAt: row.evaluated_at, outcome: row.outcome });
      grouped.set(key, bucket);
    }

    const snapshot = SYMBOLS.flatMap(([instrument]) =>
      (['BUY', 'SELL'] as const).map((direction) => {
        const episodes = collapseEnsembleOutcomeEpisodes(
          grouped.get(`${instrument}:${direction}`) ?? [],
        );
        const evidence = summarizeEnsembleSleeveOutcomes(episodes);
        const decision = evaluatePaperTrendPairSideReliability({
          strategyRoute: 'TREND_CONTINUATION',
          evidence,
        });
        return {
          instrument,
          direction,
          state: decision.state,
          episodes: decision.episodes,
          profitFactor: decision.profitFactor,
          sharpe: decision.sharpe,
          maxDrawdown: decision.maxDrawdown,
          positiveWindowFraction: decision.positiveWindowFraction,
          fullSizeEligible: decision.fullSizeEligible,
          researchFallbackRequested: decision.researchFallbackRequested,
          reason: decision.reason,
        };
      }),
    );
    this.pairSideReliabilityStatusCache.set(cacheKey, {
      expiresAt: Date.now() + PAPER_RELIABILITY_STATUS_CACHE_TTL_MS,
      snapshot,
    });
    return snapshot;
  }

  private async loadPaperTrendPairSideReliabilityEvidence(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<EnsembleSleeveEvidence | null> {
    if (!this.dataSource) return null;

    const rows = (await this.dataSource.query(
      `
        SELECT evaluated_at, components->'outcome' AS outcome
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND model_version = ANY($4::text[])
          AND instrument = $5
          AND direction = $6
          AND components->>'strategyRoute' = 'TREND_CONTINUATION'
          AND COALESCE((components->>'paperAdmitted')::boolean, false) = true
          AND COALESCE(
            (components->'governance'->>'paperExecutionEligible')::boolean,
            false
          ) = true
          AND components ? 'outcome'
          AND components->'outcome'->>'version' = $7
        ORDER BY evaluated_at ASC
      `,
      [
        userId,
        connectionId,
        ACTIVE_ENGINE_CODE,
        [...PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS],
        instrument,
        direction,
        ENSEMBLE_OUTCOME_MODEL_VERSION,
      ],
    )) as Array<{
      evaluated_at: string | Date;
      outcome: EnsembleShadowOutcome | null;
    }>;

    const episodes = collapseEnsembleOutcomeEpisodes(
      rows.map((row) => ({ evaluatedAt: row.evaluated_at, outcome: row.outcome })),
    );
    return summarizeEnsembleSleeveOutcomes(episodes);
  }

  private async loadPaperCostAwareEntryEvidence(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<PaperCostAwareCohortEvidence> {
    if (!this.dataSource) {
      return { grossPositiveSamples: 0, costFlippedSamples: 0, netPositiveSamples: 0 };
    }

    const rows = (await this.dataSource.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE expected_r > 0)::int AS gross_positive_samples,
          COUNT(*) FILTER (
            WHERE expected_r > 0
              AND COALESCE(NULLIF(components->'governance'->>'netExpectedR', '')::numeric, -999) <= 0
          )::int AS cost_flipped_samples,
          COUNT(*) FILTER (
            WHERE expected_r > 0
              AND COALESCE(NULLIF(components->'governance'->>'netExpectedR', '')::numeric, -999) > 0
          )::int AS net_positive_samples
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND model_version = $4
          AND instrument = $5
          AND direction = $6
          AND components->>'strategyRoute' = 'TREND_CONTINUATION'
          AND COALESCE(
            (components->'governance'->>'paperExecutionCostUsable')::boolean,
            false
          ) = true
          AND evaluated_at >= NOW() - INTERVAL '24 hours'
      `,
      [
        userId,
        connectionId,
        ACTIVE_ENGINE_CODE,
        ACTIVE_MODEL_POLICY_VERSION,
        instrument.trim().toUpperCase(),
        direction,
      ],
    )) as Array<{
      gross_positive_samples: number | string | null;
      cost_flipped_samples: number | string | null;
      net_positive_samples: number | string | null;
    }>;

    const row = rows[0];
    return {
      grossPositiveSamples: Math.max(0, Number(row?.gross_positive_samples ?? 0)),
      costFlippedSamples: Math.max(0, Number(row?.cost_flipped_samples ?? 0)),
      netPositiveSamples: Math.max(0, Number(row?.net_positive_samples ?? 0)),
    };
  }

  private async annotatePaperCostAwareEntryDecision(
    userId: string,
    connectionId: string,
    opportunityKey: string,
    decision: PaperCostAwareEntryDecision,
    evidence: PaperCostAwareCohortEvidence,
  ): Promise<void> {
    if (!this.dataSource) return;
    try {
      await this.dataSource.query(
        `
          UPDATE trading.ensemble_shadow_decisions
          SET components = jsonb_set(
            components,
            '{paperCostAwareEntry}',
            $5::jsonb,
            true
          )
          WHERE user_id = $1
            AND broker_connection_id = $2
            AND engine_code = $3
            AND opportunity_key = $4
        `,
        [
          userId,
          connectionId,
          ACTIVE_ENGINE_CODE,
          opportunityKey,
          JSON.stringify({ ...decision, evidence }),
        ],
      );
    } catch (error) {
      this.logger.warn(
        `PAPER cost-aware entry annotation unavailable: ${(error as Error).message}`,
      );
    }
  }

  private async loadPaperResearchPortfolioOutcomes(
    userId: string,
    connectionId: string,
  ): Promise<Array<'WIN' | 'LOSS'>> {
    if (!this.dataSource) return [];
    try {
      const rows = (await this.dataSource.query(
        `
          SELECT CASE WHEN t.realised_pnl > 0 THEN 'WIN' ELSE 'LOSS' END AS outcome
          FROM trading.trade_intents ti
          JOIN trading.trades t ON t.trade_intent_id = ti.id
          WHERE ti.user_id = $1
            AND ti.broker_connection_id = $2
            AND ti.status = 'EXECUTED'
            AND ti.metadata->>'paper_research_throughput' = 'true'
            AND ti.metadata->>'paper_research_throughput_artifact' = ANY($3::text[])
            AND ti.metadata->>'decision_policy_version' = $4
            AND t.status = 'CLOSED'
            AND t.realised_pnl IS NOT NULL
            AND t.realised_pnl <> 0
            AND t.closed_at >= NOW() - INTERVAL '6 hours'
          ORDER BY t.closed_at DESC
          LIMIT 5
        `,
        [
          userId,
          connectionId,
          [...PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS],
          ACTIVE_MODEL_POLICY_VERSION,
        ],
      )) as Array<{ outcome: 'WIN' | 'LOSS' }>;
      return rows
        .map((row) => row.outcome)
        .filter((outcome): outcome is 'WIN' | 'LOSS' => outcome === 'WIN' || outcome === 'LOSS');
    } catch (error) {
      this.logger.warn(
        `PAPER research portfolio brake evidence unavailable: ${(error as Error).message}`,
      );
      return [];
    }
  }

  private async loadPaperResearchPairSideEvidence(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<{ wins: number; losses: number; realisedRSamples: number; realisedRSum: number }> {
    if (!this.dataSource) {
      return { wins: 0, losses: 0, realisedRSamples: 0, realisedRSum: 0 };
    }

    const rows = (await this.dataSource.query(
      `
        SELECT
          ti.metadata->>'decision_policy_version' AS policy_version,
          t.realised_pnl,
          t.fill_price,
          t.exit_price,
          t.stop_loss,
          t.closed_at
        FROM trading.trade_intents ti
        JOIN trading.trades t ON t.trade_intent_id = ti.id
        WHERE ti.user_id = $1
          AND ti.broker_connection_id = $2
          AND ti.instrument = $3
          AND ti.direction = $4
          AND ti.status = 'EXECUTED'
          AND ti.metadata->>'paper_research_throughput' = 'true'
          AND ti.metadata->>'paper_research_throughput_artifact' = ANY($5::text[])
          AND ti.metadata->>'decision_policy_version' = ANY($6::text[])
          AND t.status = 'CLOSED'
          AND t.realised_pnl IS NOT NULL
          AND t.realised_pnl <> 0
          AND t.closed_at >= NOW() - INTERVAL '7 days'
        ORDER BY
          CASE WHEN ti.metadata->>'decision_policy_version' = $7 THEN 0 ELSE 1 END,
          t.closed_at DESC
        LIMIT 25
      `,
      [
        userId,
        connectionId,
        instrument.trim().toUpperCase(),
        direction,
        [...PAPER_RESEARCH_THROUGHPUT_RELIABILITY_SOURCE_ARTIFACTS],
        [...PLAN_B_PREDICTION_CALIBRATION_EVIDENCE_POLICY_VERSIONS],
        ACTIVE_MODEL_POLICY_VERSION,
      ],
    )) as Array<{
      policy_version: string | null;
      realised_pnl: number | string | null;
      fill_price: number | string | null;
      exit_price: number | string | null;
      stop_loss: number | string | null;
      closed_at: string | Date | null;
    }>;

    const currentPolicyRows = rows.filter(
      (row) => row.policy_version === ACTIVE_MODEL_POLICY_VERSION && Number(row.realised_pnl) !== 0,
    );
    const predecessorRows = rows.filter(
      (row) => row.policy_version !== ACTIVE_MODEL_POLICY_VERSION && Number(row.realised_pnl) !== 0,
    );
    const maxSamples = 20;
    const selected =
      currentPolicyRows.length >= PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES
        ? currentPolicyRows.slice(0, maxSamples)
        : [
            ...currentPolicyRows,
            ...predecessorRows.slice(
              0,
              PAPER_RESEARCH_THROUGHPUT_RELIABILITY_MIN_SAMPLES - currentPolicyRows.length,
            ),
          ];

    const realisedRs = selected
      .map((row) => {
        const fill = Number(row.fill_price);
        const exit = Number(row.exit_price);
        const initialStop = Number(row.stop_loss);
        if (
          !Number.isFinite(fill) ||
          !Number.isFinite(exit) ||
          !Number.isFinite(initialStop) ||
          fill <= 0 ||
          exit <= 0 ||
          initialStop <= 0
        ) {
          return null;
        }
        const riskDistance = direction === 'BUY' ? fill - initialStop : initialStop - fill;
        if (!Number.isFinite(riskDistance) || riskDistance <= 0) return null;
        const realisedMove = direction === 'BUY' ? exit - fill : fill - exit;
        const realisedR = realisedMove / riskDistance;
        return Number.isFinite(realisedR) ? realisedR : null;
      })
      .filter((value): value is number => value !== null);

    return {
      wins: selected.filter((row) => Number(row.realised_pnl) > 0).length,
      losses: selected.filter((row) => Number(row.realised_pnl) < 0).length,
      realisedRSamples: realisedRs.length,
      realisedRSum: realisedRs.reduce((sum, value) => sum + value, 0),
    };
  }

  private async loadPaperResearchEpisodeState(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<{
    previousEpisodeKey: string | null;
    previousTradeStatus: string | null;
    previousClosedAt: Date | null;
  }> {
    const empty = {
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    };
    if (!this.dataSource) return empty;

    const rows = (await this.dataSource.query(
      `
        SELECT
          ti.metadata->>'paper_research_episode_key' AS episode_key,
          t.status AS trade_status,
          t.closed_at
        FROM trading.trade_intents ti
        JOIN trading.trades t ON t.trade_intent_id = ti.id
        WHERE ti.user_id = $1
          AND ti.broker_connection_id = $2
          AND ti.instrument = $3
          AND ti.direction = $4
          AND ti.status = 'EXECUTED'
          AND ti.model_version LIKE $5
          AND t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING', 'CLOSED')
        ORDER BY
          CASE
            WHEN t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING') THEN 0
            ELSE 1
          END,
          CASE
            WHEN t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING') THEN ti.created_at
            ELSE NULL
          END DESC,
          COALESCE(t.closed_at, ti.created_at) DESC
        LIMIT 1
      `,
      [
        userId,
        connectionId,
        instrument.trim().toUpperCase(),
        direction,
        `external-provider/${ACTIVE_ENGINE_CODE}/paper-research-throughput-%`,
      ],
    )) as Array<{
      episode_key: string | null;
      trade_status: string | null;
      closed_at: string | Date | null;
    }>;

    const row = rows[0];
    if (!row) return empty;
    const closedAt = row.closed_at ? new Date(row.closed_at) : null;
    return {
      previousEpisodeKey: row.episode_key ?? null,
      previousTradeStatus: row.trade_status ?? null,
      previousClosedAt: closedAt && Number.isFinite(closedAt.getTime()) ? closedAt : null,
    };
  }

  private async loadPaperExtensionExhaustionPairSideEvidence(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<{ wins: number; losses: number; realisedRSamples: number; realisedRSum: number }> {
    if (!this.dataSource) {
      return { wins: 0, losses: 0, realisedRSamples: 0, realisedRSum: 0 };
    }
    const rows = (await this.dataSource.query(
      `
        SELECT t.realised_pnl, t.fill_price, t.exit_price, t.stop_loss
        FROM trading.trade_intents ti
        JOIN trading.trades t ON t.trade_intent_id = ti.id
        WHERE ti.user_id = $1
          AND ti.broker_connection_id = $2
          AND ti.instrument = $3
          AND ti.direction = $4
          AND ti.status = 'EXECUTED'
          AND ti.metadata->>'paper_extension_exhaustion_research' = 'true'
          AND ti.metadata->>'paper_extension_exhaustion_research_artifact' = $5
          AND t.status = 'CLOSED'
          AND t.realised_pnl IS NOT NULL
          AND t.realised_pnl <> 0
          AND t.closed_at >= NOW() - INTERVAL '7 days'
        ORDER BY t.closed_at DESC
        LIMIT 20
      `,
      [
        userId,
        connectionId,
        instrument.trim().toUpperCase(),
        direction,
        PAPER_EXTENSION_EXHAUSTION_RESEARCH_ARTIFACT,
      ],
    )) as Array<{
      realised_pnl: number | string | null;
      fill_price: number | string | null;
      exit_price: number | string | null;
      stop_loss: number | string | null;
    }>;
    const realisedRs = rows
      .map((row) => {
        const fill = Number(row.fill_price);
        const exit = Number(row.exit_price);
        const initialStop = Number(row.stop_loss);
        if (!Number.isFinite(fill) || !Number.isFinite(exit) || !Number.isFinite(initialStop)) {
          return null;
        }
        const riskDistance = direction === 'BUY' ? fill - initialStop : initialStop - fill;
        if (!Number.isFinite(riskDistance) || riskDistance <= 0) return null;
        const realisedMove = direction === 'BUY' ? exit - fill : fill - exit;
        const realisedR = realisedMove / riskDistance;
        return Number.isFinite(realisedR) ? realisedR : null;
      })
      .filter((value): value is number => value !== null);
    return {
      wins: rows.filter((row) => Number(row.realised_pnl) > 0).length,
      losses: rows.filter((row) => Number(row.realised_pnl) < 0).length,
      realisedRSamples: realisedRs.length,
      realisedRSum: realisedRs.reduce((sum, value) => sum + value, 0),
    };
  }

  private async loadPaperExtensionExhaustionEpisodeState(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<{
    previousEpisodeKey: string | null;
    previousTradeStatus: string | null;
    previousClosedAt: Date | null;
  }> {
    const empty = {
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    };
    if (!this.dataSource) return empty;
    const rows = (await this.dataSource.query(
      `
        SELECT
          ti.metadata->>'paper_extension_exhaustion_episode_key' AS episode_key,
          t.status AS trade_status,
          t.closed_at
        FROM trading.trade_intents ti
        JOIN trading.trades t ON t.trade_intent_id = ti.id
        WHERE ti.user_id = $1
          AND ti.broker_connection_id = $2
          AND ti.instrument = $3
          AND ti.direction = $4
          AND ti.status = 'EXECUTED'
          AND ti.model_version = $5
          AND t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING', 'CLOSED')
        ORDER BY
          CASE WHEN t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING') THEN 0 ELSE 1 END,
          COALESCE(t.closed_at, ti.created_at) DESC
        LIMIT 1
      `,
      [
        userId,
        connectionId,
        instrument.trim().toUpperCase(),
        direction,
        `external-provider/${ACTIVE_ENGINE_CODE}/${PAPER_EXTENSION_EXHAUSTION_RESEARCH_ARTIFACT}`,
      ],
    )) as Array<{
      episode_key: string | null;
      trade_status: string | null;
      closed_at: string | Date | null;
    }>;
    const row = rows[0];
    if (!row) return empty;
    const closedAt = row.closed_at ? new Date(row.closed_at) : null;
    return {
      previousEpisodeKey: row.episode_key ?? null,
      previousTradeStatus: row.trade_status ?? null,
      previousClosedAt: closedAt && Number.isFinite(closedAt.getTime()) ? closedAt : null,
    };
  }

  private async loadPaperPairedReversalEpisodeState(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<{
    previousEpisodeKey: string | null;
    previousTradeStatus: string | null;
    previousClosedAt: Date | null;
  }> {
    const empty = {
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    };
    if (!this.dataSource) return empty;

    const rows = (await this.dataSource.query(
      `
        SELECT
          ti.metadata->>'paired_reversal_episode_key' AS episode_key,
          t.status AS trade_status,
          t.closed_at
        FROM trading.trade_intents ti
        JOIN trading.trades t ON t.trade_intent_id = ti.id
        WHERE ti.user_id = $1
          AND ti.broker_connection_id = $2
          AND ti.instrument = $3
          AND ti.direction = $4
          AND ti.status = 'EXECUTED'
          AND ti.model_version = $5
          AND t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING', 'CLOSED')
        ORDER BY
          CASE
            WHEN t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING') THEN 0
            ELSE 1
          END,
          CASE
            WHEN t.status IN ('PENDING', 'OPEN', 'RECONCILIATION_PENDING') THEN ti.created_at
            ELSE NULL
          END DESC,
          COALESCE(t.closed_at, ti.created_at) DESC
        LIMIT 1
      `,
      [
        userId,
        connectionId,
        instrument.trim().toUpperCase(),
        direction,
        `external-provider/${ACTIVE_ENGINE_CODE}/${PAPER_PAIRED_REVERSAL_RESEARCH_ARTIFACT}`,
      ],
    )) as Array<{
      episode_key: string | null;
      trade_status: string | null;
      closed_at: string | Date | null;
    }>;

    const row = rows[0];
    if (!row) return empty;
    const closedAt = row.closed_at ? new Date(row.closed_at) : null;
    return {
      previousEpisodeKey: row.episode_key ?? null,
      previousTradeStatus: row.trade_status ?? null,
      previousClosedAt: closedAt && Number.isFinite(closedAt.getTime()) ? closedAt : null,
    };
  }

  private async loadPaperSpreadCalibrationHistory(
    instrument: string,
    evaluatedAt: Date,
  ): Promise<PaperSpreadCalibrationHistory> {
    const sourceConnectionId = this.brokerExpertSourceConnectionId();
    if (!this.dataSource || !sourceConnectionId) {
      return { sampleCount: 0, p95SpreadPrice: 0 };
    }

    const session = classifyPaperSpreadSession(evaluatedAt);
    const rows = (await this.dataSource.query(
      `
        SELECT
          COUNT(*)::int AS sample_count,
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY spread_close::double precision
          ) AS p95_spread_price,
          MAX(last_sample_at) AS latest_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND spread_close > 0
          AND last_sample_at > ($3::timestamptz - interval '21 days')
          AND last_sample_at <= $3::timestamptz
          AND CASE
            WHEN EXTRACT(HOUR FROM last_sample_at AT TIME ZONE 'UTC') >= 21 THEN 'ROLLOVER'
            WHEN EXTRACT(HOUR FROM last_sample_at AT TIME ZONE 'UTC') >= 13 THEN 'NEW_YORK'
            WHEN EXTRACT(HOUR FROM last_sample_at AT TIME ZONE 'UTC') >= 7 THEN 'LONDON'
            ELSE 'ASIA'
          END = $4
      `,
      [sourceConnectionId, instrument.trim().toUpperCase(), evaluatedAt.toISOString(), session],
    )) as Array<{
      sample_count: number | string | null;
      p95_spread_price: number | string | null;
      latest_sample_at: string | Date | null;
    }>;

    const row = rows[0];
    const sampleCount = Math.max(0, Number(row?.sample_count ?? 0));
    const p95SpreadPrice = Number(row?.p95_spread_price ?? 0);
    return {
      sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
      p95SpreadPrice: Number.isFinite(p95SpreadPrice) && p95SpreadPrice > 0 ? p95SpreadPrice : 0,
    };
  }

  private async loadExecutionSpreadEvidence(
    instrument: string,
    evaluatedAt: Date,
  ): Promise<ExecutionSpreadEvidence | null> {
    const sourceConnectionId = this.brokerExpertSourceConnectionId();
    if (!this.dataSource || !sourceConnectionId) return null;

    const rows = (await this.dataSource.query(
      `
        WITH positive AS (
          SELECT spread_close, last_sample_at
          FROM market_data.provider_quote_candles
          WHERE connection_id = $1
            AND instrument = $2
            AND timeframe = 'M1'
            AND spread_close > 0
            AND last_sample_at > ($3::timestamptz - interval '30 minutes')
            AND last_sample_at <= $3::timestamptz
        ), latest AS (
          SELECT spread_close
          FROM market_data.provider_quote_candles
          WHERE connection_id = $1
            AND instrument = $2
            AND timeframe = 'M1'
            AND last_sample_at <= $3::timestamptz
          ORDER BY last_sample_at DESC
          LIMIT 1
        )
        SELECT
          COUNT(*)::int AS sample_count,
          GREATEST(
            percentile_cont(0.90) WITHIN GROUP (ORDER BY positive.spread_close::double precision),
            COALESCE((SELECT spread_close::double precision FROM latest), 0)
          ) AS spread_price,
          MAX(positive.last_sample_at) AS latest_sample_at
        FROM positive
      `,
      [sourceConnectionId, instrument.trim().toUpperCase(), evaluatedAt.toISOString()],
    )) as Array<{
      sample_count: number | string | null;
      spread_price: number | string | null;
      latest_sample_at: string | Date | null;
    }>;

    const row = rows[0];
    if (!row) return null;
    const spreadPrice = Number(row.spread_price);
    const sampleCount = Number(row.sample_count);
    const latest = row.latest_sample_at ? new Date(row.latest_sample_at) : null;
    if (
      !Number.isFinite(spreadPrice) ||
      spreadPrice <= 0 ||
      !Number.isFinite(sampleCount) ||
      sampleCount <= 0 ||
      !latest ||
      !Number.isFinite(latest.getTime())
    ) {
      return null;
    }

    return {
      source: 'BROKER_OBSERVED_P90',
      spreadPrice,
      sampleCount,
      percentile: 0.9,
      windowMinutes: EXECUTION_SPREAD_WINDOW_MINUTES,
      latestSampleAt: latest.toISOString(),
    };
  }

  private async loadEnsembleSleeveEvidence(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ) {
    if (!this.dataSource) return null;

    const rows = (await this.dataSource.query(
      `
        SELECT evaluated_at, components->'outcome' AS outcome
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND model_version = $6
          AND instrument = $4
          AND direction = $5
          AND COALESCE(
            (components->'governance'->>'paperExecutionEligible')::boolean,
            false
          ) = true
          AND components ? 'outcome'
          AND components->'outcome'->>'version' = $7
        ORDER BY evaluated_at ASC
      `,
      [
        userId,
        connectionId,
        ACTIVE_ENGINE_CODE,
        instrument,
        direction,
        ACTIVE_MODEL_POLICY_VERSION,
        ENSEMBLE_OUTCOME_MODEL_VERSION,
      ],
    )) as Array<{ evaluated_at: string | Date; outcome: EnsembleShadowOutcome | null }>;

    const episodes = collapseEnsembleOutcomeEpisodes(
      rows
        .filter(
          (row) =>
            row.outcome != null &&
            typeof row.outcome === 'object' &&
            typeof row.outcome.status === 'string',
        )
        .map((row) => ({ evaluatedAt: row.evaluated_at, outcome: row.outcome })),
    );
    return summarizeEnsembleSleeveOutcomes(episodes);
  }

  private async loadPaperPostLossEntryState(
    userId: string,
    connectionId: string,
    instrument: string,
    direction: 'BUY' | 'SELL',
  ): Promise<PaperPostLossEntryState> {
    if (!this.dataSource) return { available: false, lastClosedTrade: null };
    try {
      const rows = (await this.dataSource.query(PAPER_POST_LOSS_STATE_QUERY, [
        userId,
        connectionId,
        instrument,
        direction,
        ACTIVE_ENGINE_CODE,
      ])) as Array<{
        paper_post_loss_state_available: boolean;
        trade_id: string | null;
        close_reason: string | null;
        closed_at: string | Date | null;
        reconfirmed: boolean;
      }>;
      const row = rows[0];
      if (!row) return { available: false, lastClosedTrade: null };
      if (!row.paper_post_loss_state_available) return { available: false, lastClosedTrade: null };
      if (!row.trade_id) return { available: true, lastClosedTrade: null };
      const closedAt = row.closed_at == null ? null : new Date(row.closed_at);
      return {
        available: true,
        lastClosedTrade: {
          id: row.trade_id,
          closeReason: row.close_reason,
          closedAt,
          reconfirmed: Boolean(row.reconfirmed),
        },
      };
    } catch (error) {
      this.logger.warn(
        `PAPER post-loss history unavailable ${instrument} ${direction}: ${(error as Error).message}`,
      );
      return { available: false, lastClosedTrade: null };
    }
  }

  private async persistEnsembleShadowDecision(
    userId: string,
    tradingSessionId: string | null,
    connectionId: string,
    opportunityKey: string,
    candidate: Candidate,
    ensemble: PlanBEnsembleScore,
    portfolioSnapshotAvailable: boolean,
    governance: EnsembleGovernanceDecision,
    macroEventAssessment: MacroEventRiskAssessment,
    highConvictionOverlay: HighConvictionOverlay,
    paperPostLossEntryGuard: PaperPostLossEntryDecision,
    paperSpreadCalibrationShadow: PaperSpreadCalibrationDecision,
  ): Promise<void> {
    if (!this.dataSource) return;

    const extensionExhaustionShadow = scoreExtensionExhaustionShadow({
      regime: ensemble.regime,
      driftState: governance.driftState,
      confidence: candidate.confidence,
      netExpectedR: governance.netExpectedR,
      directionQuality: ensemble.directionQuality,
      tradeQuality: ensemble.tradeQuality,
      exitQuality: ensemble.exitQuality,
      extensionAtr: candidate.extensionAtr,
      executionSpreadEvidenceValid: governance.executionSpreadEvidenceValid,
    });

    const trendPersistenceShadow = scoreTrendPersistenceShadow({
      regime: ensemble.regime,
      driftState: governance.driftState,
      confidence: candidate.confidence,
      grossExpectedR: ensemble.expectedR,
      netExpectedR: governance.netExpectedR,
      directionQuality: ensemble.directionQuality,
      tradeQuality: ensemble.tradeQuality,
      exitQuality: ensemble.exitQuality,
      portfolioQuality: ensemble.portfolioQuality,
      extensionAtr: candidate.extensionAtr,
      shortHorizonMomentumAtr: candidate.shortHorizonMomentumAtr,
      executionSpreadEvidenceValid: governance.executionSpreadEvidenceValid,
    });

    await this.dataSource.query(
      `
        INSERT INTO trading.ensemble_shadow_decisions (
          user_id,
          trading_session_id,
          broker_connection_id,
          engine_code,
          model_version,
          opportunity_key,
          instrument,
          direction,
          market_bar_time,
          evaluated_at,
          confidence,
          entry_price,
          atr,
          regime,
          regime_allowed,
          ensemble_score,
          meta_probability,
          expected_r,
          consensus_passed,
          consensus_required,
          admitted,
          execution_authority,
          reasons,
          components
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb
        )
        ON CONFLICT (user_id, engine_code, opportunity_key) DO NOTHING
      `,
      [
        userId,
        tradingSessionId,
        connectionId,
        ACTIVE_ENGINE_CODE,
        ACTIVE_MODEL_POLICY_VERSION,
        opportunityKey,
        candidate.instrument,
        candidate.direction,
        candidate.barTime,
        new Date(),
        candidate.confidence,
        candidate.entry,
        candidate.atr,
        ensemble.regime,
        ensemble.regimeAllowed,
        ensemble.ensembleScore,
        ensemble.metaProbability,
        ensemble.expectedR,
        ensemble.consensusPassed,
        ensemble.consensusRequired,
        ensemble.admitted,
        MULTI_MODEL_PAPER_EXECUTION_ENABLED && tradingSessionId ? 'PAPER_ONLY' : 'SHADOW_ONLY',
        JSON.stringify(ensemble.reasons),
        JSON.stringify({
          strategyRoute: ensemble.strategyRoute,
          directionQuality: ensemble.directionQuality,
          tradeQuality: ensemble.tradeQuality,
          exitQuality: ensemble.exitQuality,
          pairSideQuality: ensemble.pairSideQuality,
          pairSideRoute: ensemble.pairSideRoute,
          sessionQuality: ensemble.sessionQuality,
          portfolioQuality: ensemble.portfolioQuality,
          portfolioRiskScore: ensemble.portfolioRiskScore,
          openPositionCount: ensemble.openPositionCount,
          sameInstrumentCount: ensemble.sameInstrumentCount,
          sameInstrumentDirectionalLots: ensemble.sameInstrumentDirectionalLots,
          portfolioSnapshotAvailable,
          paperAdmitted: ensemble.paperAdmitted,
          extensionAtr: candidate.extensionAtr,
          volatilityScore: candidate.volatilityScore,
          emaSeparation: candidate.emaSeparation,
          mtfStrength: candidate.mtfStrength,
          rsi14: candidate.rsi14,
          shortHorizonMomentumAtr: candidate.shortHorizonMomentumAtr,
          decisionPolicyVersion: ACTIVE_MODEL_POLICY_VERSION,
          candidateScore: candidate.score,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
          governance,
          paperPostLossEntryGuard,
          paperSpreadCalibrationShadow,
          paperSpreadFallbackAuthority: {
            artifact: 'paper-spread-fallback-authority-v1',
            active:
              Boolean(tradingSessionId) &&
              paperSpreadCalibrationShadow.reason === 'CALIBRATED_P95_WITH_FLOOR',
            executionAuthority: 'PAPER_ONLY',
            modifiesExecution:
              Boolean(tradingSessionId) &&
              paperSpreadCalibrationShadow.reason === 'CALIBRATED_P95_WITH_FLOOR',
            fallbackSpreadPrice: paperSpreadCalibrationShadow.calibratedSpreadPrice,
            standardGovernanceSpreadPrice: Math.max(
              paperSpreadCalibrationShadow.fixedSpreadPrice,
              paperSpreadCalibrationShadow.calibratedSpreadPrice,
            ),
            freshProviderOverrides: true,
            qualificationEvidence: false,
            productionEligible: false,
          },
          macroEventRisk: macroEventAssessment,
          highConvictionOverlay,
          extensionExhaustionShadow,
          trendPersistenceShadow,
        }),
      ],
    );
  }

  private async restorePublishedOpportunities(userId: string, connectionId: string): Promise<void> {
    if (!this.dataSource) return;

    const rows = (await this.dataSource.query(
      `
        SELECT DISTINCT ON (instrument)
          instrument,
          direction,
          entry_price,
          atr,
          confidence,
          market_bar_time,
          evaluated_at,
          admitted,
          ensemble_score,
          meta_probability,
          expected_r,
          consensus_passed,
          consensus_required,
          regime,
          reasons,
          components
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND model_version = $4
        ORDER BY instrument ASC, evaluated_at DESC, id DESC
      `,
      [userId, connectionId, ACTIVE_ENGINE_CODE, ACTIVE_MODEL_POLICY_VERSION],
    )) as Array<{
      instrument: string;
      direction: 'BUY' | 'SELL';
      entry_price: string | number;
      atr: string | number;
      confidence: string | number;
      market_bar_time: string | Date;
      evaluated_at: string | Date;
      admitted: boolean;
      ensemble_score: string | number;
      meta_probability: string | number;
      expected_r: string | number;
      consensus_passed: number;
      consensus_required: number;
      regime: string;
      reasons: string[] | null;
      components: Record<string, unknown> | null;
    }>;

    this.lastPublishedOpportunity.clear();
    let latest: (typeof rows)[number] | null = null;
    for (const row of rows) {
      if (!SYMBOLS.some(([instrument]) => instrument === row.instrument)) continue;
      const entry = Number(row.entry_price);
      const atrValue = Number(row.atr);
      const confidence = Number(row.confidence);
      const barTime = new Date(row.market_bar_time);
      const evaluatedAt = new Date(row.evaluated_at);

      if (
        !Number.isFinite(entry) ||
        !Number.isFinite(atrValue) ||
        atrValue <= 0 ||
        !Number.isFinite(confidence) ||
        !Number.isFinite(barTime.getTime()) ||
        !Number.isFinite(evaluatedAt.getTime()) ||
        (row.direction !== 'BUY' && row.direction !== 'SELL')
      ) {
        continue;
      }

      this.lastPublishedOpportunity.set(row.instrument, {
        direction: row.direction,
        confidence,
        entry,
        atr: atrValue,
        barTimeMs: barTime.getTime(),
      });

      if (!latest || evaluatedAt.getTime() > new Date(latest.evaluated_at).getTime()) {
        latest = row;
      }
    }

    if (latest) {
      this.lastEnsembleDecision = {
        evaluatedAt: new Date(latest.evaluated_at),
        instrument: latest.instrument,
        direction: latest.direction,
        paperAdmitted:
          latest.components &&
          typeof latest.components === 'object' &&
          typeof latest.components.paperAdmitted === 'boolean'
            ? latest.components.paperAdmitted
            : latest.admitted,
        admitted: latest.admitted,
        candidateConfidence: Number(latest.confidence),
        ensembleScore: Number(latest.ensemble_score),
        metaProbability: Number(latest.meta_probability),
        expectedR: Number(latest.expected_r),
        consensusPassed: Number(latest.consensus_passed),
        consensusRequired: Number(latest.consensus_required),
        regime: latest.regime,
        reasons: Array.isArray(latest.reasons) ? latest.reasons : [],
        governance:
          latest.components &&
          typeof latest.components === 'object' &&
          latest.components.governance &&
          typeof latest.components.governance === 'object'
            ? (latest.components.governance as unknown as EnsembleGovernanceDecision)
            : null,
        macroEventAssessment:
          latest.components &&
          typeof latest.components === 'object' &&
          latest.components.macroEventRisk &&
          typeof latest.components.macroEventRisk === 'object'
            ? (latest.components.macroEventRisk as unknown as MacroEventRiskAssessment)
            : null,
        highConvictionOverlay:
          latest.components &&
          typeof latest.components === 'object' &&
          latest.components.highConvictionOverlay &&
          typeof latest.components.highConvictionOverlay === 'object'
            ? (latest.components.highConvictionOverlay as unknown as HighConvictionOverlay)
            : null,
      };
    }

    this.logger.log(
      `Multi-model shadow state restored instruments=${this.lastPublishedOpportunity.size}/6 latest=${this.lastEnsembleDecision.evaluatedAt?.toISOString() ?? 'none'}`,
    );
  }

  private async heartbeatLivePaper(userId: string, connectionId: string): Promise<void> {
    for (const [instrument] of SYMBOLS) {
      await this.brokerService.getCurrentPriceForConnection(userId, connectionId, instrument);
    }
  }

  private async primeMarketData(
    apiKey: string,
    connectionId: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    const seriesByInstrument = await this.fetchSixPairSeries(apiKey, fetchImpl);
    if (this.destroyed) return;
    for (const [instrument, candles] of seriesByInstrument.entries()) {
      this.livePaperMarket.updateClosedCandles(instrument, candles, connectionId);
    }
    this.recordEvaluation(
      [...seriesByInstrument.entries()]
        .map(([instrument, candles]) => buildCandidate(instrument, candles))
        .filter((candidate): candidate is Candidate => candidate !== null),
    );
    const cacheStatus = this.livePaperMarket.status(connectionId);
    if (cacheStatus.cachedInstrumentCount !== SYMBOLS.length) {
      throw new Error(
        `startup live PAPER cache incomplete (${cacheStatus.cachedInstrumentCount}/${SYMBOLS.length})`,
      );
    }
    this.logger.log(
      `VPS startup market cache primed pairs=${cacheStatus.cachedInstrumentCount}/6 ` +
        `latest=${cacheStatus.latestObservedAt?.toISOString() ?? 'unknown'}`,
    );
  }

  private highConvictionUnavailable(reason: string): HighConvictionOverlay {
    return {
      state: 'UNAVAILABLE',
      reason,
      decisionTime: null,
      freshnessSeconds: null,
      allBrokerNative: false,
      direction: null,
      admitted: null,
      ensembleConfidence: null,
      meanOpportunityProbability: null,
      longVotes: null,
      shortVotes: null,
      regime: null,
      modifiesExecution: false,
    };
  }

  private async evaluateHighConvictionOverlay(
    userId: string,
    candidate: Candidate,
  ): Promise<HighConvictionOverlay> {
    if (!this.brokerExpertEnabled()) {
      return this.highConvictionUnavailable('BROKER_EXPERT_DISABLED');
    }
    const sourceConnectionId = this.brokerExpertSourceConnectionId();
    if (!sourceConnectionId) {
      return this.highConvictionUnavailable('BROKER_SOURCE_NOT_CONFIGURED');
    }

    try {
      const source = await this.brokerService.findConnectionById(sourceConnectionId, userId);
      if (!['metatrader4', 'metatrader5'].includes(source.brokerId)) {
        return this.highConvictionUnavailable('BROKER_SOURCE_NOT_METATRADER');
      }
      const response = await this.aiEngineClient.scorePlanBV4ChallengerBroker({
        userId,
        brokerConnectionId: sourceConnectionId,
        instrument: candidate.instrument,
      });
      return classifyHighConvictionOverlay(
        response,
        candidate.direction,
        new Date(candidate.barTime.getTime() + BAR_MS),
      );
    } catch {
      this.logger.warn(
        'High-conviction broker overlay unavailable; base shadow decision remains observational',
      );
      return this.highConvictionUnavailable('BROKER_EXPERT_REQUEST_FAILED');
    }
  }

  private async fetchSixPairSeries(
    apiKey: string,
    fetchImpl: typeof fetch,
  ): Promise<Map<string, LivePaperCandleInput[]>> {
    // Twelve Data Basic has a finite daily credit budget. Prime all six pairs
    // when the cache is absent/stale, then refresh two pairs per closed M5 slot.
    // This preserves a coherent six-pair snapshot while keeping steady-state
    // usage below the Basic daily allowance instead of exhausting it mid-day.
    const requestNow = new Date();
    const requestMinute = requestNow.toISOString().slice(0, 16);
    // Reuse any successful six-pair batch (primary or broker fallback) inside
    // the current minute. In particular, daily-credit cooldown must not bypass
    // this cache and hammer MetaApi with six fresh history calls every scan.
    if (this.lastProviderFetchMinute === requestMinute && this.lastProviderSeries) {
      this.logger.debug(
        `Reusing six-pair market-data batch for minute=${requestMinute} authority=${this.lastMarketDataAuthority}`,
      );
      return this.lastProviderSeries;
    }
    if (this.providerCooldownUntil && this.providerCooldownUntil.getTime() > requestNow.getTime()) {
      return this.fetchBrokerNativeFallbackSeries('TWELVE_DATA_DAILY_CREDIT_COOLDOWN');
    }
    if (
      this.providerCooldownUntil &&
      this.providerCooldownUntil.getTime() <= requestNow.getTime()
    ) {
      this.providerCooldownUntil = null;
      this.providerCooldownReason = null;
    }
    if (this.transientProviderFailureMinute === requestMinute) {
      return this.fetchBrokerNativeFallbackSeries('TWELVE_DATA_TRANSIENT_MINUTE_BACKOFF');
    }

    const now = requestNow.getTime();
    const cacheIsCompleteAndFresh =
      this.lastProviderSeries !== null &&
      SYMBOLS.every(([instrument]) => {
        const cached = this.lastProviderSeries?.get(instrument);
        if (!cached?.length) return false;
        const latestClose = cached[cached.length - 1]!.timestamp.getTime() + BAR_MS;
        return now - latestClose <= 20 * 60_000;
      });
    const pairsPerRefresh = 2;
    const refreshGroupCount = Math.ceil(SYMBOLS.length / pairsPerRefresh);
    const refreshGroup = Math.floor(now / BAR_MS) % refreshGroupCount;
    const requestedSymbols = cacheIsCompleteAndFresh
      ? SYMBOLS.slice(refreshGroup * pairsPerRefresh, (refreshGroup + 1) * pairsPerRefresh)
      : SYMBOLS;

    const lastClosedBoundary = Math.floor(now / BAR_MS) * BAR_MS - 1_000;
    const params = new URLSearchParams({
      symbol: requestedSymbols.map(([, provider]) => provider).join(','),
      interval: '5min',
      outputsize: '1200',
      timezone: 'UTC',
      order: 'asc',
      end_date: new Date(lastClosedBoundary).toISOString().slice(0, 19),
      apikey: apiKey,
    });
    let response: Response;
    let payload: TwelveDataResponse;
    try {
      response = await fetchImpl(`https://api.twelvedata.com/time_series?${params.toString()}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json' },
      });
    } catch {
      return this.transientBrokerFallback('TWELVE_DATA_TRANSPORT_UNAVAILABLE', requestMinute);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Twelve Data HTTP ${response.status}: provider authentication failed`);
    }
    try {
      payload = (await response.json()) as TwelveDataResponse;
    } catch {
      if (!response.ok && response.status !== 429 && response.status < 500) {
        throw new Error(`Twelve Data HTTP ${response.status}: invalid provider response`);
      }
      return this.transientBrokerFallback('TWELVE_DATA_INVALID_JSON', requestMinute);
    }
    if (!response.ok) {
      const root = payload as TwelveDataSeries;
      const message = root?.message ?? 'request failed';
      if (
        response.status === 429 &&
        /run out of API credits for the day|daily (?:API )?credits? (?:limit|quota)|credits? (?:per day|\/day)/i.test(
          message,
        )
      ) {
        const reset = new Date();
        reset.setUTCDate(reset.getUTCDate() + 1);
        reset.setUTCHours(0, 5, 0, 0);
        this.providerCooldownUntil = reset;
        this.providerCooldownReason = 'DAILY_CREDIT_LIMIT';
        this.logger.warn(
          `Twelve Data daily credit limit reached; switching scanner to broker-native MetaTrader fallback until ${reset.toISOString()}`,
        );
        return this.fetchBrokerNativeFallbackSeries('TWELVE_DATA_DAILY_CREDIT_LIMIT');
      }
      if (response.status === 429 || response.status >= 500) {
        return this.transientBrokerFallback(`TWELVE_DATA_HTTP_${response.status}`, requestMinute);
      }
      throw new Error(`Twelve Data HTTP ${response.status}: ${message}`);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return this.transientBrokerFallback('TWELVE_DATA_INCOMPLETE_BATCH', requestMinute);
    }
    const result = cacheIsCompleteAndFresh
      ? new Map(this.lastProviderSeries!)
      : new Map<string, LivePaperCandleInput[]>();
    for (const [instrument, providerSymbol] of requestedSymbols) {
      const series = this.resolveSeries(payload, providerSymbol);
      if (!series || series.status === 'error' || !Array.isArray(series.values)) {
        return this.transientBrokerFallback('TWELVE_DATA_INCOMPLETE_BATCH', requestMinute);
      }
      if (series.values.some((value) => !value || typeof value.datetime !== 'string')) {
        return this.transientBrokerFallback('TWELVE_DATA_INCOMPLETE_BATCH', requestMinute);
      }
      const candles = series.values
        .map((value) => ({
          timestamp: new Date(`${value.datetime.replace(' ', 'T')}Z`),
          open: value.open,
          high: value.high,
          low: value.low,
          close: value.close,
        }))
        .filter((row) => Number.isFinite(row.timestamp.getTime()))
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      if (candles.length < 55) {
        return this.transientBrokerFallback('TWELVE_DATA_INCOMPLETE_BATCH', requestMinute);
      }
      const latestClose = candles[candles.length - 1]!.timestamp.getTime() + BAR_MS;
      if (Date.now() - latestClose > 20 * 60_000) {
        return this.transientBrokerFallback('TWELVE_DATA_STALE_BATCH', requestMinute);
      }
      result.set(instrument, candles);
    }
    this.lastProviderFetchMinute = requestMinute;
    this.lastProviderSeries = result;
    this.lastMarketDataAuthority = 'TWELVE_DATA';
    return result;
  }

  private transientBrokerFallback(
    reason: string,
    requestMinute: string,
  ): Promise<Map<string, LivePaperCandleInput[]>> {
    // Even when the broker is unavailable, a second startup/timer attempt in
    // this minute must not spend another six primary-provider credits.
    this.transientProviderFailureMinute = requestMinute;
    return this.fetchBrokerNativeFallbackSeries(reason);
  }

  private async fetchBrokerNativeFallbackSeries(
    reason: string,
  ): Promise<Map<string, LivePaperCandleInput[]>> {
    const userId = this.userId();
    const sourceConnectionId = this.brokerExpertSourceConnectionId();
    if (!this.brokerExpertEnabled() || !userId || !sourceConnectionId) {
      this.lastMarketDataAuthority = 'NONE';
      throw new Error(
        `Twelve Data unavailable (${reason}) and broker-native fallback is not configured`,
      );
    }

    const source = await this.brokerService.findConnectionById(sourceConnectionId, userId);
    if (!['metatrader4', 'metatrader5'].includes(source.brokerId)) {
      this.lastMarketDataAuthority = 'NONE';
      throw new Error(
        `Twelve Data unavailable (${reason}) and configured fallback is not MetaTrader`,
      );
    }
    if (source.status !== BrokerConnectionStatus.CONNECTED) {
      this.lastMarketDataAuthority = 'NONE';
      throw Object.assign(
        new Error(
          `Twelve Data unavailable (${reason}) and MetaTrader fallback source is ${source.status}`,
        ),
        { code: BROKER_FALLBACK_SOURCE_UNAVAILABLE_CODE },
      );
    }

    const now = Date.now();
    try {
      const rows: Array<readonly [string, LivePaperCandleInput[]]> = [];
      // MetaApi enforces a per-account historical-data concurrency ceiling.
      // Keep two provider slots in reserve for other readers/quote recovery
      // instead of issuing all six symbols at once.
      const historyConcurrency = 3;
      for (let offset = 0; offset < SYMBOLS.length; offset += historyConcurrency) {
        const batch = await Promise.all(
          SYMBOLS.slice(offset, offset + historyConcurrency).map(async ([instrument]) => {
            const raw = await this.brokerService.getOhlcvForConnection(
              userId,
              sourceConnectionId,
              instrument,
              'M5',
              500,
            );
            const candles = raw
              .map((candle) => ({
                timestamp:
                  candle.timestamp instanceof Date
                    ? new Date(candle.timestamp)
                    : new Date(candle.timestamp),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
              }))
              .filter(
                (candle) =>
                  Number.isFinite(candle.timestamp.getTime()) &&
                  candle.timestamp.getTime() + BAR_MS <= now,
              )
              .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

            if (candles.length < 55) {
              throw new Error(
                `MetaTrader fallback returned only ${candles.length} ${instrument} fully closed M5 bars`,
              );
            }
            const latest = candles[candles.length - 1]!;
            const latestClose = latest.timestamp.getTime() + BAR_MS;
            if (now - latestClose > 20 * 60_000) {
              throw new Error(
                `MetaTrader fallback ${instrument} latest fully closed M5 bar is stale`,
              );
            }
            return [instrument, candles] as const;
          }),
        );
        rows.push(...batch);
      }
      const result = new Map<string, LivePaperCandleInput[]>(rows);
      this.lastProviderFetchMinute = new Date(now).toISOString().slice(0, 16);
      this.lastProviderSeries = result;
      this.lastMarketDataAuthority = 'METAAPI_BROKER_FALLBACK';
      this.logger.warn(
        `Broker-native MetaTrader M5 fallback active for 6/6 pairs reason=${reason}; execution authority remains PAPER_ONLY`,
      );
      return result;
    } catch (error) {
      this.lastMarketDataAuthority = 'NONE';
      throw new Error(
        `Twelve Data unavailable (${reason}) and broker-native fallback failed: ${(error as Error).message}`,
      );
    }
  }

  private resolveSeries(payload: TwelveDataResponse, symbol: string): TwelveDataSeries | null {
    const direct = payload as TwelveDataSeries;
    if (Array.isArray(direct.values)) {
      return direct.meta?.symbol === symbol ? direct : null;
    }
    const batch = payload as Record<string, TwelveDataSeries>;
    return batch[symbol] ?? batch[symbol.replace('/', '')] ?? null;
  }

  private enabled(): boolean {
    return this.config.get<boolean>('vpsForexScanner.enabled', false) === true;
  }
  private apiKey(): string {
    return this.config.get<string>('vpsForexScanner.apiKey', '').trim();
  }
  private userId(): string {
    return this.config.get<string>('vpsForexScanner.userId', '').trim();
  }
  private connectionId(): string {
    return this.config.get<string>('vpsForexScanner.brokerConnectionId', '').trim();
  }
  private brokerExpertEnabled(): boolean {
    return this.config.get<boolean>('multimodelBrokerExpert.enabled', false) === true;
  }
  private brokerExpertSourceConnectionId(): string {
    return this.config.get<string>('multimodelBrokerExpert.sourceConnectionId', '').trim();
  }
}
