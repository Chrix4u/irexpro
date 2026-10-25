import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OHLCV } from '../broker/interfaces/broker-adapter.interface';
import { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';
import {
  ProviderQuoteCandleStoreService,
  type ProviderQuoteCandle,
} from '../market-data/services/provider-quote-candle-store.service';
import {
  ENSEMBLE_EXECUTION_SPREAD_MAX_AGE_MS,
  ENSEMBLE_EXECUTION_SPREAD_MIN_SAMPLES,
  type ExecutionSpreadEvidence,
} from './ensemble-governance';
import { buildM1TacticalFeatures, type M1TacticalFeatureInput } from './m1-tactical-features';

const M1_HISTORY_COUNT = 60;
const CONTEXT_HISTORY_COUNT = 30;
const M1_CLOSE_MAX_AGE_MS = 90_000;

export type M1TacticalMarketDataAuthority = 'BROKER_NATIVE' | 'PAPER_PROVIDER_SIMULATION';

export type M1TacticalMarketReadinessReason =
  | 'READY'
  | 'INVALID_INPUT'
  | 'BROKER_M1_SOURCE_UNAVAILABLE'
  | 'BROKER_M1_STALE'
  | 'BROKER_SPREAD_UNAVAILABLE'
  | 'BROKER_SPREAD_UNUSABLE'
  | 'BROKER_FEATURE_CONTEXT_UNAVAILABLE'
  | 'PAPER_CACHE_UNAVAILABLE'
  | 'PAPER_M1_STALE'
  | 'PAPER_SPREAD_UNAVAILABLE'
  | 'PAPER_FEATURE_CONTEXT_UNAVAILABLE';

export interface M1TacticalMarketReadiness {
  ready: boolean;
  reason: M1TacticalMarketReadinessReason;
  authority: M1TacticalMarketDataAuthority | null;
  observedAt: string;
}

export interface M1TacticalMarketSnapshot extends M1TacticalFeatureInput {
  connectionId: string;
  candleSource: string;
  spreadEvidence: ExecutionSpreadEvidence | null;
  paperSimulationSpreadPrice?: number;
  marketDataAuthority: M1TacticalMarketDataAuthority;
}

function latestCloseAgeMs(rows: OHLCV[], minutes: number, decisionTime: Date): number | null {
  const latest = rows.at(-1);
  if (!latest) return null;
  const openedAt = new Date(latest.timestamp).getTime();
  const decisionMs = decisionTime.getTime();
  if (!Number.isFinite(openedAt) || !Number.isFinite(decisionMs)) return null;
  return decisionMs - (openedAt + minutes * 60_000);
}

function singleM1Source(rows: OHLCV[]): string | null {
  if (rows.length === 0) return null;
  const sources = new Set(
    rows.map((row) => String((row as ProviderQuoteCandle).source ?? '').trim()).filter(Boolean),
  );
  return sources.size === 1 ? [...sources][0]! : null;
}

@Injectable()
export class M1TacticalMarketDataService {
  private readonly readiness = new Map<string, M1TacticalMarketReadiness>();

  constructor(
    private readonly store: ProviderQuoteCandleStoreService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly paperMarket?: LivePaperMarketDataService,
  ) {}

  getLastReadiness(connectionId: string, instrument: string): M1TacticalMarketReadiness | null {
    return this.readiness.get(this.readinessKey(connectionId, instrument)) ?? null;
  }

  private setReadiness(
    connectionId: string,
    instrument: string,
    reason: M1TacticalMarketReadinessReason,
    authority: M1TacticalMarketDataAuthority | null,
    observedAt: Date,
  ): void {
    this.readiness.set(this.readinessKey(connectionId, instrument), {
      ready: reason === 'READY',
      reason,
      authority,
      observedAt: observedAt.toISOString(),
    });
  }

  private readinessKey(connectionId: string, instrument: string): string {
    return `${connectionId.trim()}|${instrument.trim().toUpperCase()}`;
  }

  async loadSnapshot(
    connectionId: string,
    instrument: string,
    decisionTime: Date,
  ): Promise<M1TacticalMarketSnapshot | null> {
    const executionConnectionId = connectionId.trim();
    const normalizedInstrument = instrument.trim().toUpperCase();
    if (
      !executionConnectionId ||
      !normalizedInstrument ||
      !Number.isFinite(decisionTime.getTime())
    ) {
      this.setReadiness(
        executionConnectionId,
        normalizedInstrument,
        'INVALID_INPUT',
        null,
        Number.isFinite(decisionTime.getTime()) ? decisionTime : new Date(),
      );
      return null;
    }

    const configuredSource = this.configuredMarketDataConnectionId();
    const brokerSource = configuredSource || executionConnectionId;
    const brokerSnapshot = await this.loadBrokerNativeSnapshot(
      brokerSource,
      normalizedInstrument,
      decisionTime,
    );
    if (brokerSnapshot) return brokerSnapshot;

    // An explicitly configured broker-native source is authoritative. If it is
    // stale or incomplete, fail closed rather than silently switching evidence
    // authority underneath DEMO/LIVE readiness work.
    if (configuredSource || !this.paperMarket) return null;
    return this.loadPaperSnapshot(executionConnectionId, normalizedInstrument, decisionTime);
  }

  private async loadBrokerNativeSnapshot(
    connectionId: string,
    instrument: string,
    decisionTime: Date,
  ): Promise<M1TacticalMarketSnapshot | null> {
    const [m1, m5, m15, h1, h4, spreadQuote] = await Promise.all([
      this.store.getCandles(connectionId, instrument, 'M1', M1_HISTORY_COUNT, decisionTime),
      this.store.getCandles(connectionId, instrument, 'M5', CONTEXT_HISTORY_COUNT, decisionTime),
      this.store.getCandles(connectionId, instrument, 'M15', CONTEXT_HISTORY_COUNT, decisionTime),
      this.store.getCandles(connectionId, instrument, 'H1', CONTEXT_HISTORY_COUNT, decisionTime),
      this.store.getCandles(connectionId, instrument, 'H4', CONTEXT_HISTORY_COUNT, decisionTime),
      this.store.getLatestPositiveSpreadQuote(connectionId, instrument, decisionTime),
    ]);

    const candleSource = singleM1Source(m1);
    if (!candleSource) {
      this.setReadiness(
        connectionId,
        instrument,
        'BROKER_M1_SOURCE_UNAVAILABLE',
        null,
        decisionTime,
      );
      return null;
    }
    const m1CloseAgeMs = latestCloseAgeMs(m1, 1, decisionTime);
    if (m1CloseAgeMs === null || m1CloseAgeMs < 0 || m1CloseAgeMs > M1_CLOSE_MAX_AGE_MS) {
      this.setReadiness(connectionId, instrument, 'BROKER_M1_STALE', null, decisionTime);
      return null;
    }
    if (!spreadQuote) {
      this.setReadiness(connectionId, instrument, 'BROKER_SPREAD_UNAVAILABLE', null, decisionTime);
      return null;
    }
    const spreadPrice = Number(spreadQuote.spread);
    const positiveSampleCount = Number(spreadQuote.positiveSampleCount);
    const latestPositiveSampleAt = spreadQuote.latestPositiveSampleAt.getTime();
    const spreadAgeMs = decisionTime.getTime() - latestPositiveSampleAt;
    if (
      !Number.isFinite(spreadPrice) ||
      spreadPrice <= 0 ||
      !Number.isFinite(positiveSampleCount) ||
      positiveSampleCount < ENSEMBLE_EXECUTION_SPREAD_MIN_SAMPLES ||
      !Number.isFinite(latestPositiveSampleAt) ||
      spreadAgeMs < 0 ||
      spreadAgeMs > ENSEMBLE_EXECUTION_SPREAD_MAX_AGE_MS
    ) {
      this.setReadiness(connectionId, instrument, 'BROKER_SPREAD_UNUSABLE', null, decisionTime);
      return null;
    }

    const featureInput: M1TacticalFeatureInput = {
      instrument,
      decisionTime: new Date(decisionTime),
      m1,
      m5,
      m15,
      h1,
      h4,
    };
    if (!buildM1TacticalFeatures(featureInput)) {
      this.setReadiness(
        connectionId,
        instrument,
        'BROKER_FEATURE_CONTEXT_UNAVAILABLE',
        null,
        decisionTime,
      );
      return null;
    }

    this.setReadiness(connectionId, instrument, 'READY', 'BROKER_NATIVE', decisionTime);
    return {
      connectionId,
      ...featureInput,
      candleSource,
      spreadEvidence: {
        source: 'BROKER_OBSERVED_P90',
        spreadPrice,
        sampleCount: positiveSampleCount,
        percentile: 0.9,
        windowMinutes: 30,
        latestSampleAt: spreadQuote.latestPositiveSampleAt.toISOString(),
      },
      marketDataAuthority: 'BROKER_NATIVE',
    };
  }

  private loadPaperSnapshot(
    connectionId: string,
    instrument: string,
    decisionTime: Date,
  ): M1TacticalMarketSnapshot | null {
    if (!this.paperMarket) {
      this.setReadiness(connectionId, instrument, 'PAPER_CACHE_UNAVAILABLE', null, decisionTime);
      return null;
    }
    let m1: OHLCV[];
    let m5: OHLCV[];
    let m15: OHLCV[];
    let h1: OHLCV[];
    let h4: OHLCV[];
    try {
      m1 = this.paperMarket.getOHLCV(instrument, 'M1', M1_HISTORY_COUNT, connectionId);
      m5 = this.paperMarket.getOHLCV(instrument, 'M5', CONTEXT_HISTORY_COUNT, connectionId);
      m15 = this.paperMarket.getOHLCV(instrument, 'M15', CONTEXT_HISTORY_COUNT, connectionId);
      h1 = this.paperMarket.getOHLCV(instrument, 'H1', CONTEXT_HISTORY_COUNT, connectionId);
      h4 = this.paperMarket.getOHLCV(instrument, 'H4', CONTEXT_HISTORY_COUNT, connectionId);
    } catch {
      this.setReadiness(connectionId, instrument, 'PAPER_CACHE_UNAVAILABLE', null, decisionTime);
      return null;
    }
    const m1CloseAgeMs = latestCloseAgeMs(m1, 1, decisionTime);
    if (m1CloseAgeMs === null || m1CloseAgeMs < 0 || m1CloseAgeMs > M1_CLOSE_MAX_AGE_MS) {
      this.setReadiness(connectionId, instrument, 'PAPER_M1_STALE', null, decisionTime);
      return null;
    }
    const paperSimulationSpreadPrice = this.paperMarket.getPaperFallbackSpread(
      instrument,
      connectionId,
    );
    if (!Number.isFinite(paperSimulationSpreadPrice) || paperSimulationSpreadPrice <= 0) {
      this.setReadiness(connectionId, instrument, 'PAPER_SPREAD_UNAVAILABLE', null, decisionTime);
      return null;
    }
    const featureInput: M1TacticalFeatureInput = {
      instrument,
      decisionTime: new Date(decisionTime),
      m1,
      m5,
      m15,
      h1,
      h4,
    };
    if (!buildM1TacticalFeatures(featureInput)) {
      this.setReadiness(
        connectionId,
        instrument,
        'PAPER_FEATURE_CONTEXT_UNAVAILABLE',
        null,
        decisionTime,
      );
      return null;
    }

    this.setReadiness(connectionId, instrument, 'READY', 'PAPER_PROVIDER_SIMULATION', decisionTime);
    return {
      connectionId,
      ...featureInput,
      candleSource: 'PAPER_FAST_MARK_M1',
      spreadEvidence: null,
      paperSimulationSpreadPrice,
      marketDataAuthority: 'PAPER_PROVIDER_SIMULATION',
    };
  }

  private configuredMarketDataConnectionId(): string {
    return this.config?.get<string>('vpsForexScanner.m1MarketDataConnectionId', '')?.trim() || '';
  }
}
