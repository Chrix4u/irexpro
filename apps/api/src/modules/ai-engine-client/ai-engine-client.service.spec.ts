import { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import { AiEngineClient } from './ai-engine-client.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
// Production-LIVE completion round (P13 metrics): the real in-process registry
// handed through the client's OPTIONAL trailing ModuleRef seam.
import { MetricsService } from '../metrics/metrics.service';
import { METRIC_GAUGE_NAMES } from '../metrics/metric-names';

describe('AiEngineClient', () => {
  let client: AiEngineClient;
  let configService: jest.Mocked<Partial<ConfigService>>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'aiEngine.schedulerEnabled') return true;
        if (key === 'aiEngine.baseUrl') return 'http://localhost:8001/api/v1';
        if (key === 'internalApi.key') return 'test-internal-key';
        return undefined;
      }),
    };
    client = new AiEngineClient(configService as unknown as ConfigService);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        registered: true,
        trading_session_id: 'session-1',
        message: 'Session scheduler registered',
      }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('scheduler integration is disabled by default in config schema', () => {
    const disabledConfig = {
      get: jest.fn().mockReturnValue(false),
    };
    const disabledClient = new AiEngineClient(disabledConfig as unknown as ConfigService);
    expect(disabledClient.isSchedulerIntegrationEnabled()).toBe(false);
  });

  it('notifySessionStarted posts to AI engine when enabled', async () => {
    await client.notifySessionStarted({
      userId: 'user-1',
      tradingSessionId: 'session-1',
      brokerConnectionId: 'conn-1',
      instruments: ['EURUSD'],
      timeframe: 'H1',
      source: 'broker',
      mode: ExecutionMode.PAPER_ONLY,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/scheduler/sessions/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-irexpro-internal-api-key': 'test-internal-key',
        }),
      }),
    );
  });

  it('notifySessionStopped posts to AI engine when enabled', async () => {
    await client.notifySessionStopped({ tradingSessionId: 'session-1' });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/scheduler/sessions/stop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reads scheduler runtime status when enabled', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        enabled: true,
        registered: true,
        trading_session_id: 'session-1',
        active: true,
        instruments: ['EURUSD'],
        timeframe: 'H1',
        interval_seconds: 60,
        source: 'broker',
        last_run_at: null,
        next_run_at: '2026-09-19T11:30:00.000Z',
        last_decision: null,
        last_reason: null,
        last_confidence_score: null,
        confidence_threshold: 0.6,
        last_publish_failed: false,
      }),
    });

    const status = await client.getSessionStatus('session-1');

    expect(status.registered).toBe(true);
    expect(status.active).toBe(true);
    expect(status.confidence_threshold).toBe(0.6);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8001/api/v1/scheduler/sessions/status',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails closed when the internal API key is missing', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'aiEngine.schedulerEnabled') return true;
      if (key === 'aiEngine.baseUrl') return 'http://localhost:8001/api/v1';
      if (key === 'internalApi.key') return undefined;
      return undefined;
    });

    await expect(client.getSessionStatus('session-1')).rejects.toThrow(
      'AI engine internal API key is not configured',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips notification when scheduler integration is disabled', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'aiEngine.schedulerEnabled') return false;
      return undefined;
    });

    await client.notifySessionStarted({
      userId: 'user-1',
      tradingSessionId: 'session-1',
      brokerConnectionId: 'conn-1',
      instruments: ['EURUSD'],
      timeframe: 'H1',
      source: 'broker',
      mode: ExecutionMode.PAPER_ONLY,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ─── P13 metrics: AI model version/mode info gauge ────────────────────────

  describe('P13 irexpro_ai_model_info gauge (existing status-refresh path)', () => {
    let metrics: MetricsService;
    let metricsClient: AiEngineClient;

    const modelInfoSeries = () =>
      metrics.snapshot().gauges.filter((s) => s.name === METRIC_GAUGE_NAMES.AI_MODEL_INFO);

    beforeEach(() => {
      metrics = new MetricsService();
      metrics.reset();
      metricsClient = new AiEngineClient(
        configService as unknown as ConfigService,
        { get: () => metrics } as unknown as ModuleRef,
      );
    });

    it('a successful session-status read sets the model info gauge (value 1, version+mode labels)', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          enabled: true,
          registered: true,
          trading_session_id: 'session-1',
          model_version: 'baseline_xgboost_v1.2.3',
          model_mode: 'paper',
        }),
      });

      await metricsClient.getSessionStatus('session-1');

      expect(modelInfoSeries()).toHaveLength(1);
      expect(modelInfoSeries()[0].value).toBe(1);
      // Dots are outside the label whitelist [a-zA-Z0-9_:-] — the metrics
      // sanitizer replaces them with '_' (never throws, never drops the
      // series).
      expect(modelInfoSeries()[0].labels).toEqual({
        model_version: 'baseline_xgboost_v1_2_3',
        model_mode: 'paper',
      });
    });

    it('a model promotion REPLACES the stale label series (no phantom old version)', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({
            enabled: true,
            registered: true,
            model_version: 'baseline_xgboost_v1.2.3',
            model_mode: 'paper',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({
            enabled: true,
            registered: true,
            model_version: 'baseline_xgboost_v2.0.0',
            model_mode: 'paper',
          }),
        });

      await metricsClient.getSessionStatus('session-1');
      await metricsClient.getSessionStatus('session-1');

      expect(modelInfoSeries()).toHaveLength(1);
      expect(modelInfoSeries()[0].labels.model_version).toBe('baseline_xgboost_v2_0_0');
    });

    it('a NULL model version is an honest unknown — never a fabricated version', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          enabled: true,
          registered: true,
          model_version: null,
          model_mode: null,
        }),
      });

      await metricsClient.getSessionStatus('session-1');

      expect(modelInfoSeries()).toHaveLength(1);
      expect(modelInfoSeries()[0].labels).toEqual({
        model_version: 'unknown',
        model_mode: 'unknown',
      });
    });

    it('the DISABLED fast path (no network call) never touches the gauge', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'aiEngine.schedulerEnabled') return false;
        return undefined;
      });

      await metricsClient.getSessionStatus('session-1');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(modelInfoSeries()).toEqual([]);
    });

    it('a failed status read never sets the gauge (no fabricated model info)', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: jest.fn(),
      });

      await expect(metricsClient.getSessionStatus('session-1')).rejects.toThrow(
        'AI engine returned HTTP 503',
      );
      expect(modelInfoSeries()).toEqual([]);
    });

    it('without the optional ModuleRef the client still works and records nothing', async () => {
      const bareClient = new AiEngineClient(configService as unknown as ConfigService);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          enabled: true,
          registered: true,
          model_version: 'v1',
          model_mode: 'paper',
        }),
      });

      const status = await bareClient.getSessionStatus('session-1');

      expect(status.model_version).toBe('v1');
      expect(metrics.snapshot().gauges).toEqual([]);
    });
  });
});
