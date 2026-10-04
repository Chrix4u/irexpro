import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  AiEngineClient,
  PlanBV85BrokerCheckpointResponse,
} from '../ai-engine-client/ai-engine-client.service';

export const PLAN_B_V85_ARTIFACT = 'plan-b-v85-profitable-state-giveback-classifier-v1';
export const PLAN_B_V85_CHECKPOINTS = Object.freeze([5, 10, 15, 30, 60, 120, 240] as const);

type CheckpointMinutes = (typeof PLAN_B_V85_CHECKPOINTS)[number];

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

interface ExistingObservation {
  checkpoint_minutes: number;
  state: string;
}

interface ParsedEntryFeatures {
  confidence: number;
  candidateScore: number;
  extensionAtr: number;
  volatilityScore: number;
  emaSeparation: number;
  mtfStrength: number;
  rsi14: number;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseV85EntryFeatures(
  metadata: Record<string, unknown> | null,
): ParsedEntryFeatures | null {
  if (!metadata) return null;
  const values = {
    confidence: finite(metadata.confidenceScore),
    candidateScore: finite(metadata.feature_candidate_score),
    extensionAtr: finite(metadata.feature_extension_atr),
    volatilityScore: finite(metadata.feature_volatility_score),
    emaSeparation: finite(metadata.feature_ema_separation),
    mtfStrength: finite(metadata.feature_mtf_strength),
    rsi14: finite(metadata.feature_rsi14),
  };
  return Object.values(values).every((value) => value != null)
    ? (values as ParsedEntryFeatures)
    : null;
}

export function dueV85Checkpoints(
  openedAt: Date,
  observationEnd: Date,
  terminalCheckpoints: ReadonlySet<number>,
): CheckpointMinutes[] {
  if (
    !Number.isFinite(openedAt.getTime()) ||
    !Number.isFinite(observationEnd.getTime()) ||
    observationEnd < openedAt
  ) {
    return [];
  }
  return PLAN_B_V85_CHECKPOINTS.filter((checkpoint) => {
    if (terminalCheckpoints.has(checkpoint)) return false;
    const checkpointAt = openedAt.getTime() + checkpoint * 60_000;
    return checkpointAt <= observationEnd.getTime();
  });
}

@Injectable()
export class PostEntryProtectionShadowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostEntryProtectionShadowService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private artifactReady = false;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;
  private lastScored = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly aiEngineClient: AiEngineClient,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const status = await this.aiEngineClient.getPlanBV85PostEntryStatus();
      this.artifactReady = status.loaded && status.execution_authority === 'NONE';
      if (!this.artifactReady) {
        this.logger.warn(
          `v8.5 post-entry shadow watcher disabled: artifact not ready (${status.load_error ?? 'unknown'})`,
        );
        return;
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`v8.5 post-entry shadow watcher disabled: ${this.lastError}`);
      return;
    }

    this.logger.log(
      'v8.5 post-entry shadow watcher enabled cadence=60s authority=NONE modifiesExecution=false',
    );
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref?.();
    setTimeout(() => void this.runOnce(), 10_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      artifact: PLAN_B_V85_ARTIFACT,
      enabled: this.artifactReady,
      executionAuthority: 'NONE' as const,
      modifiesExecution: false,
      cadenceSeconds: 60,
      checkpointsMinutes: [...PLAN_B_V85_CHECKPOINTS],
      brokerSourceConfigured: Boolean(this.marketDataConnectionId()),
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastScored: this.lastScored,
      lastError: this.lastError,
    };
  }

  async runOnce(now = new Date()): Promise<void> {
    if (!this.artifactReady || this.running) return;
    this.running = true;
    this.lastScored = 0;
    try {
      const rows = await this.loadCandidates(now);
      for (const row of rows) {
        await this.processTrade(row, now);
      }
      this.lastRunAt = now;
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`v8.5 post-entry shadow watcher failed: ${this.lastError}`);
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
        WHERE t.trade_intent_id IS NOT NULL
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
    const features = parseV85EntryFeatures(row.metadata);
    if (!features) {
      this.logger.warn(
        `v8.5 trade=${row.trade_id} skipped: immutable entry features are incomplete`,
      );
      return;
    }

    const existing = (await this.dataSource.query(
      `
        SELECT checkpoint_minutes, state
        FROM trading.post_entry_shadow_observations
        WHERE trade_id = $1
          AND artifact = $2
      `,
      [row.trade_id, PLAN_B_V85_ARTIFACT],
    )) as ExistingObservation[];

    const terminal = new Set(
      existing
        .filter((item) => item.state === 'READY' || item.state === 'NOT_YET_ELIGIBLE')
        .map((item) => Number(item.checkpoint_minutes)),
    );
    const due = dueV85Checkpoints(openedAt, observationEnd, terminal);
    const marketDataConnectionId = this.marketDataConnectionId();

    for (const checkpointMinutes of due) {
      const checkpointAt = new Date(openedAt.getTime() + checkpointMinutes * 60_000);
      let response: PlanBV85BrokerCheckpointResponse;
      if (!marketDataConnectionId) {
        response = {
          state: 'WAITING_FOR_BROKER_DATA',
          reason: 'BROKER_SOURCE_NOT_CONFIGURED',
          status: null,
          checkpoint_at: checkpointAt.toISOString(),
          score: null,
        };
      } else {
        response = await this.aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint({
          userId: row.user_id,
          brokerConnectionId: marketDataConnectionId,
          instrument: row.instrument,
          direction: row.direction,
          entryPrice: Number(row.entry_price),
          stopLoss: Number(row.stop_loss),
          openedAt,
          checkpointMinutes,
          ...features,
        });
      }

      await this.persistObservation(
        row,
        checkpointMinutes,
        checkpointAt,
        marketDataConnectionId || null,
        response,
      );
      if (response.state === 'READY') {
        this.lastScored += 1;
        this.logger.log(
          `v8.5 shadow trade=${row.trade_id} ${row.instrument} checkpoint=${checkpointMinutes}m ` +
            `action=${response.score?.action ?? 'UNKNOWN'} probability=${response.score?.probability ?? 'n/a'} authority=NONE`,
        );
      }
    }
  }

  private async persistObservation(
    row: CandidateRow,
    checkpointMinutes: number,
    checkpointAt: Date,
    marketDataConnectionId: string | null,
    response: PlanBV85BrokerCheckpointResponse,
  ): Promise<void> {
    const score = response.score ?? null;
    await this.dataSource.query(
      `
        INSERT INTO trading.post_entry_shadow_observations (
          user_id,
          trade_id,
          trade_intent_id,
          execution_broker_connection_id,
          market_data_connection_id,
          artifact,
          checkpoint_minutes,
          checkpoint_at,
          evaluated_at,
          state,
          reason,
          probability,
          threshold,
          current_r,
          eligible_profit_state,
          action,
          market_data_sources,
          response,
          execution_authority,
          modifies_execution,
          updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,'NONE',false,now()
        )
        ON CONFLICT (trade_id, artifact, checkpoint_minutes)
        DO UPDATE SET
          market_data_connection_id = EXCLUDED.market_data_connection_id,
          evaluated_at = now(),
          state = EXCLUDED.state,
          reason = EXCLUDED.reason,
          probability = EXCLUDED.probability,
          threshold = EXCLUDED.threshold,
          current_r = EXCLUDED.current_r,
          eligible_profit_state = EXCLUDED.eligible_profit_state,
          action = EXCLUDED.action,
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
        PLAN_B_V85_ARTIFACT,
        checkpointMinutes,
        checkpointAt.toISOString(),
        response.state,
        response.reason ?? null,
        score?.probability ?? null,
        score?.threshold ?? null,
        score?.current_r ?? null,
        score?.eligible_profit_state ?? null,
        score?.action ?? null,
        JSON.stringify(response.market_data_sources ?? null),
        JSON.stringify(response),
      ],
    );
  }

  private marketDataConnectionId(): string {
    if (!this.config.get<boolean>('multimodelBrokerExpert.enabled', false)) return '';
    return this.config.get<string>('multimodelBrokerExpert.sourceConnectionId', '').trim();
  }
}
