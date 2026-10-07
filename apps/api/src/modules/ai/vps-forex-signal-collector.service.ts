import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { v5 as uuidv5 } from 'uuid';
import { AiSignalService } from './ai-signal.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { BrokerService } from '../broker/broker.service';
import { AiEngineClient } from '../ai-engine-client/ai-engine-client.service';
import {
  LivePaperCandleInput,
  LivePaperMarketDataService,
} from '../broker/services/live-paper-market-data.service';
import {
  PLAN_B_SHADOW_ADMISSION_THRESHOLD,
  scorePlanBShadowMeta,
  scoreV8ShadowMeta,
} from './v8-shadow-meta-scorer';
import {
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
  EnsembleGovernanceDecision,
  ExecutionSpreadEvidence,
  classifyEnsembleSleeveEvidence,
  evaluateEnsembleGovernance,
} from './ensemble-governance';
import { MacroEventRiskAssessment, MacroEventRiskService } from './macro-event-risk.service';
import {
  EnsembleShadowOutcome,
  resolveEnsembleShadowOutcome,
  summarizeEnsembleSleeveOutcomes,
} from './ensemble-shadow-outcome';
import { buildEnsembleExpertRegistry } from './ensemble-expert-registry';
import { EnsemblePostEntryProtectionShadowService } from './ensemble-post-entry-protection-shadow.service';
import {
  HighConvictionOverlay,
  HighConvictionOverlayState,
  classifyHighConvictionOverlay,
  summarizeHighConvictionOverlayCohort,
} from './high-conviction-overlay';

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
const STOP_ATR_MULTIPLIER = 1.5;
const TARGET_ATR_MULTIPLIER = 2.5;
const PAPER_BASE_LOT_UPPER_BOUND = 0.1;

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
    return { upperBound: 0.5, tier: 'EXCEPTIONAL' };
  }
  if (
    fullConsensus &&
    input.confidence >= 0.76 &&
    input.metaProbability >= 0.62 &&
    input.netExpectedR >= 0.28 &&
    input.volatilityScore <= 0.65
  ) {
    return { upperBound: 0.3, tier: 'VERY_STRONG' };
  }
  if (
    fullConsensus &&
    input.confidence >= 0.7 &&
    input.metaProbability >= 0.56 &&
    input.netExpectedR >= 0.18 &&
    input.volatilityScore <= 0.75
  ) {
    return { upperBound: 0.2, tier: 'STRONG' };
  }
  return { upperBound: PAPER_BASE_LOT_UPPER_BOUND, tier: 'BASE' };
}
const MIN_STOP_LOSS_PIPS = 5;
const STOP_FLOOR_BUFFER_PIPS = 0.1;
const BAR_MS = 5 * 60_000;
const COLLECTION_CADENCE_MINUTES = 5;
const EXECUTION_SPREAD_WINDOW_MINUTES = 30;
const FRESH_BREAKOUT_ATR = 0.5;
const FRESH_CONFIDENCE_DELTA = 0.02;
const MAX_CONFIDENCE_DECAY_ON_BREAKOUT = 0.015;

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
  rsi14: number;
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

export function buildCandidate(
  instrument: string,
  candles: LivePaperCandleInput[],
): Candidate | null {
  if (candles.length < 55) return null;
  const closes = candles.map((c) => Number(c.close));
  if (closes.some((x) => !Number.isFinite(x) || x <= 0)) return null;
  const px = closes[closes.length - 1]!;
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const m15 = aggregateCandles(candles, 15);
  const h1 = aggregateCandles(candles, 60);
  if (m15.length < 30 || h1.length < 24) return null;
  const m15Closes = m15.map((c) => Number(c.close));
  const h1Closes = h1.map((c) => Number(c.close));
  const m15Ema9 = ema(m15Closes, 9);
  const m15Ema21 = ema(m15Closes, 21);
  const h1Ema21 = ema(h1Closes, 21);
  if (![ema9, ema21, ema50, rsi14, atr14].every(Number.isFinite) || atr14 <= 0) return null;

  const longTrend = ema9 > ema21 && ema21 > ema50;
  const shortTrend = ema9 < ema21 && ema21 < ema50;
  const longMtf = m15Ema9 > m15Ema21 && px > h1Ema21;
  const shortMtf = m15Ema9 < m15Ema21 && px < h1Ema21;
  const longSetup = longTrend && longMtf && rsi14 >= 55 && rsi14 <= 72;
  const shortSetup = shortTrend && shortMtf && rsi14 <= 45 && rsi14 >= 28;
  if (!longSetup && !shortSetup) return null;
  const direction: 'BUY' | 'SELL' = longSetup ? 'BUY' : 'SELL';

  // Avoid entering after price has already stretched too far from the M5
  // mean. Persistent trends can still be traded, but late chasing tends to
  // compress remaining upside/downside while leaving the full stop exposed.
  const extensionAtr = Math.abs(px - ema21) / atr14;
  if (!Number.isFinite(extensionAtr) || extensionAtr > 1.5) return null;

  const relativeAtr = atr14 / px;
  const volatilityScore = Math.max(0, Math.min(1, relativeAtr / 0.0015));
  // Keep the collector out of genuinely high-volatility regimes. The Risk
  // Engine still has its own independent volatility ceiling afterwards.
  if (volatilityScore >= 0.75) return null;

  const emaSeparation = Math.max(0, Math.min(1, Math.abs(ema9 - ema21) / atr14 / 2));
  const rsiStrength =
    direction === 'BUY'
      ? Math.max(0, Math.min(1, (rsi14 - 50) / 22))
      : Math.max(0, Math.min(1, (50 - rsi14) / 22));
  const confidence = Math.max(0.6, Math.min(0.8, 0.6 + 0.12 * emaSeparation + 0.08 * rsiStrength));
  if (confidence < CONFIDENCE_FLOOR) return null;
  const mtfStrength =
    direction === 'BUY'
      ? Math.min(1, Math.max(0, (m15Ema9 - m15Ema21) / atr14))
      : Math.min(1, Math.max(0, (m15Ema21 - m15Ema9) / atr14));
  const score =
    confidence +
    0.05 * emaSeparation +
    0.03 * mtfStrength -
    0.02 * volatilityScore -
    0.02 * Math.min(1.5, extensionAtr);
  const barTime = new Date(candles[candles.length - 1]!.timestamp);
  const pipSize = instrument.endsWith('JPY') ? 0.01 : 0.0001;
  // Candidate geometry should satisfy the platform's structural 5-pip minimum
  // before the independent Risk Engine evaluates it. This does NOT weaken or
  // bypass Risk; it prevents a low-ATR setup from being malformed by design.
  const stopDistance = Math.max(
    atr14 * STOP_ATR_MULTIPLIER,
    (MIN_STOP_LOSS_PIPS + STOP_FLOOR_BUFFER_PIPS) * pipSize,
  );
  const targetDistance = stopDistance * (TARGET_ATR_MULTIPLIER / STOP_ATR_MULTIPLIER);

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
    rsi14,
  };
}

@Injectable()
export class VpsForexSignalCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VpsForexSignalCollectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSlot: string | null = null;
  private lastProviderFetchMinute: string | null = null;
  private lastProviderSeries: Map<string, LivePaperCandleInput[]> | null = null;
  private providerCooldownUntil: Date | null = null;
  private providerCooldownReason: 'DAILY_CREDIT_LIMIT' | null = null;
  private lastMarketDataAuthority: 'NONE' | 'TWELVE_DATA' | 'METAAPI_BROKER_FALLBACK' = 'NONE';
  private readonly lastPublishedOpportunity = new Map<string, PublishedOpportunity>();
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
  ) {}

  async onModuleInit(): Promise<void> {
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
        await this.primeMarketData(apiKey, connectionId);
        const activeAfterPrime = await this.executionService.getActiveSession(userId);
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
      }
    } catch (error) {
      // Keep live ownership registered so restored live positions fail closed
      // rather than being valued against a mismatched simulator feed. The
      // periodic scanner can recover on a later successful provider request.
      this.logger.error(
        `VPS startup market prime/heartbeat failed; live PAPER remains fail-closed: ${(error as Error).message}`,
      );
    }

    this.logger.log(
      `iRexPro multi-model engine enabled engine=${ACTIVE_ENGINE_CODE} legacyProvider=${LEGACY_PROVIDER_CODE} ` +
        `legacyExecutionFrozen=${LEGACY_V7_EXECUTION_FROZEN} paperExecution=${MULTI_MODEL_PAPER_EXECUTION_ENABLED} ` +
        `cadence=${COLLECTION_CADENCE_MINUTES}m timeframe=M5 marketHours=FX_24X5_SUN21_FRI21_UTC`,
    );
    this.timer = setInterval(() => void this.maybeCollect(), 15_000);
    this.timer.unref?.();
    setTimeout(() => void this.maybeCollect(), 2_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      ensembleCampaign = await this.loadEnsembleCampaignStatus(
        requestingUserId,
        configuredConnectionId,
      );
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
    if (this.providerCooldownUntil && this.providerCooldownUntil.getTime() <= now.getTime()) {
      this.providerCooldownUntil = null;
      this.providerCooldownReason = null;
    }
    if (!this.enabled() || this.running || !this.isCollectionSlot(now)) return;
    const slot = now.toISOString().slice(0, 16);
    if (this.lastSlot === slot) return;
    this.lastSlot = slot;
    await this.collectOnce().catch((error) => {
      this.logger.warn(`VPS forex scan failed: ${(error as Error).message}`);
    });
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

      const candidates = [...seriesByInstrument.entries()]
        .map(([instrument, candles]) => buildCandidate(instrument, candles))
        .filter((candidate): candidate is Candidate => candidate !== null);
      this.recordEvaluation(candidates);

      const currentDirectionByInstrument = new Map(
        candidates.map((candidate) => [candidate.instrument, candidate.direction] as const),
      );
      for (const [instrument, previous] of this.lastPublishedOpportunity.entries()) {
        if (currentDirectionByInstrument.get(instrument) !== previous.direction) {
          this.lastPublishedOpportunity.delete(instrument);
        }
      }

      // Every qualifying closed-bar candidate is independently evaluated. The
      // scanner already runs once per 10-minute slot and the deterministic
      // signal id includes the market bar time, so an additional same-direction
      // freshness throttle can hide valid repeat opportunities without adding
      // idempotency. Downstream ensemble, governance, risk, margin and portfolio
      // controls remain authoritative for every candidate.
      const rankedCandidates = candidates.sort((a, b) => b.score - a.score);
      if (rankedCandidates.length === 0) {
        this.logger.log('VPS six-pair scan: no qualifying setup');
        return;
      }

      let representativeSet = false;
      let representativeIsPaperEligible = false;
      for (const best of rankedCandidates) {
        const eventId = `${ACTIVE_ENGINE_CODE}|${best.instrument}|${best.barTime.toISOString()}|${best.direction}`;
        const signalId = uuidv5(eventId, SIGNAL_NAMESPACE);
        const digits = this.livePaperMarket.spec(best.instrument).digits;
        const v8Shadow = scoreV8ShadowMeta({
          instrument: best.instrument,
          direction: best.direction,
          confidence: best.confidence,
          extensionAtr: best.extensionAtr,
          volatilityScore: best.volatilityScore,
          emaSeparation: best.emaSeparation,
          mtfStrength: best.mtfStrength,
          rsi14: best.rsi14,
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
        const executionSpreadEvidence = await this.loadExecutionSpreadEvidence(
          best.instrument,
          evaluatedAt,
        );
        const ensembleGovernance = evaluateEnsembleGovernance({
          ensemble: planBEnsemble,
          instrument: best.instrument,
          entryPrice: best.entry,
          stopLoss: best.stopLoss,
          takeProfit: best.takeProfit,
          confidence: best.confidence,
          extensionAtr: best.extensionAtr,
          volatilityScore: best.volatilityScore,
          emaSeparation: best.emaSeparation,
          mtfStrength: best.mtfStrength,
          rsi14: best.rsi14,
          eventRisk: macroEventAssessment.state,
          sleeveEvidence,
          evaluatedAt,
          executionSpreadEvidence,
        });
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
        );
        this.lastPublishedOpportunity.set(best.instrument, {
          direction: best.direction,
          confidence: best.confidence,
          entry: best.entry,
          atr: best.atr,
          barTimeMs: best.barTime.getTime(),
        });
        if (!canExecuteMultiModelPaper(planBEnsemble, ensembleGovernance)) {
          this.logger.log(
            `Multi-model ensemble ${best.instrument} ${best.direction} ` +
              `paperAdmitted=${planBEnsemble.paperAdmitted} admitted=${planBEnsemble.admitted} ` +
              `consensusPassed=${planBEnsemble.consensusPassed} consensusRequired=${planBEnsemble.consensusRequired} ` +
              `execution=SHADOW_ONLY legacyV7Frozen=${LEGACY_V7_EXECUTION_FROZEN} ` +
              `netExpectedR=${ensembleGovernance.netExpectedR.toFixed(4)} ` +
              `costSource=${ensembleGovernance.executionCostSource} ` +
              `drift=${ensembleGovernance.driftState} sleeve=${ensembleGovernance.sleeveState} ` +
              `highConviction=${highConvictionOverlay.state} ` +
              `paperGovernance=${ensembleGovernance.paperExecutionBlockers.join(',') || 'PASS'} ` +
              `promotionGovernance=${ensembleGovernance.blockers.join(',') || 'PASS'} ` +
              `reasons=${planBEnsemble.reasons.join(',')}`,
          );
          continue;
        }
        if (!paperSession) {
          this.logger.warn(
            'Multi-model candidate passed model governance but PAPER execution authority is unavailable; retaining shadow-only decision',
          );
          continue;
        }

        const dynamicLotSizing = dynamicPaperLotUpperBound({
          confidence: best.confidence,
          metaProbability: planBEnsemble.metaProbability,
          netExpectedR: ensembleGovernance.netExpectedR,
          consensusPassed: planBEnsemble.consensusPassed,
          consensusRequired: planBEnsemble.consensusRequired,
          volatilityScore: best.volatilityScore,
        });

        const outcome = await this.aiSignalService.receiveSignal({
          signalId,
          userId,
          tradingSessionId: paperSession.id,
          brokerConnectionId: connectionId,
          instrument: best.instrument,
          direction: best.direction,
          confidenceScore: best.confidence,
          suggestedEntryPrice: Number(best.entry.toFixed(digits)),
          suggestedStopLoss: Number(best.stopLoss.toFixed(digits)),
          suggestedTakeProfit: Number(best.takeProfit.toFixed(digits)),
          // PAPER-only dynamic upper bound. PositionSizingService still computes
          // the actual lot from equity, stop distance, risk %, broker min/max/step,
          // available margin, allocation and the user's profile max. Stronger size
          // therefore cannot bypass the authoritative risk engine.
          suggestedVolume: dynamicLotSizing.upperBound,
          timeframe: 'M5',
          strategyCode: `external-${ACTIVE_ENGINE_CODE}`,
          marketRegime: 'TRENDING',
          volatilityScore: best.volatilityScore,
          generatedAt: new Date(),
          modelVersion: `external-provider/${ACTIVE_ENGINE_CODE}/paper-only-v1`,
          metadata: {
            signal_source: 'EXTERNAL_PROVIDER',
            external_provider_code: ACTIVE_ENGINE_CODE,
            legacy_baseline_provider_code: LEGACY_PROVIDER_CODE,
            legacy_v7_execution_frozen: LEGACY_V7_EXECUTION_FROZEN,
            multi_model_execution_authority: MULTI_MODEL_PAPER_EXECUTION_ENABLED,
            external_provider_paper_only: true,
            production_eligible: false,
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
            plan_b_ensemble_mode: planBEnsemble.mode,
            plan_b_ensemble_modifies_execution: false,
            plan_b_ensemble_regime: planBEnsemble.regime,
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
            position_sizing_policy: 'risk-managed-dynamic-paper-cap-v1',
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
            `lotTier=${dynamicLotSizing.tier} lotCap=${dynamicLotSizing.upperBound.toFixed(2)} ` +
            `outcome=${outcome.outcome} signal=${signalId} cadence=independent-closed-bar`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private marketSchedule(now: Date): {
    paused: boolean;
    reason: 'WEEKEND' | 'ROLLOVER_LOW_LIQUIDITY' | null;
    nextEligibleScanAt: string;
  } {
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    // FX session: Sunday >=21:00 UTC, Monday-Thursday 24h, Friday <21:00 UTC.
    // Do not impose a blanket nightly shutdown; spread, regime and governance
    // gates decide whether low-liquidity rollover conditions are tradable.
    const marketOpen =
      (day === 0 && hour >= 21) || (day >= 1 && day <= 4) || (day === 5 && hour < 21);
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
      const day = candidate.getUTCDay();
      const hour = candidate.getUTCHours();
      const marketOpen =
        (day === 0 && hour >= 21) || (day >= 1 && day <= 4) || (day === 5 && hour < 21);
      if (marketOpen) return candidate;
      candidate.setUTCMinutes(candidate.getUTCMinutes() + COLLECTION_CADENCE_MINUTES);
    }
    return candidate;
  }

  private isCollectionSlot(now: Date): boolean {
    if (this.marketSchedule(now).paused) return false;
    return now.getUTCMinutes() % COLLECTION_CADENCE_MINUTES === 0;
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
      [userId, connectionId, ACTIVE_ENGINE_CODE, PLAN_B_ENSEMBLE_ARTIFACT],
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

    const rows = (await this.dataSource.query(
      `
        SELECT
          id,
          instrument,
          direction,
          market_bar_time,
          entry_price,
          components
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
          AND (
            admitted = true
            OR COALESCE(
              (components->'governance'->>'paperExecutionEligible')::boolean,
              false
            ) = true
            OR (
              COALESCE(
                (components->'highConvictionOverlay'->>'allBrokerNative')::boolean,
                false
              ) = true
              AND components->'highConvictionOverlay'->>'state' IN (
                'CONFIRM',
                'CONFLICT',
                'ABSTAIN'
              )
            )
          )
          AND NOT (components ? 'outcome')
        ORDER BY evaluated_at ASC
        LIMIT 500
      `,
      [userId, connectionId, ACTIVE_ENGINE_CODE],
    )) as Array<{
      id: string;
      instrument: string;
      direction: 'BUY' | 'SELL';
      market_bar_time: string | Date;
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
          entryPrice: Number(row.entry_price),
          stopLoss,
          takeProfit,
          estimatedExecutionCostR,
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

  private async loadExecutionSpreadEvidence(
    instrument: string,
    evaluatedAt: Date,
  ): Promise<ExecutionSpreadEvidence | null> {
    const sourceConnectionId = this.brokerExpertSourceConnectionId();
    if (!this.dataSource || !sourceConnectionId) return null;

    const rows = (await this.dataSource.query(
      `
        SELECT
          COUNT(*)::int AS sample_count,
          percentile_cont(0.90) WITHIN GROUP (
            ORDER BY spread_close::double precision
          ) AS spread_price,
          MAX(last_sample_at) AS latest_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND spread_close > 0
          AND last_sample_at > ($3::timestamptz - interval '30 minutes')
          AND last_sample_at <= $3::timestamptz
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
        SELECT components->'outcome' AS outcome
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
        ORDER BY evaluated_at ASC
      `,
      [userId, connectionId, ACTIVE_ENGINE_CODE, instrument, direction, PLAN_B_ENSEMBLE_ARTIFACT],
    )) as Array<{ outcome: EnsembleShadowOutcome | null }>;

    const outcomes = rows
      .map((row) => row.outcome)
      .filter(
        (outcome): outcome is EnsembleShadowOutcome =>
          outcome != null && typeof outcome === 'object' && typeof outcome.status === 'string',
      );
    return summarizeEnsembleSleeveOutcomes(outcomes);
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
  ): Promise<void> {
    if (!this.dataSource) return;

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
        ensemble.artifact,
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
          candidateScore: candidate.score,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
          governance,
          macroEventRisk: macroEventAssessment,
          highConvictionOverlay,
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
      [userId, connectionId, ACTIVE_ENGINE_CODE, PLAN_B_ENSEMBLE_ARTIFACT],
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
    // Twelve Data Basic permits 8 credits/minute while this six-symbol batch
    // costs 6. Reuse one successful batch inside the same API-process minute
    // so a startup prime + collection slot cannot accidentally spend 12.
    const requestNow = new Date();
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
    const requestMinute = requestNow.toISOString().slice(0, 16);
    if (this.lastProviderFetchMinute === requestMinute && this.lastProviderSeries) {
      this.logger.debug(`Reusing Twelve Data six-pair batch for minute=${requestMinute}`);
      return this.lastProviderSeries;
    }

    const now = Date.now();
    const lastClosedBoundary = Math.floor(now / BAR_MS) * BAR_MS - 1_000;
    const params = new URLSearchParams({
      symbol: SYMBOLS.map(([, provider]) => provider).join(','),
      interval: '5min',
      outputsize: '500',
      timezone: 'UTC',
      order: 'asc',
      end_date: new Date(lastClosedBoundary).toISOString().slice(0, 19),
      apikey: apiKey,
    });
    const response = await fetchImpl(
      `https://api.twelvedata.com/time_series?${params.toString()}`,
      {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json' },
      },
    );
    const payload = (await response.json()) as TwelveDataResponse;
    if (!response.ok) {
      const root = payload as TwelveDataSeries;
      const message = root.message ?? 'request failed';
      if (
        response.status === 429 &&
        /run out of API credits for the day|current limit being/i.test(message)
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
      throw new Error(`Twelve Data HTTP ${response.status}: ${message}`);
    }

    const result = new Map<string, LivePaperCandleInput[]>();
    for (const [instrument, providerSymbol] of SYMBOLS) {
      const series = this.resolveSeries(payload, providerSymbol);
      if (!series || series.status === 'error' || !Array.isArray(series.values)) {
        throw new Error(
          `Twelve Data missing ${providerSymbol}: ${series?.message ?? 'no time series returned'}`,
        );
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
      if (candles.length < 55)
        throw new Error(`Twelve Data returned only ${candles.length} ${providerSymbol} bars`);
      const latestClose = candles[candles.length - 1]!.timestamp.getTime() + BAR_MS;
      if (Date.now() - latestClose > 20 * 60_000) {
        throw new Error(`${providerSymbol} latest fully closed M5 bar is stale`);
      }
      result.set(instrument, candles);
    }
    this.lastProviderFetchMinute = requestMinute;
    this.lastProviderSeries = result;
    this.lastMarketDataAuthority = 'TWELVE_DATA';
    return result;
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

    const now = Date.now();
    try {
      const rows = await Promise.all(
        SYMBOLS.map(async ([instrument]) => {
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
