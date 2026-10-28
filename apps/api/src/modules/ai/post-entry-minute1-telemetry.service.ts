import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { parseV85EntryFeatures } from './post-entry-protection-shadow.service';

export const PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT = 'plan-b-v88-minute1-prospective-telemetry-v1';
const MINUTE1_CHECKPOINT = 1;
const TELEMETRY_INTERVAL_MS = 60_000;

interface CandidateRow {
  trade_id: string;
  user_id: string;
  trade_intent_id: string;
  execution_broker_connection_id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  entry_price: string | number;
  stop_loss: string | number;
  opened_at: string | Date;
  closed_at: string | Date | null;
  metadata: Record<string, unknown> | null;
}

interface BrokerMinuteRow {
  bucket_time: string | Date;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  bid_close: string | number | null;
  ask_close: string | number | null;
  spread_close: string | number | null;
  sample_count: string | number;
  source: string;
  first_sample_at: string | Date;
  last_sample_at: string | Date;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function minute1TelemetryDue(
  openedAt: Date,
  observationEnd: Date,
  captured: boolean,
): boolean {
  if (captured) return false;
  if (!Number.isFinite(openedAt.getTime()) || !Number.isFinite(observationEnd.getTime())) {
    return false;
  }
  if (observationEnd < openedAt) return false;
  return openedAt.getTime() + 60_000 <= observationEnd.getTime();
}

@Injectable()
export class PostEntryMinute1TelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostEntryMinute1TelemetryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;
  private lastCaptured = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.logger.log(
      'minute-1 post-entry prospective telemetry enabled cadence=60s authority=NONE modifiesExecution=false',
    );
    this.timer = setInterval(() => void this.runOnce(), TELEMETRY_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(() => void this.runOnce(), 12_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      artifact: PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT,
      enabled: true,
      executionAuthority: 'NONE' as const,
      modifiesExecution: false,
      cadenceSeconds: TELEMETRY_INTERVAL_MS / 1000,
      checkpointMinutes: MINUTE1_CHECKPOINT,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastCaptured: this.lastCaptured,
      lastError: this.lastError,
    };
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastCaptured = 0;
    try {
      const candidates = await this.loadCandidates(now);
      for (const row of candidates) {
        await this.processTrade(row, now);
      }
      this.lastRunAt = now;
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`minute-1 post-entry telemetry failed: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(now: Date): Promise<CandidateRow[]> {
    return (await this.dataSource.query(
      `
        SELECT
          t.id AS trade_id,
          t.user_id,
          t.trade_intent_id,
          t.broker_connection_id AS execution_broker_connection_id,
          t.instrument,
          t.direction,
          COALESCE(t.fill_price, t.requested_entry_price) AS entry_price,
          t.stop_loss,
          t.opened_at,
          t.closed_at,
          ti.metadata
        FROM trading.trades t
        JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
        JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
        WHERE t.trade_intent_id IS NOT NULL
          AND bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
          AND t.opened_at IS NOT NULL
          AND COALESCE(t.fill_price, t.requested_entry_price) IS NOT NULL
          AND t.stop_loss IS NOT NULL
          AND t.status IN ('OPEN', 'CLOSED')
          AND t.opened_at >= $1::timestamptz - interval '8 hours'
          AND ti.metadata->>'external_provider_code' = 'irexpro-multimodel-ensemble-v1'
        ORDER BY t.opened_at ASC
      `,
      [now.toISOString()],
    )) as CandidateRow[];
  }

  private async processTrade(row: CandidateRow, now: Date): Promise<void> {
    const openedAt = new Date(row.opened_at);
    const observationEnd = row.closed_at ? new Date(row.closed_at) : now;
    const existing = (await this.dataSource.query(
      `
        SELECT state
        FROM trading.post_entry_shadow_observations
        WHERE trade_id = $1
          AND artifact = $2
          AND checkpoint_minutes = 1
        LIMIT 1
      `,
      [row.trade_id, PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT],
    )) as Array<{ state: string }>;
    const captured = existing.some((item) => item.state === 'READY');
    if (!minute1TelemetryDue(openedAt, observationEnd, captured)) return;

    const checkpointAt = new Date(openedAt.getTime() + 60_000);
    const marketDataConnectionId = this.marketDataConnectionId(row.execution_broker_connection_id);
    if (!marketDataConnectionId) {
      await this.persistObservation(
        row,
        checkpointAt,
        null,
        'WAITING_FOR_BROKER_DATA',
        'BROKER_SOURCE_NOT_CONFIGURED',
        null,
        null,
      );
      return;
    }

    const buckets = (await this.dataSource.query(
      `
        SELECT
          bucket_time, open, high, low, close,
          bid_close, ask_close, spread_close,
          sample_count, source, first_sample_at, last_sample_at
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND bucket_time + interval '1 minute' <= $3::timestamptz
        ORDER BY bucket_time DESC
        LIMIT 5
      `,
      [marketDataConnectionId, row.instrument.toUpperCase(), checkpointAt.toISOString()],
    )) as BrokerMinuteRow[];

    const latest = buckets[0];
    if (!latest || !this.isCausalBrokerMinute(latest, checkpointAt)) {
      await this.persistObservation(
        row,
        checkpointAt,
        marketDataConnectionId,
        'WAITING_FOR_BROKER_DATA',
        'MINUTE1_BROKER_CANDLE_UNAVAILABLE',
        null,
        null,
      );
      return;
    }

    const entry = finite(row.entry_price);
    const stop = finite(row.stop_loss);
    const close = finite(latest.close);
    const risk = entry == null || stop == null ? null : Math.abs(entry - stop);
    if (entry == null || close == null || risk == null || risk <= 0) {
      await this.persistObservation(
        row,
        checkpointAt,
        marketDataConnectionId,
        'ERROR',
        'INVALID_TRADE_GEOMETRY',
        null,
        null,
      );
      return;
    }

    const sign = row.direction === 'BUY' ? 1 : -1;
    const currentR = (sign * (close - entry)) / risk;
    const response = this.buildTelemetryResponse(row, checkpointAt, currentR, risk, buckets);
    await this.persistObservation(
      row,
      checkpointAt,
      marketDataConnectionId,
      'READY',
      null,
      currentR,
      response,
    );
    this.lastCaptured += 1;
  }

  private isCausalBrokerMinute(row: BrokerMinuteRow, checkpointAt: Date): boolean {
    if (row.source !== 'ctrader-broker-native') return false;
    const bucket = new Date(row.bucket_time);
    const closeTime = new Date(bucket.getTime() + 60_000);
    const alignmentMs = checkpointAt.getTime() - closeTime.getTime();
    const spread = finite(row.spread_close);
    const samples = finite(row.sample_count);
    return (
      Number.isFinite(bucket.getTime()) &&
      alignmentMs >= 0 &&
      alignmentMs <= 60_000 &&
      spread != null &&
      spread > 0 &&
      samples != null &&
      samples > 0
    );
  }

  private buildTelemetryResponse(
    row: CandidateRow,
    checkpointAt: Date,
    currentR: number,
    risk: number,
    buckets: BrokerMinuteRow[],
  ) {
    const normalized = buckets.map((bucket) => ({
      bucket_time: new Date(bucket.bucket_time).toISOString(),
      open: String(bucket.open),
      high: String(bucket.high),
      low: String(bucket.low),
      close: String(bucket.close),
      bid_close: bucket.bid_close == null ? null : String(bucket.bid_close),
      ask_close: bucket.ask_close == null ? null : String(bucket.ask_close),
      spread_close: bucket.spread_close == null ? null : String(bucket.spread_close),
      sample_count: Number(bucket.sample_count),
      source: bucket.source,
      first_sample_at: new Date(bucket.first_sample_at).toISOString(),
      last_sample_at: new Date(bucket.last_sample_at).toISOString(),
    }));
    const latest = normalized[0]!;
    const open = finite(latest.open) ?? 0;
    const high = finite(latest.high) ?? open;
    const low = finite(latest.low) ?? open;
    const close = finite(latest.close) ?? open;
    const sign = row.direction === 'BUY' ? 1 : -1;
    const spreads = normalized
      .map((bucket) => finite(bucket.spread_close))
      .filter((value): value is number => value != null && value > 0);
    const samples = normalized
      .map((bucket) => finite(bucket.sample_count))
      .filter((value): value is number => value != null && value > 0);

    return {
      artifact: PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT,
      mode: 'PROSPECTIVE_TELEMETRY_ONLY',
      checkpoint_minutes: 1,
      checkpoint_at: checkpointAt.toISOString(),
      current_r: currentR,
      entry_features: parseV85EntryFeatures(row.metadata),
      microstructure: {
        latest,
        trailing_buckets: normalized,
        directional_body_r: (sign * (close - open)) / risk,
        range_r: (high - low) / risk,
        trailing_spread_mean: spreads.length
          ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length
          : null,
        trailing_sample_count_mean: samples.length
          ? samples.reduce((sum, value) => sum + value, 0) / samples.length
          : null,
      },
      execution_authority: 'NONE',
      modifies_execution: false,
    };
  }

  private async persistObservation(
    row: CandidateRow,
    checkpointAt: Date,
    marketDataConnectionId: string | null,
    state: string,
    reason: string | null,
    currentR: number | null,
    response: Record<string, unknown> | null,
  ): Promise<void> {
    await this.dataSource.query(
      `
        INSERT INTO trading.post_entry_shadow_observations (
          user_id, trade_id, trade_intent_id,
          execution_broker_connection_id, market_data_connection_id,
          artifact, checkpoint_minutes, checkpoint_at, evaluated_at,
          state, reason, probability, threshold, current_r,
          eligible_profit_state, action, market_data_sources, response,
          execution_authority, modifies_execution, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,NULL,NULL,$11,$12,'OBSERVE',$13::jsonb,$14::jsonb,'NONE',false,now()
        )
        ON CONFLICT (trade_id, artifact, checkpoint_minutes)
        DO UPDATE SET
          market_data_connection_id = EXCLUDED.market_data_connection_id,
          evaluated_at = now(),
          state = EXCLUDED.state,
          reason = EXCLUDED.reason,
          current_r = EXCLUDED.current_r,
          eligible_profit_state = EXCLUDED.eligible_profit_state,
          action = 'OBSERVE',
          market_data_sources = EXCLUDED.market_data_sources,
          response = EXCLUDED.response,
          execution_authority = 'NONE',
          modifies_execution = false,
          updated_at = now()
      `,
      [
        row.user_id,
        row.trade_id,
        row.trade_intent_id,
        row.execution_broker_connection_id,
        marketDataConnectionId,
        PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT,
        MINUTE1_CHECKPOINT,
        checkpointAt.toISOString(),
        state,
        reason,
        currentR,
        currentR == null ? null : currentR >= 0.25,
        JSON.stringify(marketDataConnectionId ? { M1: 'ctrader-broker-native' } : null),
        JSON.stringify(
          response ?? {
            artifact: PLAN_B_V88_MINUTE1_TELEMETRY_ARTIFACT,
            mode: 'PROSPECTIVE_TELEMETRY_ONLY',
            checkpoint_minutes: 1,
            checkpoint_at: checkpointAt.toISOString(),
            state,
            reason,
            execution_authority: 'NONE',
            modifies_execution: false,
          },
        ),
      ],
    );
  }

  private marketDataConnectionId(executionBrokerConnectionId?: string): string {
    const execution = (executionBrokerConnectionId ?? '').trim();
    if (execution) return execution;
    const m1 = this.config.get<string>('vpsForexScanner.m1MarketDataConnectionId', '').trim();
    if (m1) return m1;
    return this.config.get<string>('multimodelBrokerExpert.sourceConnectionId', '').trim();
  }
}
