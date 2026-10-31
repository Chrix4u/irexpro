import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AiEngineClient,
  PlanBV85BrokerCheckpointResponse,
} from '../ai-engine-client/ai-engine-client.service';
import { ExecutionService } from '../execution/execution.service';
import {
  TradeCloseReason,
  TradeStatus,
} from '../execution/entities/trade.entity';
import {
  parseV85EntryFeatures,
  PLAN_B_V85_ARTIFACT,
} from './post-entry-protection-shadow.service';

export const PLAN_B_V89_DEMO_DRAWDOWN_GUARD_ARTIFACT =
  'plan-b-v89-demo-5m-drawdown-guard-v1';
export const PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES = 5;
export const PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES = 7;
export const PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R = -0.4;
const PLAN_B_V89_DEMO_DRAWDOWN_INTERVAL_MS = 15_000;

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
  metadata: Record<string, unknown> | null;
}

type GuardState =
  | 'WAITING_FOR_BROKER_DATA'
  | 'ERROR'
  | 'NO_ACTION'
  | 'CLOSED'
  | 'CLOSE_PENDING_RECONCILIATION'
  | 'CLOSE_DISPATCHED'
  | 'CLOSE_FAILED';

type GuardAction = 'OBSERVE' | 'CLOSE_DEMO';

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function demoDrawdownGuardDue(openedAt: Date, now: Date): boolean {
  if (!Number.isFinite(openedAt.getTime()) || !Number.isFinite(now.getTime())) return false;
  const ageMs = now.getTime() - openedAt.getTime();
  const checkpointMs = PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES * 60_000;
  const deadlineMs = PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES * 60_000;
  return ageMs >= checkpointMs && ageMs <= deadlineMs;
}

export function shouldCloseDemoDrawdown(currentR: number): boolean {
  return Number.isFinite(currentR) && currentR <= PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R;
}

@Injectable()
export class PostEntryDemoDrawdownGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostEntryDemoDrawdownGuardService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private artifactReady: boolean | null = null;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;
  private lastEvaluated = 0;
  private lastCloseAttempts = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly aiEngineClient: AiEngineClient,
    private readonly executionService: ExecutionService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const status = await this.aiEngineClient.getPlanBV85PostEntryStatus();
      this.artifactReady = status.loaded && status.execution_authority === 'NONE';
      if (!this.artifactReady) {
        this.logger.warn('v8.9 DEMO drawdown guard disabled: v8.5 broker checkpoint artifact unavailable');
        return;
      }
    } catch (error) {
      this.artifactReady = false;
      this.lastError = (error as Error).message;
      this.logger.warn('v8.9 DEMO drawdown guard disabled: broker checkpoint status unavailable');
      return;
    }

    this.logger.log(
      `v8.9 DEMO drawdown guard enabled cadence=${PLAN_B_V89_DEMO_DRAWDOWN_INTERVAL_MS / 1000}s ` +
        `checkpoint=${PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES}m deadline=${PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES}m ` +
        `threshold=${PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R.toFixed(2)}R authority=DEMO_ONLY modifiesExecution=true LIVE=false`,
    );
    this.timer = setInterval(() => void this.runOnce(), PLAN_B_V89_DEMO_DRAWDOWN_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(() => void this.runOnce(), 13_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      artifact: PLAN_B_V89_DEMO_DRAWDOWN_GUARD_ARTIFACT,
      enabled: this.artifactReady === true,
      executionAuthority: 'DEMO_ONLY' as const,
      modifiesExecution: true,
      liveEligible: false,
      cadenceSeconds: PLAN_B_V89_DEMO_DRAWDOWN_INTERVAL_MS / 1000,
      checkpointMinutes: PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES,
      deadlineMinutes: PLAN_B_V89_DEMO_DRAWDOWN_DEADLINE_MINUTES,
      closeThresholdR: PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastEvaluated: this.lastEvaluated,
      lastCloseAttempts: this.lastCloseAttempts,
      lastError: this.lastError,
    };
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.artifactReady === false || this.running) return;
    this.running = true;
    this.lastEvaluated = 0;
    this.lastCloseAttempts = 0;
    try {
      const candidates = await this.loadCandidates(now);
      for (const row of candidates) {
        await this.processTrade(row, now);
      }
      this.lastRunAt = now;
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`v8.9 DEMO drawdown guard cycle failed: ${this.lastError}`);
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
          ti.metadata
        FROM trading.trades t
        JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
        JOIN broker.broker_connections bc ON bc.id = t.broker_connection_id
        WHERE t.trade_intent_id IS NOT NULL
          AND t.status = 'OPEN'
          AND bc.account_type = 'DEMO'
          AND bc.broker_id IN ('ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader')
          AND t.opened_at IS NOT NULL
          AND COALESCE(t.fill_price, t.requested_entry_price) IS NOT NULL
          AND t.stop_loss IS NOT NULL
          AND t.opened_at <= $1::timestamptz - interval '5 minutes'
          AND t.opened_at >= $1::timestamptz - interval '7 minutes'
          AND ti.strategy_code = 'external-irexpro-multimodel-ensemble'
          AND ti.metadata->>'external_provider_code' = 'irexpro-multimodel-ensemble-v1'
          AND NOT EXISTS (
            SELECT 1
            FROM trading.post_entry_shadow_observations o
            WHERE o.trade_id = t.id
              AND o.artifact = $2
              AND o.checkpoint_minutes = 5
              AND o.state IN (
                'ERROR', 'NO_ACTION', 'CLOSED', 'CLOSE_PENDING_RECONCILIATION',
                'CLOSE_DISPATCHED', 'CLOSE_FAILED'
              )
          )
        ORDER BY t.opened_at ASC
      `,
      [now.toISOString(), PLAN_B_V89_DEMO_DRAWDOWN_GUARD_ARTIFACT],
    )) as CandidateRow[];
  }

  private async processTrade(row: CandidateRow, now: Date): Promise<void> {
    const openedAt = new Date(row.opened_at);
    if (!demoDrawdownGuardDue(openedAt, now)) return;
    this.lastEvaluated += 1;

    const features = parseV85EntryFeatures(row.metadata);
    const checkpointAt = new Date(
      openedAt.getTime() + PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES * 60_000,
    );
    if (!features) {
      await this.persistObservation(row, null, 'ERROR', 'ENTRY_FEATURES_INCOMPLETE', null, 'OBSERVE', false, {
        state: 'ERROR',
        reason: 'ENTRY_FEATURES_INCOMPLETE',
        checkpoint_at: checkpointAt.toISOString(),
        score: null,
      } as PlanBV85BrokerCheckpointResponse);
      return;
    }

    let response: PlanBV85BrokerCheckpointResponse;
    try {
      response = await this.aiEngineClient.scorePlanBV85PostEntryBrokerCheckpoint({
        userId: row.user_id,
        brokerConnectionId: row.execution_broker_connection_id,
        instrument: row.instrument,
        direction: row.direction,
        entryPrice: Number(row.entry_price),
        stopLoss: Number(row.stop_loss),
        openedAt,
        checkpointMinutes: PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES,
        ...features,
      });
    } catch {
      await this.persistObservation(
        row,
        null,
        'WAITING_FOR_BROKER_DATA',
        'BROKER_CHECKPOINT_UNAVAILABLE',
        null,
        'OBSERVE',
        false,
        {
          state: 'WAITING_FOR_BROKER_DATA',
          reason: 'BROKER_CHECKPOINT_UNAVAILABLE',
          status: null,
          checkpoint_at: checkpointAt.toISOString(),
          score: null,
        },
      );
      return;
    }

    const currentR = finite(response.score?.current_r);
    const authoritativeBrokerCheckpoint =
      response.state === 'READY' &&
      response.score != null &&
      response.score.artifact === PLAN_B_V85_ARTIFACT &&
      response.score.execution_authority === 'NONE' &&
      response.score.modifies_execution === false &&
      response.market_data_sources?.M1 === 'broker';
    if (!authoritativeBrokerCheckpoint || currentR == null) {
      await this.persistObservation(
        row,
        response.score?.probability ?? null,
        response.state === 'ERROR' ? 'ERROR' : 'WAITING_FOR_BROKER_DATA',
        response.reason ?? 'BROKER_CHECKPOINT_NOT_READY',
        currentR,
        'OBSERVE',
        false,
        response,
      );
      return;
    }

    if (!shouldCloseDemoDrawdown(currentR)) {
      await this.persistObservation(
        row,
        response.score?.probability ?? null,
        'NO_ACTION',
        'DRAWDOWN_NOT_SEVERE',
        currentR,
        'OBSERVE',
        false,
        response,
      );
      return;
    }

    this.lastCloseAttempts += 1;
    try {
      const closed = await this.executionService.closeTrade(
        row.trade_id,
        row.user_id,
        TradeCloseReason.AI_CLOSE_SIGNAL,
      );
      const state: GuardState =
        closed.status === TradeStatus.CLOSED
          ? 'CLOSED'
          : closed.status === TradeStatus.RECONCILIATION_PENDING
            ? 'CLOSE_PENDING_RECONCILIATION'
            : 'CLOSE_DISPATCHED';
      const reason =
        state === 'CLOSED'
          ? 'DRAWDOWN_GUARD_CLOSED'
          : state === 'CLOSE_PENDING_RECONCILIATION'
            ? 'DRAWDOWN_GUARD_RECONCILIATION_PENDING'
            : 'DRAWDOWN_GUARD_CLOSE_DISPATCHED';
      await this.persistObservation(
        row,
        response.score?.probability ?? null,
        state,
        reason,
        currentR,
        'CLOSE_DEMO',
        true,
        response,
      );
    } catch {
      await this.persistObservation(
        row,
        response.score?.probability ?? null,
        'CLOSE_FAILED',
        'EXECUTION_CLOSE_FAILED',
        currentR,
        'CLOSE_DEMO',
        true,
        response,
      );
    }
  }

  private async persistObservation(
    row: CandidateRow,
    probability: number | null,
    state: GuardState,
    reason: string,
    currentR: number | null,
    action: GuardAction,
    modifiesExecution: boolean,
    sourceResponse: PlanBV85BrokerCheckpointResponse,
  ): Promise<void> {
    const checkpointAt = new Date(
      new Date(row.opened_at).getTime() +
        PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES * 60_000,
    );
    const response = {
      artifact: PLAN_B_V89_DEMO_DRAWDOWN_GUARD_ARTIFACT,
      mode: 'DEMO_EXECUTION_GUARD',
      checkpoint_minutes: PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES,
      checkpoint_at: checkpointAt.toISOString(),
      guard_threshold_r: PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R,
      current_r: currentR,
      action,
      state,
      reason,
      source_artifact: sourceResponse.score?.artifact ?? null,
      source_probability: probability,
      source_state: sourceResponse.state,
      source_reason: sourceResponse.reason ?? null,
      execution_authority: 'DEMO_ONLY',
      modifies_execution: modifiesExecution,
      live_eligible: false,
    };

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
          $1,$2,$3,$4,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12,false,$13,$14::jsonb,$15::jsonb,'DEMO_ONLY',$16,now()
        )
        ON CONFLICT (trade_id, artifact, checkpoint_minutes)
        DO UPDATE SET
          evaluated_at = now(),
          state = EXCLUDED.state,
          reason = EXCLUDED.reason,
          probability = EXCLUDED.probability,
          threshold = EXCLUDED.threshold,
          current_r = EXCLUDED.current_r,
          eligible_profit_state = false,
          action = EXCLUDED.action,
          market_data_sources = EXCLUDED.market_data_sources,
          response = EXCLUDED.response,
          execution_authority = 'DEMO_ONLY',
          modifies_execution = EXCLUDED.modifies_execution,
          updated_at = now()
      `,
      [
        row.user_id,
        row.trade_id,
        row.trade_intent_id,
        row.execution_broker_connection_id,
        PLAN_B_V89_DEMO_DRAWDOWN_GUARD_ARTIFACT,
        PLAN_B_V89_DEMO_DRAWDOWN_CHECKPOINT_MINUTES,
        checkpointAt.toISOString(),
        state,
        reason,
        probability,
        PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R,
        currentR,
        action,
        JSON.stringify(sourceResponse.market_data_sources ?? null),
        JSON.stringify(response),
        modifiesExecution,
      ],
    );
  }
}
