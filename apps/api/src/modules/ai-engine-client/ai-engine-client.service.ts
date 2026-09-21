import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import {
  AiSchedulerSessionRegistration,
  AiSchedulerSessionStartPayload,
  AiSchedulerSessionStatus,
  AiSchedulerSessionStopPayload,
} from './interfaces/ai-scheduler.interface';
// Production-LIVE completion round (P13 metrics): dependency-free in-process
// info gauge (lazy ModuleRef seam — same pattern as risk.service).
import { MetricsService } from '../metrics/metrics.service';
import { METRIC_GAUGE_NAMES } from '../metrics/metric-names';

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

  constructor(
    private readonly configService: ConfigService,
    /**
     * Production-LIVE completion round (P13 metrics): lazy metrics seam —
     * OPTIONAL trailing dependency (direct spec constructions keep
     * compiling). Resolved at CALL time via ModuleRef.get(...,
     * { strict: false }); when absent every `this.metrics?…` call site
     * no-ops — metrics can never break session coordination.
     */
    private readonly moduleRef?: ModuleRef,
  ) {}

  /** Lazy MetricsService lookup (never throws, never affects control flow). */
  private get metrics(): MetricsService | null {
    try {
      return this.moduleRef?.get(MetricsService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

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
      };
    }

    const url = `${this.getBaseUrl()}/scheduler/sessions/status`;
    const status = await this.post<AiSchedulerSessionStatus>(
      url,
      { tradingSessionId },
      tradingSessionId,
    );

    // Production-LIVE completion round (P13 metrics): the AI engine's active
    // model version/mode as an info-style gauge. This instruments the
    // EXISTING status-refresh path — the client deliberately makes NO network
    // call per /metrics scrape (the gauge is absent until the first session
    // status read after a process restart, and goes absent with the process).
    // removeGauge-then-set drops stale label series when the engine promotes
    // or rolls back a model. Missing values collapse to '_' via the metrics
    // label sanitizer — an honest "unknown", never a fabricated version.
    this.metrics?.removeGauge(METRIC_GAUGE_NAMES.AI_MODEL_INFO);
    this.metrics?.setGauge(METRIC_GAUGE_NAMES.AI_MODEL_INFO, 1, {
      model_version: status.model_version ?? 'unknown',
      model_mode: status.model_mode ?? 'unknown',
    });

    return status;
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
