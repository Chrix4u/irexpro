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
import { scorePlanBShadowMeta, scoreV8ShadowMeta } from './v8-shadow-meta-scorer';
import {
  PlanBEnsembleScore,
  PlanBPortfolioPosition,
  scorePlanBMultimodelShadow,
} from './plan-b-multimodel-shadow';

const LEGACY_PROVIDER_CODE = 'vps-twelvedata-six-pair-v7';
const ACTIVE_ENGINE_CODE = 'irexpro-multimodel-ensemble-v1';
const LEGACY_V7_EXECUTION_FROZEN = true;
const MULTI_MODEL_PAPER_EXECUTION_ENABLED = false;
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
const SCANNER_LOT_UPPER_BOUND = 0.1;
const MIN_STOP_LOSS_PIPS = 5;
const STOP_FLOOR_BUFFER_PIPS = 0.1;
const BAR_MS = 5 * 60_000;
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
  const confidenceExpansion =
    candidate.confidence >= previous.confidence + FRESH_CONFIDENCE_DELTA;

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
  private readonly lastPublishedOpportunity = new Map<string, PublishedOpportunity>();
  private lastEnsembleDecision: {
    evaluatedAt: Date | null;
    instrument: string | null;
    direction: 'BUY' | 'SELL' | null;
    admitted: boolean;
    ensembleScore: number | null;
    consensusPassed: number | null;
    consensusRequired: number | null;
    regime: string | null;
    reasons: string[];
  } = {
    evaluatedAt: null,
    instrument: null,
    direction: null,
    admitted: false,
    ensembleScore: null,
    consensusPassed: null,
    consensusRequired: null,
    regime: null,
    reasons: ['WAITING_FOR_MARKET_SCAN'],
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
          this.logger.log('Multi-model startup live PAPER protection heartbeat completed for 6/6 pairs');
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
        'cadence=10m timeframe=M5 skipUtcHours=21,22,23',
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
    if (ownsBinding) {
      const session = await this.executionService.getActiveSession(requestingUserId);
      activePaperSession = Boolean(
        session &&
        session.executionMode === ExecutionMode.PAPER_ONLY &&
        session.brokerConnectionId === this.connectionId(),
      );
    }
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
      cadenceMinutes: 10,
      timeframe: 'M5',
      skippedUtcHours: [21, 22, 23],
      confidenceFloor: CONFIDENCE_FLOOR,
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
      lastEnsembleDecision: {
        evaluatedAt: this.lastEnsembleDecision.evaluatedAt?.toISOString() ?? null,
        instrument: this.lastEnsembleDecision.instrument,
        direction: this.lastEnsembleDecision.direction,
        admitted: this.lastEnsembleDecision.admitted,
        ensembleScore: this.lastEnsembleDecision.ensembleScore,
        consensusPassed: this.lastEnsembleDecision.consensusPassed,
        consensusRequired: this.lastEnsembleDecision.consensusRequired,
        regime: this.lastEnsembleDecision.regime,
        reasons: this.lastEnsembleDecision.reasons,
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
        highConvictionExpert: 'CHALLENGER_VALIDATION',
        fastMicrostructureSpecialists: 'RESEARCH_VALIDATION',
        newsEventRisk: 'NEXT_IMPLEMENTATION',
        driftSleeveHealth: 'NEXT_IMPLEMENTATION',
        postEntryExitModel: 'NEXT_IMPLEMENTATION',
      },
      providerCooldownReason: this.providerCooldownReason,
      providerCooldownUntil: this.providerCooldownUntil?.toISOString() ?? null,
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
              : !activePaperSession
                ? 'WAITING_FOR_PAPER_SESSION'
                : this.providerCooldownUntil && this.providerCooldownUntil.getTime() > Date.now()
                  ? 'WAITING_FOR_PROVIDER_QUOTA'
                  : this.livePaperMarket.status(this.connectionId()).cachedInstrumentCount < SYMBOLS.length
                    ? 'WAITING_FOR_MARKET_DATA'
                    : MULTI_MODEL_PAPER_EXECUTION_ENABLED
                      ? 'ACTIVE'
                      : 'MULTI_MODEL_SHADOW',
    };
  }

  async maybeCollect(now = new Date()): Promise<void> {
    if (this.providerCooldownUntil && this.providerCooldownUntil.getTime() <= now.getTime()) {
      this.providerCooldownUntil = null;
      this.providerCooldownReason = null;
    }
    if (this.providerCooldownUntil && this.providerCooldownUntil.getTime() > now.getTime()) return;
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

      const session = await this.executionService.getActiveSession(userId);
      if (
        !session ||
        session.executionMode !== ExecutionMode.PAPER_ONLY ||
        session.brokerConnectionId !== connectionId
      ) {
        this.logger.warn(
          'VPS live feed refreshed, but signal publication is blocked until the configured PAPER_ONLY session is active',
        );
        return;
      }

      // Atomic handoff: only after all six series were parsed and cached AND
      // the exact PAPER authority is active do broker reads switch to live mode.
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

      const freshCandidates = candidates
        .filter((candidate) =>
          isFreshOpportunity(candidate, this.lastPublishedOpportunity.get(candidate.instrument)),
        )
        .sort((a, b) => b.score - a.score);
      const best = freshCandidates[0];
      if (!best) {
        this.logger.log(
          candidates.length
            ? 'VPS six-pair scan: qualifying trend persists but no fresh opportunity evidence'
            : 'VPS six-pair scan: no qualifying setup',
        );
        return;
      }

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
      this.lastEnsembleDecision = {
        evaluatedAt: new Date(),
        instrument: best.instrument,
        direction: best.direction,
        admitted: planBEnsemble.admitted,
        ensembleScore: planBEnsemble.ensembleScore,
        consensusPassed: planBEnsemble.consensusPassed,
        consensusRequired: planBEnsemble.consensusRequired,
        regime: planBEnsemble.regime,
        reasons: planBEnsemble.reasons,
      };
      await this.persistEnsembleShadowDecision(
        userId,
        session.id,
        connectionId,
        eventId,
        best,
        planBEnsemble,
        portfolioSnapshotAvailable,
      );
      this.lastPublishedOpportunity.set(best.instrument, {
        direction: best.direction,
        confidence: best.confidence,
        entry: best.entry,
        atr: best.atr,
        barTimeMs: best.barTime.getTime(),
      });
      if (!MULTI_MODEL_PAPER_EXECUTION_ENABLED || !planBEnsemble.admitted) {
        this.logger.log(
          `Multi-model ensemble ${best.instrument} ${best.direction} ` +
            `admitted=${planBEnsemble.admitted} consensus=${planBEnsemble.consensusPassed}/${planBEnsemble.consensusRequired} ` +
            `execution=SHADOW_ONLY legacyV7Frozen=${LEGACY_V7_EXECUTION_FROZEN} ` +
            `reasons=${planBEnsemble.reasons.join(',')}`,
        );
        return;
      }
      const outcome = await this.aiSignalService.receiveSignal({
        signalId,
        userId,
        tradingSessionId: session.id,
        brokerConnectionId: connectionId,
        instrument: best.instrument,
        direction: best.direction,
        confidenceScore: best.confidence,
        suggestedEntryPrice: Number(best.entry.toFixed(digits)),
        suggestedStopLoss: Number(best.stopLoss.toFixed(digits)),
        suggestedTakeProfit: Number(best.takeProfit.toFixed(digits)),
        // This is only an upper bound. PositionSizingService still computes the
        // actual lot from equity, stop distance, risk %, broker min/max/step,
        // available margin, allocation and the user's profile max. v1-v4 used
        // 0.01 here, unintentionally forcing every valid trade to micro-lot size.
        suggestedVolume: SCANNER_LOT_UPPER_BOUND,
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
          source_reference: 'Twelve Data Basic real-time forex M5 closed candles',
          market_data_authority: 'PAPER_RESEARCH_EXTERNAL_TWELVE_DATA',
          live_market_data_policy:
            'DEMO/LIVE decisions must use broker-native market data via the active broker adapter; MetaTrader uses MetaApi as the broker-access bridge',
          market_data_bar_time: best.barTime.toISOString(),
          market_data_execution_model: 'closed-candle-mid-with-conservative-fixed-paper-spread',
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
          plan_b_ensemble_portfolio_risk_score: planBEnsemble.portfolioRiskScore,
          plan_b_ensemble_open_position_count: planBEnsemble.openPositionCount,
          plan_b_ensemble_same_instrument_count: planBEnsemble.sameInstrumentCount,
          plan_b_ensemble_meta_probability: planBEnsemble.metaProbability,
          plan_b_ensemble_score: planBEnsemble.ensembleScore,
          plan_b_ensemble_admitted: planBEnsemble.admitted,
          plan_b_ensemble_reasons: planBEnsemble.reasons,
          position_sizing_policy: 'risk-managed-up-to-0.10-lot-scanner-bound',
          opportunity_freshness_policy:
            'new-cycle-or-0.5atr-directional-extension-or-0.02-confidence-expansion',
        },
      });
      this.logger.log(
        `Multi-model PAPER candidate ${best.instrument} ${best.direction} confidence=${best.confidence.toFixed(4)} ` +
          `outcome=${outcome.outcome} signal=${signalId} freshness=new-evidence`,
      );
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
    const paused = day === 0 || day === 6 || hour >= 21;
    const reason = day === 0 || day === 6
      ? 'WEEKEND'
      : hour >= 21
        ? 'ROLLOVER_LOW_LIQUIDITY'
        : null;
    return {
      paused,
      reason,
      nextEligibleScanAt: this.nextEligibleScanAt(now).toISOString(),
    };
  }

  private nextEligibleScanAt(now: Date): Date {
    const candidate = new Date(now);
    candidate.setUTCSeconds(0, 0);
    const remainder = candidate.getUTCMinutes() % 10;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + (remainder === 0 ? 10 : 10 - remainder));
    for (let i = 0; i < 7 * 24 * 6 + 12; i += 1) {
      const day = candidate.getUTCDay();
      const hour = candidate.getUTCHours();
      if (day !== 0 && day !== 6 && hour < 21) return candidate;
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 10);
    }
    return candidate;
  }

  private isCollectionSlot(now: Date): boolean {
    if (this.marketSchedule(now).paused) return false;
    return now.getUTCMinutes() % 10 === 0;
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

  private async persistEnsembleShadowDecision(
    userId: string,
    tradingSessionId: string,
    connectionId: string,
    opportunityKey: string,
    candidate: Candidate,
    ensemble: PlanBEnsembleScore,
    portfolioSnapshotAvailable: boolean,
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
        this.lastEnsembleDecision.evaluatedAt ?? new Date(),
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
        MULTI_MODEL_PAPER_EXECUTION_ENABLED ? 'PAPER_ONLY' : 'SHADOW_ONLY',
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
          portfolioSnapshotAvailable,
          extensionAtr: candidate.extensionAtr,
          volatilityScore: candidate.volatilityScore,
          emaSeparation: candidate.emaSeparation,
          mtfStrength: candidate.mtfStrength,
          rsi14: candidate.rsi14,
          candidateScore: candidate.score,
        }),
      ],
    );
  }

  private async restorePublishedOpportunities(
    userId: string,
    connectionId: string,
  ): Promise<void> {
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
          consensus_passed,
          consensus_required,
          regime,
          reasons
        FROM trading.ensemble_shadow_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND engine_code = $3
        ORDER BY instrument ASC, evaluated_at DESC, id DESC
      `,
      [userId, connectionId, ACTIVE_ENGINE_CODE],
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
      consensus_passed: number;
      consensus_required: number;
      regime: string;
      reasons: string[] | null;
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
        admitted: latest.admitted,
        ensembleScore: Number(latest.ensemble_score),
        consensusPassed: Number(latest.consensus_passed),
        consensusRequired: Number(latest.consensus_required),
        regime: latest.regime,
        reasons: Array.isArray(latest.reasons) ? latest.reasons : [],
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

  private async fetchSixPairSeries(
    apiKey: string,
    fetchImpl: typeof fetch,
  ): Promise<Map<string, LivePaperCandleInput[]>> {
    // Twelve Data Basic permits 8 credits/minute while this six-symbol batch
    // costs 6. Reuse one successful batch inside the same API-process minute
    // so a startup prime + collection slot cannot accidentally spend 12.
    const requestNow = new Date();
    if (
      this.providerCooldownUntil &&
      this.providerCooldownUntil.getTime() > requestNow.getTime()
    ) {
      throw new Error(
        `Twelve Data daily credit cooldown active until ${this.providerCooldownUntil.toISOString()}`,
      );
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
        throw new Error(
          `Twelve Data daily credit limit reached; scanner paused until ${reset.toISOString()}`,
        );
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
    return result;
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
}
