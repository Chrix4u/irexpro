import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OHLCV } from '../broker/interfaces/broker-adapter.interface';
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

export interface M1TacticalMarketSnapshot extends M1TacticalFeatureInput {
  connectionId: string;
  candleSource: string;
  spreadEvidence: ExecutionSpreadEvidence;
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
  constructor(
    private readonly store: ProviderQuoteCandleStoreService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async loadSnapshot(
    connectionId: string,
    instrument: string,
    decisionTime: Date,
  ): Promise<M1TacticalMarketSnapshot | null> {
    const normalizedConnectionId = this.marketDataConnectionId(connectionId);
    const normalizedInstrument = instrument.trim().toUpperCase();
    if (
      !normalizedConnectionId ||
      !normalizedInstrument ||
      !Number.isFinite(decisionTime.getTime())
    ) {
      return null;
    }

    const [m1, m5, m15, h1, h4, spreadQuote] = await Promise.all([
      this.store.getCandles(
        normalizedConnectionId,
        normalizedInstrument,
        'M1',
        M1_HISTORY_COUNT,
        decisionTime,
      ),
      this.store.getCandles(
        normalizedConnectionId,
        normalizedInstrument,
        'M5',
        CONTEXT_HISTORY_COUNT,
        decisionTime,
      ),
      this.store.getCandles(
        normalizedConnectionId,
        normalizedInstrument,
        'M15',
        CONTEXT_HISTORY_COUNT,
        decisionTime,
      ),
      this.store.getCandles(
        normalizedConnectionId,
        normalizedInstrument,
        'H1',
        CONTEXT_HISTORY_COUNT,
        decisionTime,
      ),
      this.store.getCandles(
        normalizedConnectionId,
        normalizedInstrument,
        'H4',
        CONTEXT_HISTORY_COUNT,
        decisionTime,
      ),
      this.store.getLatestPositiveSpreadQuote(
        normalizedConnectionId,
        normalizedInstrument,
        decisionTime,
      ),
    ]);

    const candleSource = singleM1Source(m1);
    if (!candleSource) return null;

    const m1CloseAgeMs = latestCloseAgeMs(m1, 1, decisionTime);
    if (m1CloseAgeMs === null || m1CloseAgeMs < 0 || m1CloseAgeMs > M1_CLOSE_MAX_AGE_MS) {
      return null;
    }

    if (!spreadQuote) return null;
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
      return null;
    }

    const featureInput: M1TacticalFeatureInput = {
      instrument: normalizedInstrument,
      decisionTime: new Date(decisionTime),
      m1,
      m5,
      m15,
      h1,
      h4,
    };
    if (!buildM1TacticalFeatures(featureInput)) return null;

    return {
      connectionId: normalizedConnectionId,
      instrument: normalizedInstrument,
      decisionTime: new Date(decisionTime),
      candleSource,
      m1,
      m5,
      m15,
      h1,
      h4,
      spreadEvidence: {
        source: 'BROKER_OBSERVED_P90',
        spreadPrice,
        sampleCount: positiveSampleCount,
        percentile: 0.9,
        windowMinutes: 30,
        latestSampleAt: spreadQuote.latestPositiveSampleAt.toISOString(),
      },
    };
  }

  private marketDataConnectionId(executionConnectionId: string): string {
    const execution = executionConnectionId.trim();
    const configured = this.config
      ?.get<string>('vpsForexScanner.m1MarketDataConnectionId', execution)
      ?.trim();
    return configured || execution;
  }
}
