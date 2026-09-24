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
        qualified_signals_published_total: 0,
        uat_probe_signals_published_total: 0,
        last_strategy_outcome: null,
        last_strategy_reason: null,
        last_trade_id: null,
        executions_succeeded_total: 0,
        qualified_executions_succeeded_total: 0,
        uat_probe_executions_succeeded_total: 0,
        downstream_rejected_total: 0,
        qualified_downstream_rejected_total: 0,
        uat_probe_downstream_rejected_total: 0,
      };
    }

    const url = `${this.getBaseUrl()}/scheduler/sessions/status`;
    return this.post<AiSchedulerSessionStatus>(url, { tradingSessionId }, tradingSessionId);
  }

  private async post<T>(url: string, body: Record<string, unknown>, sessionId: string): Promise<T> {
    const apiKey = this.getInternalApiKey();
    if (!apiKey) {
      this.logger.warn(
        `AI engine notification skipped — internal API key not configured session=${sessionId}`,
      );
      throw new Error('AI engine internal API key is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
