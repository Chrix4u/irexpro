import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v5 as uuidv5 } from 'uuid';
import { AiSignalService } from './ai-signal.service';
import { BrokerService } from '../broker/broker.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import {
  LivePaperCandleInput,
  LivePaperMarketDataService,
} from '../broker/services/live-paper-market-data.service';
import {
  buildCandidate,
  Candidate,
  isFreshOpportunity,
  PublishedOpportunity,
} from './vps-forex-signal-collector.service';

const PAIRS = Object.freeze(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']);
const PROVIDER_CODE = 'broker-parity-six-pair-v7';
const MODEL_VERSION = 'external-provider/vps-twelvedata-six-pair-v7/broker-parity-paper-v1';
const SIGNAL_NAMESPACE = '1264e54e-b26c-475c-9fc9-1b6493d22518';
const BAR_MS = 5 * 60_000;
type ParityState =
  | 'DISABLED'
  | 'WAITING_FOR_CONFIGURATION'
  | 'WAITING_FOR_FROZEN_ARTIFACT'
  | 'WAITING_FOR_BROKER_DATA'
  | 'READ_ONLY_READY'
  | 'WAITING_FOR_PAPER_SESSION'
  | 'ACTIVE_PAPER';

@Injectable()
export class BrokerParityV7Service implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrokerParityV7Service.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSlot: string | null = null;
  private lastError: string | null = null;
  private lastCollectedAt: Date | null = null;
  private lastCandidate: Candidate | null = null;
  private readonly lastPublishedOpportunity = new Map<string, PublishedOpportunity>();

  constructor(
    private readonly config: ConfigService,
    private readonly brokerService: BrokerService,
    private readonly executionService: ExecutionService,
    private readonly aiSignalService: AiSignalService,
    private readonly paperMarket: LivePaperMarketDataService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('Broker-Parity v7 collector disabled (fail-closed default)');
      return;
    }
    this.logger.log(
      'Broker-Parity v7 collector enabled; broker-native data only, no Twelve fallback',
    );
    this.timer = setInterval(() => void this.maybeCollect(), 15_000);
    this.timer.unref?.();
    setTimeout(() => void this.maybeCollect(), 2_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async getStatus(requestingUserId: string) {
    const userId = this.userId();
    const sourceConnectionId = this.sourceConnectionId();
    const paperConnectionId = this.paperConnectionId();
    const configured = Boolean(userId && sourceConnectionId && paperConnectionId);
    const ownsBinding = Boolean(userId && requestingUserId === userId);
    const digestPresent = /^sha256:[0-9a-f]{64}$/i.test(this.artifactDigest());
    const cache = paperConnectionId
      ? this.paperMarket.status(paperConnectionId)
      : this.paperMarket.status('__unconfigured_broker_parity__');
    let activeTargetSession = false;
    if (ownsBinding && paperConnectionId) {
      const session = await this.executionService.getActiveSession(userId);
      activeTargetSession = Boolean(
        session &&
        session.executionMode === ExecutionMode.PAPER_ONLY &&
        session.brokerConnectionId === paperConnectionId,
      );
    }

    let state: ParityState;
    if (!this.enabled()) state = 'DISABLED';
    else if (!ownsBinding || !configured) state = 'WAITING_FOR_CONFIGURATION';
    else if (cache.cachedInstrumentCount < PAIRS.length) state = 'WAITING_FOR_BROKER_DATA';
    else if (!digestPresent) state = 'WAITING_FOR_FROZEN_ARTIFACT';
    else if (!this.signalExecutionEnabled()) state = 'READ_ONLY_READY';
    else if (!activeTargetSession) state = 'WAITING_FOR_PAPER_SESSION';
    else state = 'ACTIVE_PAPER';

    return {
      providerCode: PROVIDER_CODE,
      modelVersion: MODEL_VERSION,
      enabled: this.enabled(),
      configured: ownsBinding && configured,
      brokerNativeOnly: true,
      twelveDataFallback: false,
      frozenArtifactRequired: true,
      frozenArtifactConfigured: digestPresent,
      signalExecutionEnabled: this.signalExecutionEnabled(),
      activeTargetSession,
      state,
      marketCache: cache,
      lastCollectedAt: this.lastCollectedAt?.toISOString() ?? null,
      lastError: this.lastError,
      lastCandidate: this.lastCandidate
        ? {
            instrument: this.lastCandidate.instrument,
            direction: this.lastCandidate.direction,
            confidence: this.lastCandidate.confidence,
            barTime: this.lastCandidate.barTime.toISOString(),
          }
        : null,
    };
  }
  async maybeCollect(now = new Date()): Promise<void> {
    if (!this.enabled() || this.running) return;
    const day = now.getUTCDay();
    if (day === 0 || day === 6 || now.getUTCHours() >= 21 || now.getUTCMinutes() % 10 !== 0) return;
    const slot = now.toISOString().slice(0, 16);
    if (this.lastSlot === slot) return;
    this.lastSlot = slot;
    await this.collectOnce(now);
  }

  async collectOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const userId = this.userId();
      const sourceConnectionId = this.sourceConnectionId();
      const paperConnectionId = this.paperConnectionId();
      if (!userId || !sourceConnectionId || !paperConnectionId) {
        throw new Error(
          'Broker-Parity user, source broker connection and PAPER connection are required',
        );
      }

      const [source, target] = await Promise.all([
        this.brokerService.findConnectionById(sourceConnectionId, userId),
        this.brokerService.findConnectionById(paperConnectionId, userId),
      ]);
      if (!['metatrader4', 'metatrader5'].includes(source.brokerId)) {
        throw new Error('Broker-Parity source must be a MetaTrader broker-native connection');
      }
      if (target.brokerId !== 'paper-broker') {
        throw new Error('Broker-Parity target must be a dedicated PAPER broker connection');
      }

      const series = new Map<string, LivePaperCandleInput[]>();
      for (const instrument of PAIRS) {
        const raw = await this.brokerService.getOhlcvForConnection(
          userId,
          sourceConnectionId,
          instrument,
          'M5',
          500,
        );
        const closed = raw
          .filter((row) => new Date(row.timestamp).getTime() + BAR_MS <= now.getTime())
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          .slice(-500)
          .map((row) => ({
            timestamp: new Date(row.timestamp),
            open: String(row.open),
            high: String(row.high),
            low: String(row.low),
            close: String(row.close),
          }));
        if (closed.length < 300) {
          throw new Error(
            `Broker-native M5 history insufficient for ${instrument}: ${closed.length}`,
          );
        }
        series.set(instrument, closed);
      }

      for (const [instrument, candles] of series) {
        this.paperMarket.updateClosedCandles(instrument, candles, paperConnectionId);
      }
      this.lastCollectedAt = new Date();
      this.lastError = null;

      const candidates = [...series]
        .map(([instrument, candles]) => buildCandidate(instrument, candles))
        .filter((candidate): candidate is Candidate => candidate !== null)
        .sort((a, b) => b.score - a.score);
      this.lastCandidate = candidates[0] ?? null;

      if (!this.signalExecutionEnabled()) return;
      const digest = this.artifactDigest();
      if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
        throw new Error(
          'Broker-Parity execution requires a formally frozen qualified artifact digest',
        );
      }
      const session = await this.executionService.getActiveSession(userId);
      if (
        !session ||
        session.executionMode !== ExecutionMode.PAPER_ONLY ||
        session.brokerConnectionId !== paperConnectionId
      ) {
        return;
      }

      this.paperMarket.registerLiveConnection(paperConnectionId);
      for (const instrument of PAIRS) {
        await this.brokerService.getCurrentPriceForConnection(
          userId,
          paperConnectionId,
          instrument,
        );
      }

      const currentDirection = new Map(candidates.map((c) => [c.instrument, c.direction] as const));
      for (const [instrument, previous] of this.lastPublishedOpportunity) {
        if (currentDirection.get(instrument) !== previous.direction) {
          this.lastPublishedOpportunity.delete(instrument);
        }
      }
      const best = candidates.find((candidate) =>
        isFreshOpportunity(candidate, this.lastPublishedOpportunity.get(candidate.instrument)),
      );
      if (!best) return;

      const eventId = `${PROVIDER_CODE}|${best.instrument}|${best.barTime.toISOString()}|${best.direction}|${digest}`;
      const signalId = uuidv5(eventId, SIGNAL_NAMESPACE);
      const digits = this.paperMarket.spec(best.instrument).digits;
      await this.aiSignalService.receiveSignal({
        signalId,
        userId,
        tradingSessionId: session.id,
        brokerConnectionId: paperConnectionId,
        instrument: best.instrument,
        direction: best.direction,
        confidenceScore: best.confidence,
        suggestedEntryPrice: Number(best.entry.toFixed(digits)),
        suggestedStopLoss: Number(best.stopLoss.toFixed(digits)),
        suggestedTakeProfit: Number(best.takeProfit.toFixed(digits)),
        suggestedVolume: 0.1,
        timeframe: 'M5',
        strategyCode: 'external-vps-twelvedata-six-pair-v7-broker-parity',
        marketRegime: 'TRENDING',
        volatilityScore: best.volatilityScore,
        generatedAt: new Date(),
        modelVersion: MODEL_VERSION,
        metadata: {
          signal_source: 'EXTERNAL_PROVIDER',
          external_provider_code: PROVIDER_CODE,
          external_provider_paper_only: true,
          production_eligible: false,
          frozen_artifact_digest: digest,
          market_data_authority: 'BROKER_NATIVE_METAAPI',
          market_data_bar_time: best.barTime.toISOString(),
          market_data_execution_model: 'broker-native-metaapi-m5-with-simulated-paper-execution',
          twelve_data_fallback: false,
          source_reference: 'MetaTrader broker-native M5 history through MetaApi bridge',
          feature_extension_atr: best.extensionAtr,
          feature_ema_separation: best.emaSeparation,
          feature_mtf_strength: best.mtfStrength,
          feature_rsi14: best.rsi14,
          feature_volatility_score: best.volatilityScore,
          feature_atr: best.atr,
          feature_candidate_score: best.score,
          opportunity_freshness_policy:
            'new-cycle-or-0.5atr-directional-extension-or-0.02-confidence-expansion',
        },
      });
      this.lastPublishedOpportunity.set(best.instrument, {
        direction: best.direction,
        confidence: best.confidence,
        entry: best.entry,
        atr: best.atr,
        barTimeMs: best.barTime.getTime(),
      });
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`Broker-Parity v7 collection failed closed: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }
  private enabled(): boolean {
    return this.config.get<boolean>('brokerParityV7.enabled', false) === true;
  }
  private signalExecutionEnabled(): boolean {
    return this.config.get<boolean>('brokerParityV7.signalExecutionEnabled', false) === true;
  }
  private userId(): string {
    return this.config.get<string>('brokerParityV7.userId', '').trim();
  }
  private sourceConnectionId(): string {
    return this.config.get<string>('brokerParityV7.sourceConnectionId', '').trim();
  }
  private paperConnectionId(): string {
    return this.config.get<string>('brokerParityV7.paperConnectionId', '').trim();
  }
  private artifactDigest(): string {
    return this.config.get<string>('brokerParityV7.artifactDigest', '').trim();
  }
}
