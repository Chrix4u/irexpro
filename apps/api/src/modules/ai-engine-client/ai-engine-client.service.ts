import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import {
  AiActiveModelStatus,
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

  /**
   * October UAT hardening (WS3): the ACTIVE model truth from the AI runtime —
   * exact identity (version + artifact SHA-256), paper/live approval states
   * and the engine-side live env gate. Read-through (never cached): the
   * engine re-validates the promotion records on every call.
   *
   * Throws when the engine is unreachable or the payload is malformed — the
   * LIVE model-approval gate treats that as fail-closed (truth cannot be
   * established).
   */
  async getActiveModelStatus(): Promise<AiActiveModelStatus> {
    const url = `${this.getBaseUrl()}/models/active`;
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
        this.logger.warn(`AI engine active-model read failed status=${response.status}`);
        throw new Error(`AI engine returned HTTP ${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      return this.coerceActiveModelStatus(payload);
    } catch (err) {
      this.logger.warn(`AI engine active-model read error: ${(err as Error).message}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Defensive narrowing of the engine payload — an unexpected shape collapses
   * to honest nulls (never a fabricated identity/approval).
   */
  private coerceActiveModelStatus(payload: Record<string, unknown>): AiActiveModelStatus {
    const activation = payload.live_activation;
    const isActivation =
      typeof activation === 'object' && activation !== null
        ? (activation as Record<string, unknown>)
        : null;
    return {
      version: typeof payload.version === 'string' ? payload.version : null,
      mode: typeof payload.mode === 'string' ? payload.mode : null,
      loaded: typeof payload.loaded === 'boolean' ? payload.loaded : null,
      artifact_sha256: typeof payload.artifact_sha256 === 'string' ? payload.artifact_sha256 : null,
      approved_for_paper:
        typeof payload.approved_for_paper === 'boolean' ? payload.approved_for_paper : null,
      approved_for_live:
        typeof payload.approved_for_live === 'boolean' ? payload.approved_for_live : null,
      live_activation: isActivation
        ? {
            activated: isActivation.activated === true,
            record_id: typeof isActivation.record_id === 'string' ? isActivation.record_id : null,
            model_version:
              typeof isActivation.model_version === 'string' ? isActivation.model_version : null,
            artifact_sha256:
              typeof isActivation.artifact_sha256 === 'string'
                ? isActivation.artifact_sha256
                : null,
            promoted_by:
              typeof isActivation.promoted_by === 'string' ? isActivation.promoted_by : null,
            approved_by:
              typeof isActivation.approved_by === 'string' ? isActivation.approved_by : null,
            activated_at:
              typeof isActivation.activated_at === 'string' ? isActivation.activated_at : null,
            reason: typeof isActivation.reason === 'string' ? isActivation.reason : null,
          }
        : null,
      live_signal_mode_enabled:
        typeof payload.live_signal_mode_enabled === 'boolean'
          ? payload.live_signal_mode_enabled
          : null,
    };
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
