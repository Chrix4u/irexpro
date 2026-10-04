import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  AiEngineClient,
  PlanBV85BrokerCheckpointResponse,
} from '../ai-engine-client/ai-engine-client.service';
import { PLAN_B_ENSEMBLE_ARTIFACT } from './plan-b-multimodel-shadow';
import { PLAN_B_V85_ARTIFACT, dueV85Checkpoints } from './post-entry-protection-shadow.service';

const ACTIVE_ENGINE_CODE = 'irexpro-multimodel-ensemble-v1';

interface ShadowDecisionRow {
  shadow_decision_id: string;
  user_id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  evaluated_at: string | Date;
  entry_price: string | number;
  confidence: string | number;
  components: Record<string, unknown> | null;
}

interface ExistingObservation {
  checkpoint_minutes: number;
  state: string;
}

interface ParsedShadowEntryFeatures {
  stopLoss: number;
  candidateScore: number;
  extensionAtr: number;
  volatilityScore: number;
  emaSeparation: number;
  mtfStrength: number;
  rsi14: number;
  outcomeResolvedAt: Date | null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseV85ShadowDecisionFeatures(
  components: Record<string, unknown> | null,
): ParsedShadowEntryFeatures | null {
  if (!components) return null;
  const outcome =
    components.outcome && typeof components.outcome === 'object'
      ? (components.outcome as Record<string, unknown>)
      : null;
  const outcomeResolvedAt =
    typeof outcome?.resolvedAt === 'string' ? new Date(outcome.resolvedAt) : null;

  const values = {
    stopLoss: finite(components.stopLoss),
    candidateScore: finite(components.candidateScore),
    extensionAtr: finite(components.extensionAtr),
    volatilityScore: finite(components.volatilityScore),
    emaSeparation: finite(components.emaSeparation),
    mtfStrength: finite(components.mtfStrength),
    rsi14: finite(components.rsi14),
  };

  if (Object.values(values).some((value) => value == null)) return null;
  if (outcomeResolvedAt && !Number.isFinite(outcomeResolvedAt.getTime())) {
    return null;
  }

  return {
    ...(values as Omit<ParsedShadowEntryFeatures, 'outcomeResolvedAt'>),
    outcomeResolvedAt,
  };
}

@Injectable()
export class EnsemblePostEntryProtectionShadowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnsemblePostEntryProtectionShadowService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private artifactReady = false;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;
  private lastScored = 0;
  private lastCandidates = 0;
  private observedCheckpoints = 0;

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
          `v8.5 virtual post-entry shadow watcher disabled: artifact not ready (${status.load_error ?? 'unknown'})`,
        );
        return;
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`v8.5 virtual post-entry shadow watcher disabled: ${this.lastError}`);
      return;
    }

    this.logger.log(
      'v8.5 virtual post-entry shadow watcher enabled cadence=60s cohort=ensemble_shadow_decisions authority=NONE modifiesExecution=false',
    );
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref?.();
    setTimeout(() => void this.runOnce(), 12_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      artifact: PLAN_B_V85_ARTIFACT,
      enabled: this.artifactReady,
      cohort: 'ENSEMBLE_SHADOW_DECISIONS' as const,
      sourceArtifact: PLAN_B_ENSEMBLE_ARTIFACT,
      executionAuthority: 'NONE' as const,
      modifiesExecution: false,
      cadenceSeconds: 60,
      checkpointsMinutes: [5, 10, 15, 30, 60, 120, 240],
      brokerSourceConfigured: Boolean(this.marketDataConnectionId()),
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastScored: this.lastScored,
      lastCandidates: this.lastCandidates,
      observedCheckpoints: this.observedCheckpoints,
      lastError: this.lastError,
    };
  }

  async getUserStatus(userId: string) {
    const status = this.getStatus();
    if (!userId) return { ...status, observedCheckpoints: 0 };
    const rows = (await this.dataSource.query(
      `
        SELECT count(*)::int AS count
        FROM trading.ensemble_post_entry_shadow_observations
        WHERE user_id = $1
          AND artifact = $2
          AND state IN ('READY', 'NOT_YET_ELIGIBLE')
      `,
      [userId, PLAN_B_V85_ARTIFACT],
    )) as Array<{ count: number | string }>;
    return {
      ...status,
      observedCheckpoints: Number(rows[0]?.count ?? 0),
    };
  }

  async runOnce(now = new Date()): Promise<void> {
    if (!this.artifactReady || this.running) return;
    this.running = true;
    this.lastScored = 0;
    this.lastCandidates = 0;

    try {
      const scannerUserId = this.scannerUserId();
      if (!scannerUserId) {
        this.lastError = 'SCANNER_USER_NOT_CONFIGURED';
        return;
      }
      const rows = await this.loadCandidates(scannerUserId, now);
      this.lastCandidates = rows.length;
      for (const row of rows) {
        await this.processDecision(row, now);
      }
      await this.refreshObservationCount();
      this.lastRunAt = now;
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`v8.5 virtual post-entry shadow watcher failed: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  private async loadCandidates(userId: string, now: Date): Promise<ShadowDecisionRow[]> {
    return (await this.dataSource.query(
      `
        SELECT
          id AS shadow_decision_id,
          user_id,
          instrument,
          direction,
          evaluated_at,
          entry_price,
          confidence,
          components
        FROM trading.ensemble_shadow_decisions
        WHERE engine_code = $1
          AND model_version = $2
          AND user_id = $3
          AND admitted = true
          AND evaluated_at >= $4::timestamptz - interval '8 hours'
        ORDER BY evaluated_at ASC
      `,
      [ACTIVE_ENGINE_CODE, PLAN_B_ENSEMBLE_ARTIFACT, userId, now.toISOString()],
    )) as ShadowDecisionRow[];
  }

  private async processDecision(row: ShadowDecisionRow, now: Date): Promise<void> {
    const openedAt = new Date(row.evaluated_at);
    const features = parseV85ShadowDecisionFeatures(row.components);
    if (!features || !Number.isFinite(openedAt.getTime())) {
      this.logger.warn(
        `v8.5 virtual shadow decision=${row.shadow_decision_id} skipped: immutable entry features are incomplete`,
      );
      return;
    }

    const observationEnd =
      features.outcomeResolvedAt && features.outcomeResolvedAt < now
        ? features.outcomeResolvedAt
        : now;

    const existing = (await this.dataSource.query(
      `
        SELECT checkpoint_minutes, state
        FROM trading.ensemble_post_entry_shadow_observations
        WHERE ensemble_shadow_decision_id = $1
          AND artifact = $2
      `,
      [row.shadow_decision_id, PLAN_B_V85_ARTIFACT],
    )) as ExistingObservation[];

    const terminal = new Set(
      existing
        .filter(
          (item) =>
            item.state === 'READY' || item.state === 'NOT_YET_ELIGIBLE' || item.state === 'ERROR',
        )
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
          stopLoss: features.stopLoss,
          openedAt,
          checkpointMinutes,
          confidence: Number(row.confidence),
          candidateScore: features.candidateScore,
          extensionAtr: features.extensionAtr,
          volatilityScore: features.volatilityScore,
          emaSeparation: features.emaSeparation,
          mtfStrength: features.mtfStrength,
          rsi14: features.rsi14,
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
          `v8.5 virtual shadow decision=${row.shadow_decision_id} ${row.instrument} checkpoint=${checkpointMinutes}m ` +
            `action=${response.score?.action ?? 'UNKNOWN'} probability=${response.score?.probability ?? 'n/a'} authority=NONE`,
        );
      }
    }
  }

  private async persistObservation(
    row: ShadowDecisionRow,
    checkpointMinutes: number,
    checkpointAt: Date,
    marketDataConnectionId: string | null,
    response: PlanBV85BrokerCheckpointResponse,
  ): Promise<void> {
    const score = response.score ?? null;

    await this.dataSource.query(
      `
        INSERT INTO trading.ensemble_post_entry_shadow_observations (
          user_id,
          ensemble_shadow_decision_id,
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
          $1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,'NONE',false,now()
        )
        ON CONFLICT (ensemble_shadow_decision_id, artifact, checkpoint_minutes)
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
        row.shadow_decision_id,
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

  private async refreshObservationCount(): Promise<void> {
    const rows = (await this.dataSource.query(
      `
        SELECT count(*)::int AS count
        FROM trading.ensemble_post_entry_shadow_observations
        WHERE artifact = $1
          AND state IN ('READY', 'NOT_YET_ELIGIBLE')
      `,
      [PLAN_B_V85_ARTIFACT],
    )) as Array<{ count: number | string }>;
    this.observedCheckpoints = Number(rows[0]?.count ?? 0);
  }

  private scannerUserId(): string {
    return this.config.get<string>('vpsForexScanner.userId', '').trim();
  }

  private marketDataConnectionId(): string {
    if (!this.config.get<boolean>('multimodelBrokerExpert.enabled', false)) return '';
    return this.config.get<string>('multimodelBrokerExpert.sourceConnectionId', '').trim();
  }
}
