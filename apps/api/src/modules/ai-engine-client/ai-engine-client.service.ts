import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiSchedulerSessionRegistration,
  AiSchedulerSessionStartPayload,
  AiSchedulerSessionStatus,
  AiSchedulerSessionStopPayload,
} from './interfaces/ai-scheduler.interface';

const INTERNAL_API_KEY_HEADER = 'x-irexpro-internal-api-key';
const REQUEST_TIMEOUT_MS = 5000;

export interface PlanBV4ChallengerStatus {
  artifact: string;
  mode: 'PROSPECTIVE_SHADOW_ONLY';
  configured: boolean;
  loaded: boolean;
  load_error: string | null;
  manifest_path: string | null;
  feature_count: number;
  frozen_consensus: {
    opp_floor: number;
    margin_floor: number;
    votes_required: number;
  } | null;
  qualification_cutoff: string | null;
  sealed_future_holdout_touched: boolean | null;
  historical_validation: {
    n: number | null;
    profit_factor: number | null;
    sharpe: number | null;
    balanced_accuracy: number | null;
    max_drawdown: number | null;
    positive_fold_fraction: number | null;
    positive_instrument_fraction: number | null;
    median_gap_minutes: number | null;
  };
  execution_authority: 'NONE';
  paper_promotion_eligible: false;
}

export interface PlanBV4BrokerScore {
  artifact: string;
  mode: 'PROSPECTIVE_SHADOW_ONLY';
  modifies_execution: false;
  instrument: string;
  direction: 'BUY' | 'SELL';
  admitted: boolean;
  ensemble_confidence: number;
  mean_opportunity_probability: number;
  mean_direction_confidence: number;
  long_votes: number;
  short_votes: number;
  vote_margin: number;
  votes_required: number;
  opportunity_floor: number;
  regime: string;
  paper_promotion_eligible: false;
}

export interface PlanBV4BrokerScoreResponse {
  state: 'READY' | 'WAITING_FOR_BROKER_DATA' | 'ERROR';
  reason: string | null;
  status: PlanBV4ChallengerStatus;
  decision_time?: string | null;
  market_data_sources?: Record<string, string> | null;
  score?: PlanBV4BrokerScore | null;
}

export interface AiActiveModelMetadata {
  version?: string;
  mode?: string;
  loaded?: boolean;
  validation_status?: string;
  research_gate?: {
    thresholds?: Record<string, number>;
    observed?: Record<string, number>;
    checks?: Record<string, boolean>;
    research_gate_passed?: boolean;
  } | null;
}

/**
 * AiEngineClient — HTTP client for NestJS → Python AI engine coordination.
 *
 * Used to notify the AI engine when trading sessions start/stop so scheduled
 * paper-mode signal generation can be registered/unregistered.
 *
 * Failures are logged but never block trading session lifecycle.
 */
@Injectable()
export class AiEngineClient {
  private readonly logger = new Logger(AiEngineClient.name);

  constructor(private readonly configService: ConfigService) {}

  isSchedulerIntegrationEnabled(): boolean {
    return this.configService.get<boolean>('aiEngine.schedulerEnabled', false);
  }

  private getBaseUrl(): string {
    return this.configService.get<string>('aiEngine.baseUrl', 'http://localhost:8001/api/v1');
  }

  private getInternalApiKey(): string | undefined {
    return this.configService.get<string>('internalApi.key');
  }

  async notifySessionStarted(
    payload: AiSchedulerSessionStartPayload,
  ): Promise<AiSchedulerSessionRegistration | null> {
    if (!this.isSchedulerIntegrationEnabled()) return null;

    const url = `${this.getBaseUrl()}/scheduler/sessions/start`;
    return this.post<AiSchedulerSessionRegistration>(url, { ...payload }, payload.tradingSessionId);
  }

  async notifySessionStopped(
    payload: AiSchedulerSessionStopPayload,
  ): Promise<AiSchedulerSessionRegistration | null> {
    if (!this.isSchedulerIntegrationEnabled()) return null;

    const url = `${this.getBaseUrl()}/scheduler/sessions/stop`;
    return this.post<AiSchedulerSessionRegistration>(url, { ...payload }, payload.tradingSessionId);
  }

  async getSessionStatus(tradingSessionId: string): Promise<AiSchedulerSessionStatus> {
    if (!this.isSchedulerIntegrationEnabled()) {
      return {
        enabled: false,
        registered: false,
        trading_session_id: tradingSessionId,
        active: false,
        instruments: [],
        timeframe: null,
        interval_seconds: null,
        source: null,
        last_run_at: null,
        next_run_at: null,
        last_decision: null,
        last_reason: 'scheduler_integration_disabled',
        last_confidence_score: null,
        last_confidence_at: null,
        confidence_threshold: null,
        model_version: null,
        model_mode: null,
        model_loaded: null,
        last_market_data_at: null,
        market_data_age_seconds: null,
        market_data_cache_bypassed: false,
        last_publish_failed: false,
        research_uat: false,
        replay_steps_per_cycle: 1,
        replay_steps_last_cycle: 0,
        replay_steps_total: 0,
        signals_published_total: 0,
        last_strategy_outcome: null,
        last_strategy_reason: null,
        last_trade_id: null,
        executions_succeeded_total: 0,
        downstream_rejected_total: 0,
      };
    }

    const url = `${this.getBaseUrl()}/scheduler/sessions/status`;
    return this.post<AiSchedulerSessionStatus>(url, { tradingSessionId }, tradingSessionId);
  }

  async getActiveModelMetadata(): Promise<AiActiveModelMetadata> {
    const url = `${this.getBaseUrl()}/models/active`;
    return this.get<AiActiveModelMetadata>(url, 'active-model');
  }

  async getPlanBV4ChallengerStatus(): Promise<PlanBV4ChallengerStatus> {
    const url = `${this.getBaseUrl()}/models/challengers/plan-b-v4/status`;
    return this.get<PlanBV4ChallengerStatus>(url, 'plan-b-v4-challenger');
  }

  async scorePlanBV4ChallengerBroker(payload: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
  }): Promise<PlanBV4BrokerScoreResponse> {
    const url = `${this.getBaseUrl()}/models/challengers/plan-b-v4/score-broker`;
    return this.post<PlanBV4BrokerScoreResponse>(
      url,
      {
        user_id: payload.userId,
        broker_connection_id: payload.brokerConnectionId,
        instrument: payload.instrument,
      },
      `plan-b-v4:${payload.instrument}`,
      30_000,
    );
  }

  private async get<T>(url: string, context: string): Promise<T> {
    const apiKey = this.getInternalApiKey();
    if (!apiKey) {
      throw new Error('AI engine internal API key is not configured');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          [INTERNAL_API_KEY_HEADER]: apiKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`AI engine returned HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (err) {
      this.logger.warn(
        `AI engine model metadata error context=${context}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(
    url: string,
    body: Record<string, unknown>,
    sessionId: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const apiKey = this.getInternalApiKey();
    if (!apiKey) {
      this.logger.warn(
        `AI engine notification skipped — internal API key not configured session=${sessionId}`,
      );
      throw new Error('AI engine internal API key is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [INTERNAL_API_KEY_HEADER]: apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `AI engine notification failed session=${sessionId} status=${response.status}`,
        );
        throw new Error(`AI engine returned HTTP ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (err) {
      this.logger.warn(
        `AI engine notification error session=${sessionId}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
