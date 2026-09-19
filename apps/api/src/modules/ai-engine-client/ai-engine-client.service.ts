import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiSchedulerRegistrationResponse,
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

  getSchedulerUniverse(): {
    instruments: string[];
    timeframes: string[];
    intervalSeconds: number;
  } {
    const instruments = this.configService.get<string[]>('aiEngine.instruments', ['EURUSD']);
    const timeframes = this.configService.get<string[]>('aiEngine.timeframes', ['H1']);
    const intervalSeconds = this.configService.get<number>('aiEngine.signalIntervalSeconds', 60);
    return {
      instruments: instruments.length ? instruments : ['EURUSD'],
      timeframes: timeframes.length ? timeframes : ['H1'],
      intervalSeconds,
    };
  }

  async notifySessionStarted(
    payload: AiSchedulerSessionStartPayload,
  ): Promise<AiSchedulerRegistrationResponse | null> {
    if (!this.isSchedulerIntegrationEnabled()) return null;

    const url = `${this.getBaseUrl()}/scheduler/sessions/start`;
    return this.requestJson<AiSchedulerRegistrationResponse>(
      url,
      { method: 'POST', body: { ...payload } },
      payload.tradingSessionId,
    );
  }

  async notifySessionStopped(
    payload: AiSchedulerSessionStopPayload,
  ): Promise<AiSchedulerRegistrationResponse | null> {
    if (!this.isSchedulerIntegrationEnabled()) return null;

    const url = `${this.getBaseUrl()}/scheduler/sessions/stop`;
    return this.requestJson<AiSchedulerRegistrationResponse>(
      url,
      { method: 'POST', body: { ...payload } },
      payload.tradingSessionId,
    );
  }

  async getSessionStatus(tradingSessionId: string): Promise<AiSchedulerSessionStatus> {
    if (!this.isSchedulerIntegrationEnabled()) {
      return {
        scheduler_enabled: false,
        scheduler_running: false,
        registered: false,
        active_model_version: null,
        approved_for_live: null,
        job: null,
      };
    }

    const url =
      `${this.getBaseUrl()}/scheduler/sessions/${encodeURIComponent(tradingSessionId)}`;
    return this.requestJson<AiSchedulerSessionStatus>(
      url,
      { method: 'GET' },
      tradingSessionId,
    );
  }

  private async requestJson<T>(
    url: string,
    request: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
    sessionId: string,
  ): Promise<T> {
    const apiKey = this.getInternalApiKey();
    if (!apiKey) {
      this.logger.warn(
        `AI engine request blocked — internal API key not configured session=${sessionId}`,
      );
      throw new Error('AI engine internal API key is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [INTERNAL_API_KEY_HEADER]: apiKey,
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `AI engine request failed session=${sessionId} status=${response.status}`,
        );
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
